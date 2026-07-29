/**
 * RaceTracker — Tracks a live accuracy race between MetaCombiner, CrisisAI,
 * and the Ensemble Vote.
 *
 * Rules:
 *   - Race activates after hand #15 (based on how many times scoreHand() is called)
 *   - CrisisAI is scored on backgroundPrediction (always computed, even when inactive)
 *   - WAIT / null predictions are abstentions: no point gained or lost
 *   - Champion = the panel currently holding the gold award
 *   - Champion keeps award unless they make a WRONG prediction
 *   - When champion loses: new champion = highest rolling accuracy among correct predictors
 *   - When multiple panels agree on the same side and win: highest accuracy among them wins
 *   - Rolling accuracy = last 10 non-abstain hands (null if < 3 hands)
 *   - Challenger badge: non-champion is within 5% rolling accuracy of champion
 */

type Side = "B" | "P";
export type ContestantKey = "metaCombiner" | "crisisAI" | "ensemble";

// ── Internal per-contestant state ─────────────────────────────────────────────

interface ContestantStats {
  totalPreds: number;
  correctPreds: number;
  recent: number[];          // last 10 non-abstain: 1=correct, 0=wrong
  winStreak: number;         // current consecutive correct predictions
}

const emptyContestant = (): ContestantStats => ({
  totalPreds: 0,
  correctPreds: 0,
  recent: [],
  winStreak: 0,
});

// ── Public types ──────────────────────────────────────────────────────────────

export interface RaceContestantResult {
  /** Current hand's pending prediction (before outcome). null = abstain */
  prediction: Side | null;
  totalPreds: number;
  correctPreds: number;
  /** Rolling 10-hand accuracy 0-1, or null if fewer than 3 non-abstain hands */
  rollingAccuracy: number | null;
  /** Current consecutive win streak */
  winStreak: number;
}

export interface RaceState {
  /** True once at least 15 hands have been processed */
  active: boolean;
  /** Who holds the gold award right now */
  champion: ContestantKey | null;
  /** How many consecutive correct predictions the current champion has */
  championStreak: number;
  /** True when 2-3 panels agree on the same non-null side this hand */
  allAgree: boolean;
  /** The side all agreeing panels are pointing to, or null */
  agreeSide: Side | null;
  metaCombiner: RaceContestantResult;
  crisisAI: RaceContestantResult;
  ensemble: RaceContestantResult;
}

// ── Undo snapshot ─────────────────────────────────────────────────────────────

interface UndoEntry {
  champion: ContestantKey | null;
  championStreak: number;
  totalHands: number;
  contestants: Record<ContestantKey, ContestantStats>;
  pending: Record<ContestantKey, Side | null>;
}

// ── RaceTracker ───────────────────────────────────────────────────────────────

const MIN_HANDS = 15;
const RECENT_WINDOW = 10;
const MIN_HANDS_FOR_ACC = 3;
const CHALLENGER_MARGIN = 0.05;

export class RaceTracker {
  private contestants: Record<ContestantKey, ContestantStats> = {
    metaCombiner: emptyContestant(),
    crisisAI: emptyContestant(),
    ensemble: emptyContestant(),
  };
  private champion: ContestantKey | null = null;
  private championStreak = 0;
  private totalHands = 0; // incremented in scoreHand(), drives active flag
  private pending: Record<ContestantKey, Side | null> = {
    metaCombiner: null,
    crisisAI: null,
    ensemble: null,
  };
  private undoStack: UndoEntry[] = [];

  // ── Helpers ──────────────────────────────────────────────────────────────

  private rollingAcc(c: ContestantStats): number | null {
    if (c.recent.length < MIN_HANDS_FOR_ACC) return null;
    return c.recent.reduce((a, b) => a + b, 0) / c.recent.length;
  }

  private effectiveAcc(key: ContestantKey): number {
    const c = this.contestants[key];
    const ra = this.rollingAcc(c);
    if (ra !== null) return ra;
    // Fallback: cumulative, with a Laplace-style prior so cold starters don't dominate
    return (c.correctPreds + 0.5) / (c.totalPreds + 1);
  }

  private toResult(key: ContestantKey): RaceContestantResult {
    const c = this.contestants[key];
    return {
      prediction: this.pending[key],
      totalPreds: c.totalPreds,
      correctPreds: c.correctPreds,
      rollingAccuracy: this.rollingAcc(c),
      winStreak: c.winStreak,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Capture the current hand's predictions (before the outcome is known).
   * Call at the end of _captureNewPredictions() after all engines have run.
   *
   * @param mc      MetaCombiner prediction (null for WAIT)
   * @param crisis  CrisisAI backgroundPrediction (always non-null when computed)
   * @param ensemble Regime ensemble verdict (null when split/no data)
   */
  capturePredictions(
    mc: Side | null,
    crisis: Side | null,
    ensemble: Side | null
  ): void {
    this.pending = { metaCombiner: mc, crisisAI: crisis, ensemble: ensemble };
  }

  /**
   * Score the previous hand's predictions against the actual outcome.
   * Call in handleInput() after engines are scored but before _captureNewPredictions().
   * Always call this (even on Tie) so totalHands stays in sync.
   *
   * @param actual null for Tie — nobody scored, but hand count increments
   */
  scoreHand(actual: Side | null): void {
    this.totalHands++;
    if (!actual || this.totalHands < MIN_HANDS) return;

    const KEYS: ContestantKey[] = ["metaCombiner", "crisisAI", "ensemble"];
    const correctOnes: ContestantKey[] = [];

    // Score each contestant
    for (const key of KEYS) {
      const pred = this.pending[key];
      if (pred === null) continue; // abstain

      const c = this.contestants[key];
      const isCorrect = pred === actual;
      c.totalPreds++;
      if (isCorrect) c.correctPreds++;
      c.recent.push(isCorrect ? 1 : 0);
      if (c.recent.length > RECENT_WINDOW) c.recent.shift();

      if (isCorrect) {
        c.winStreak++;
        correctOnes.push(key);
      } else {
        c.winStreak = 0;
      }
    }

    // Champion update logic
    const champPred = this.champion ? this.pending[this.champion] : null;
    const champWasWrong = this.champion !== null
      && champPred !== null
      && champPred !== actual;

    if (champWasWrong) {
      // Champion predicted wrong → lose the title
      this.champion = null;
      this.championStreak = 0;
    }

    if (correctOnes.length === 0) {
      // Nobody was correct this hand → race stays as-is (champion keeps if they abstained)
      return;
    }

    if (this.champion !== null && correctOnes.includes(this.champion)) {
      // Current champion predicted correctly → keep title, increment streak
      this.championStreak++;
    } else if (this.champion === null) {
      // No champion → highest effective accuracy among correct predictors is crowned
      let bestKey: ContestantKey | null = null;
      let bestAcc = -1;
      for (const key of correctOnes) {
        const acc = this.effectiveAcc(key);
        if (acc > bestAcc) {
          bestAcc = acc;
          bestKey = key;
        }
      }
      if (bestKey) {
        this.champion = bestKey;
        this.championStreak = this.contestants[bestKey].winStreak;
      }
    }
    // else: champion abstained and others were correct — champion keeps the title
  }

  /** Save state for undo. Call at the start of handleInput(). */
  saveState(): void {
    this.undoStack.push({
      champion: this.champion,
      championStreak: this.championStreak,
      totalHands: this.totalHands,
      contestants: {
        metaCombiner: { ...this.contestants.metaCombiner, recent: [...this.contestants.metaCombiner.recent] },
        crisisAI: { ...this.contestants.crisisAI, recent: [...this.contestants.crisisAI.recent] },
        ensemble: { ...this.contestants.ensemble, recent: [...this.contestants.ensemble.recent] },
      },
      pending: { ...this.pending },
    });
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  /** Restore state for undo. */
  undoLast(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.champion = prev.champion;
    this.championStreak = prev.championStreak;
    this.totalHands = prev.totalHands;
    this.contestants = {
      metaCombiner: { ...prev.contestants.metaCombiner, recent: [...prev.contestants.metaCombiner.recent] },
      crisisAI: { ...prev.contestants.crisisAI, recent: [...prev.contestants.crisisAI.recent] },
      ensemble: { ...prev.contestants.ensemble, recent: [...prev.contestants.ensemble.recent] },
    };
    this.pending = { ...prev.pending };
  }

  reset(): void {
    this.contestants = {
      metaCombiner: emptyContestant(),
      crisisAI: emptyContestant(),
      ensemble: emptyContestant(),
    };
    this.champion = null;
    this.championStreak = 0;
    this.totalHands = 0;
    this.pending = { metaCombiner: null, crisisAI: null, ensemble: null };
    this.undoStack = [];
  }

  getState(): RaceState {
    const active = this.totalHands >= MIN_HANDS;

    // Compute allAgree: 2+ non-null predictions on the same side
    const nonNull = (Object.entries(this.pending) as [ContestantKey, Side | null][])
      .filter(([, v]) => v !== null)
      .map(([, v]) => v as Side);
    const unique = [...new Set(nonNull)];
    const allAgree = nonNull.length >= 2 && unique.length === 1;
    const agreeSide = allAgree ? unique[0] : null;

    return {
      active,
      champion: this.champion,
      championStreak: this.championStreak,
      allAgree,
      agreeSide,
      metaCombiner: this.toResult("metaCombiner"),
      crisisAI: this.toResult("crisisAI"),
      ensemble: this.toResult("ensemble"),
    };
  }

  /** Challenger check: is `key` within CHALLENGER_MARGIN of the champion's rolling accuracy? */
  isChallenger(key: ContestantKey): boolean {
    if (!this.champion || key === this.champion) return false;
    const champAcc = this.rollingAcc(this.contestants[this.champion]);
    const myAcc = this.rollingAcc(this.contestants[key]);
    if (champAcc === null || myAcc === null) return false;
    return (champAcc - myAcc) <= CHALLENGER_MARGIN && myAcc > 0;
  }
}
