/**
 * Meta Regime Switch Tracker — 10-expert ensemble with Option C composite scoring.
 *
 * Option C = Bayesian-adjusted base rate (50%) + Momentum (25%) + Hot-streak bonus (25%).
 *
 * Experts tracked (10 total):
 *   Core 6: supreme, syndicate, lookAhead, legacyLookAhead, metaAI, observer
 *   Road 4:  bebRoad, smallRoad, cockroachRoad, dualAuth
 *
 * Road experts abstain (null pred) when their signal is WAIT/NEUTRAL.
 *
 * Lock system enhancements:
 *   • Shadow tracking — during lock, always show the live leader + "N hands left"
 *   • Accelerated unlock — if locked expert's current loss run exceeds their typical
 *     loss-run length (from streak profile), lock breaks early
 *   • Streak profile — per expert: win-run lengths, loss-run lengths, current run state
 */

import type { B2BAlert } from "./syndicate.js";

type Side = "B" | "P";

// ── Internal state ────────────────────────────────────────────────────────────

interface ExpertHistory {
  pred: Side;
  actual: Side | null;
}

interface StreakProfile {
  winRuns: number[];         // completed consecutive-win run lengths (last 10)
  lossRuns: number[];        // completed consecutive-loss run lengths (last 10)
  currentRunLen: number;     // length of the current (ongoing) run
  currentRunIsWin: boolean | null; // true=winning run, false=losing run, null=no data
}

interface ExpertState {
  history: ExpertHistory[];
  lastPred: Side | null;
  wwr: number;          // Bayesian-adjusted weighted win rate
  rawWr: number;        // raw win rate
  predCount: number;
  totalPreds: number;   // lifetime non-null predictions (unwindowed, for participation rate)
  streak: number;       // consecutive correct picks from most recent
  hotStreak: boolean;   // streak ≥ 4
  wwrHistory: number[]; // last 4 wwr values (for momentum)
  momentum: "up" | "down" | "flat";
  sparkline: number[];  // last 8: 1=hit 0=miss
  prevWwr: number;
  wwrDelta: number;     // wwr - prevWwr
  compositeScore: number;
  streakProfile: StreakProfile;
}

export type ExpertKey =
  | "supreme" | "syndicate" | "lookAhead" | "legacyLookAhead" | "metaAI" | "observer"
  | "bebRoad" | "smallRoad" | "cockroachRoad" | "dualAuth"
  | "bot1" | "bot2" | "bot3" | "bot4" | "bot5" | "bot6"
  | "bot7" | "bot8" | "bot9" | "bot10" | "bot11";

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ExpertStats {
  predCount: number;
  wwr: number;
  rawWr: number;
  compositeScore: number;
  momentum: "up" | "down" | "flat";
  streak: number;
  hotStreak: boolean;
  sparkline: number[];
  wwrDelta: number;
  lastPred: Side | null;
  // Streak profile (for UI display)
  avgWinRun: number;
  avgLossRun: number;
  currentRunLen: number;
  currentRunIsWin: boolean | null;
}

export interface TimelineEntry {
  expert: string;
  hands: number;
}

export interface RegimeVerdict {
  status: "WARMING_UP" | "TRACKING" | "SPLIT";
  decision: Side | null;
  expert: string | null;
  confidence: "NONE" | "LOW" | "MED" | "HIGH";
  isSplit: boolean;
  gap: number;
  bothAgree: boolean;
  bothAgreeSide: Side | null;
  agreeCount: number;
  regimeAge: number;
  switchCount: number;
  justSwitched: boolean;
  isLocked: boolean;
  lockRemain: number;
  lockMax: number;
  window: number;
  volatilityIndex: number;
  // Core 6 experts
  supreme: ExpertStats;
  syndicate: ExpertStats;
  lookAhead: ExpertStats;
  legacyLookAhead: ExpertStats;
  metaAI: ExpertStats;
  observer: ExpertStats;
  // Road 4 experts
  bebRoad: ExpertStats;
  smallRoad: ExpertStats;
  cockroachRoad: ExpertStats;
  dualAuth: ExpertStats;
  // Syndicate 11 — individual strategy bots
  bot1: ExpertStats;
  bot2: ExpertStats;
  bot3: ExpertStats;
  bot4: ExpertStats;
  bot5: ExpertStats;
  bot6: ExpertStats;
  bot7: ExpertStats;
  bot8: ExpertStats;
  bot9: ExpertStats;
  bot10: ExpertStats;
  bot11: ExpertStats;
  // Ensemble
  ensembleVerdict: Side | null;
  ensemblePercent: number;
  // Timeline
  switchTimeline: TimelineEntry[];
  // Lock enhancements
  shadowLeader: string | null;       // best non-locked expert during lock
  shadowLeaderPred: Side | null;
  shadowLeaderComposite: number;
  lockAccelerated: boolean;          // accelerated unlock just fired this hand
  shadowPromoted: boolean;           // shadow leader was promoted to dominant this hand
}

interface RegimeConfig {
  baseWindow: number;
  window: number;
  minCounts: Record<ExpertKey, number>;
  decayFactor: number;
  lockHands: number;
  splitThreshold: number;
}

interface RegimeStateSnap {
  experts: Record<ExpertKey, ExpertState>;
  dominant: ExpertKey | null;
  dominantLockCount: number;
  lastDominant: ExpertKey | null;
  regimeAge: number;
  switchCount: number;
  justSwitched: boolean;
  cfg: RegimeConfig;
  switchTimeline: TimelineEntry[];
  volatilityIndex: number;
  shadowLeader: ExpertKey | null;
  lockAccelerated: boolean;
  shadowPromoted: boolean;
}

// ── Option C scoring helpers ──────────────────────────────────────────────────

function bayesianWwr(rawWr: number, n: number): number {
  if (n === 0) return 0.5;
  return (rawWr * n + 1) / (n + 2);
}

function computeComposite(exp: ExpertState): number {
  if (exp.predCount === 0) return 0;
  const bayesAdj = bayesianWwr(exp.rawWr, exp.predCount);
  const momentumScore = exp.momentum === "up" ? 1 : exp.momentum === "down" ? 0 : 0.5;
  const streakScore = Math.min(exp.streak / 8, 1);
  const hotBonus = exp.hotStreak ? 0.05 : 0;
  return Math.min(1, bayesAdj * 0.5 + momentumScore * 0.25 + streakScore * 0.25 + hotBonus);
}

function freshStreakProfile(): StreakProfile {
  return { winRuns: [], lossRuns: [], currentRunLen: 0, currentRunIsWin: null };
}

function freshExpert(): ExpertState {
  return {
    history: [],
    lastPred: null,
    wwr: 0,
    rawWr: 0,
    predCount: 0,
    totalPreds: 0,
    streak: 0,
    hotStreak: false,
    wwrHistory: [],
    momentum: "flat",
    sparkline: [],
    prevWwr: 0,
    wwrDelta: 0,
    compositeScore: 0,
    streakProfile: freshStreakProfile(),
  };
}

const ALL_KEYS: ExpertKey[] = [
  "supreme", "syndicate", "lookAhead", "legacyLookAhead", "metaAI", "observer",
  "bebRoad", "smallRoad", "cockroachRoad", "dualAuth",
  "bot1", "bot2", "bot3", "bot4", "bot5", "bot6",
  "bot7", "bot8", "bot9", "bot10", "bot11",
];

// ── Main class ────────────────────────────────────────────────────────────────

export class RegimeSwitchTracker {
  private handsPlayed = 0;   // incremented every evaluateOutcome call

  private cfg: RegimeConfig = {
    baseWindow: 12,
    window: 12,
    minCounts: {
      supreme: 6, syndicate: 4, lookAhead: 4, legacyLookAhead: 4, metaAI: 4, observer: 4,
      bebRoad: 6, smallRoad: 6, cockroachRoad: 6, dualAuth: 6,
      bot1: 3, bot2: 3, bot3: 3, bot4: 3, bot5: 3, bot6: 3,
      bot7: 3, bot8: 3, bot9: 3, bot10: 3, bot11: 3,
    },
    decayFactor: 0.88,
    lockHands: 5,
    splitThreshold: 0.06,
  };

  private experts: Record<ExpertKey, ExpertState> = {
    supreme: freshExpert(),
    syndicate: freshExpert(),
    lookAhead: freshExpert(),
    legacyLookAhead: freshExpert(),
    metaAI: freshExpert(),
    observer: freshExpert(),
    bebRoad: freshExpert(),
    smallRoad: freshExpert(),
    cockroachRoad: freshExpert(),
    dualAuth: freshExpert(),
    bot1: freshExpert(),
    bot2: freshExpert(),
    bot3: freshExpert(),
    bot4: freshExpert(),
    bot5: freshExpert(),
    bot6: freshExpert(),
    bot7: freshExpert(),
    bot8: freshExpert(),
    bot9: freshExpert(),
    bot10: freshExpert(),
    bot11: freshExpert(),
  };

  private dominant: ExpertKey | null = null;
  private dominantLockCount = 0;
  private lastDominant: ExpertKey | null = null;
  private regimeAge = 0;
  private switchCount = 0;
  private justSwitched = false;
  private switchTimeline: TimelineEntry[] = [];
  private volatilityIndex = 0;
  private _shadowLeader: ExpertKey | null = null;
  private _lockAccelerated = false;
  private _shadowPromoted = false;
  private _undoStack: RegimeStateSnap[] = [];

  // ── Undo snapshot ───────────────────────────────────────────────────────

  private _save(): void {
    this._undoStack.push({
      experts: JSON.parse(JSON.stringify(this.experts)) as Record<ExpertKey, ExpertState>,
      dominant: this.dominant,
      dominantLockCount: this.dominantLockCount,
      lastDominant: this.lastDominant,
      regimeAge: this.regimeAge,
      switchCount: this.switchCount,
      justSwitched: this.justSwitched,
      cfg: JSON.parse(JSON.stringify(this.cfg)) as RegimeConfig,
      switchTimeline: [...this.switchTimeline],
      volatilityIndex: this.volatilityIndex,
      shadowLeader: this._shadowLeader,
      lockAccelerated: this._lockAccelerated,
      shadowPromoted: this._shadowPromoted,
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  // ── Capture methods ─────────────────────────────────────────────────────

  captureSupreme(decision: Side | "WAIT" | null): void {
    const exp = this.experts.supreme;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  captureSyndicate(alert: B2BAlert): void {
    const exp = this.experts.syndicate;
    if (alert.active && !alert.hasConflict && alert.consensusSide) {
      exp.lastPred = alert.consensusSide;
      exp.history.push({ pred: exp.lastPred, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    } else {
      exp.lastPred = null;
    }
  }

  captureLookAhead(verdict: Side | null): void {
    const exp = this.experts.lookAhead;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  captureLegacyLookAhead(verdict: Side | null): void {
    const exp = this.experts.legacyLookAhead;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  captureMetaAI(decision: Side | "WAIT"): void {
    const exp = this.experts.metaAI;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  captureObserver(decision: Side | "WAIT"): void {
    const exp = this.experts.observer;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  /** BEB derived road prediction — null = abstain */
  captureBebRoad(verdict: Side | null): void {
    const exp = this.experts.bebRoad;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  /** Small Road prediction — null = abstain */
  captureSmallRoad(verdict: Side | null): void {
    const exp = this.experts.smallRoad;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  /** Cockroach Road prediction — null = abstain */
  captureCockroachRoad(verdict: Side | null): void {
    const exp = this.experts.cockroachRoad;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  /** Dual-Auth Engine (nexus+road agree) — null = abstain when signals conflict */
  captureDualAuth(verdict: Side | null): void {
    const exp = this.experts.dualAuth;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  /** Individual syndicate bot prediction (id 1–11). null = no prediction yet. */
  captureBot(id: number, pred: Side | null): void {
    const key = `bot${id}` as ExpertKey;
    const exp = this.experts[key];
    if (!exp) return;
    exp.lastPred = pred;
    if (pred) {
      exp.history.push({ pred, actual: null });
      exp.totalPreds++;
      this._trimHistory(exp);
    }
  }

  private _trimHistory(exp: ExpertState): void {
    if (exp.history.length > this.cfg.window + 8) exp.history.shift();
  }

  // ── Evaluate outcome ────────────────────────────────────────────────────

  evaluateOutcome(actual: Side): void {
    this._save();
    if (actual !== "P" && actual !== "B") return;
    this.handsPlayed++;

    ALL_KEYS.forEach((key) => {
      const hist = this.experts[key].history;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].actual === null) { hist[i].actual = actual; break; }
      }
    });

    this._recompute();
    this._adjustWindow();
    this._lockAccelerated = false;
    this._shadowPromoted = false;
    this._updateDominant();
  }

  // ── Recompute per-expert stats ──────────────────────────────────────────

  private _recompute(): void {
    ALL_KEYS.forEach((key) => {
      const exp = this.experts[key];
      const scored = exp.history.filter((h) => h.actual !== null).slice(-this.cfg.window);
      exp.predCount = scored.length;

      const prevWwr = exp.wwr;

      if (!scored.length) {
        exp.wwr = 0; exp.rawWr = 0;
        exp.streak = 0; exp.hotStreak = false;
        exp.sparkline = []; exp.compositeScore = 0;
        exp.wwrDelta = 0; exp.momentum = "flat";
        exp.streakProfile = freshStreakProfile();
        return;
      }

      // Weighted win rate (exponential decay, recent = heavier)
      let rH = 0;
      scored.forEach((h) => {
        if (h.pred === h.actual) rH++;
      });
      exp.rawWr = rH / scored.length;
      exp.wwr = bayesianWwr(exp.rawWr, scored.length);

      // WWR delta
      exp.prevWwr = prevWwr;
      exp.wwrDelta = exp.wwr - prevWwr;

      // WWR history → momentum arrows
      exp.wwrHistory.push(exp.wwr);
      if (exp.wwrHistory.length > 4) exp.wwrHistory.shift();
      if (exp.wwrHistory.length >= 2) {
        const diff = exp.wwrHistory[exp.wwrHistory.length - 1] - exp.wwrHistory[0];
        exp.momentum = diff > 0.015 ? "up" : diff < -0.015 ? "down" : "flat";
      }

      // Hot streak: count consecutive correct from most recent
      exp.streak = 0;
      for (let i = scored.length - 1; i >= 0; i--) {
        if (scored[i].pred === scored[i].actual) exp.streak++;
        else break;
      }
      exp.hotStreak = exp.streak >= 4;

      // Sparkline: last 8 hit/miss
      exp.sparkline = scored.slice(-8).map((h) => (h.pred === h.actual ? 1 : 0));

      // Option C composite
      exp.compositeScore = computeComposite(exp);

      // Streak profile — rebuild from scored window
      const profile = exp.streakProfile;
      const newWinRuns: number[] = [];
      const newLossRuns: number[] = [];
      let currentType: boolean | null = null;
      let runLen = 0;

      for (const h of scored) {
        const isWin = h.pred === h.actual;
        if (currentType === null) {
          currentType = isWin;
          runLen = 1;
        } else if (isWin === currentType) {
          runLen++;
        } else {
          if (currentType) newWinRuns.push(runLen);
          else newLossRuns.push(runLen);
          currentType = isWin;
          runLen = 1;
        }
      }

      profile.winRuns = newWinRuns.slice(-10);
      profile.lossRuns = newLossRuns.slice(-10);
      profile.currentRunIsWin = currentType;
      profile.currentRunLen = runLen;
    });
  }

  // ── Dynamic window ──────────────────────────────────────────────────────

  private _adjustWindow(): void {
    const recent = this.switchTimeline.slice(-6);
    if (recent.length >= 2) {
      const avgHands = recent.reduce((s, e) => s + e.hands, 0) / recent.length;
      const volatility = Math.max(0, Math.min(1, 1 - (avgHands - 2) / 12));
      this.volatilityIndex = volatility;
      if (volatility > 0.65) this.cfg.window = 8;
      else if (volatility < 0.25) this.cfg.window = Math.min(16, this.cfg.baseWindow + 4);
      else this.cfg.window = this.cfg.baseWindow;
    }
  }

  // ── Streak-based accelerated unlock ─────────────────────────────────────

  private _shouldAccelerateUnlock(key: ExpertKey): boolean {
    const exp = this.experts[key];
    const profile = exp.streakProfile;

    // Must be in an active losing run
    if (profile.currentRunIsWin !== false) return false;

    // Need at least 2 hands of data in the current loss run
    if (profile.currentRunLen < 2) return false;

    // Compute typical loss run length
    const lossRuns = profile.lossRuns;
    if (lossRuns.length === 0) {
      // No completed loss runs yet — use a default scaled by participation rate.
      // High-abstention experts (e.g. dualAuth ~30%) have fewer data points per hand,
      // so holding them to the same flat threshold as always-active experts is unfair.
      // Scale: participationRate=1.0 → threshold 3, ≤0.67 → threshold 2 (floor).
      const participationRate = this.handsPlayed > 0
        ? Math.min(1, exp.totalPreds / this.handsPlayed)
        : 1;
      const noHistoryThreshold = Math.max(2, Math.round(3 * participationRate));
      return profile.currentRunLen >= noHistoryThreshold;
    }

    const recent = lossRuns.slice(-5);
    const avgLossRun = recent.reduce((a, b) => a + b, 0) / recent.length;

    // Hard cap: 3+ consecutive losses always break the lock, regardless of history
    if (profile.currentRunLen >= 3) return true;

    // Trigger if current loss run has reached or exceeded their typical loss-run length
    return profile.currentRunLen >= Math.max(2, Math.ceil(avgLossRun));
  }

  // ── Shadow promotion check ───────────────────────────────────────────────

  /**
   * Returns true when the shadow leader should take over from the dominant:
   *   • Dominant has been losing for 3+ consecutive hands (while locked)
   *   • Shadow leader has been winning for 2+ consecutive hands
   *   • Shadow has a higher composite score than dominant
   */
  private _shouldPromoteShadow(dominantKey: ExpertKey, shadowKey: ExpertKey): boolean {
    const dom = this.experts[dominantKey];
    const shadow = this.experts[shadowKey];

    // Dominant must be on an active losing run of 3+
    if (dom.streakProfile.currentRunIsWin !== false) return false;
    if (dom.streakProfile.currentRunLen < 3) return false;

    // Shadow must be on an active winning run of 2+
    if (shadow.streakProfile.currentRunIsWin !== true) return false;
    if (shadow.streakProfile.currentRunLen < 2) return false;

    // Shadow must actually score better
    if (shadow.compositeScore <= dom.compositeScore) return false;

    return true;
  }

  // ── Shadow leader (best non-locked expert) ──────────────────────────────

  private _computeShadowLeader(): ExpertKey | null {
    if (!this.dominant) return null;
    const eligible = ALL_KEYS
      .filter((k) => k !== this.dominant && this.experts[k].predCount >= this.cfg.minCounts[k])
      .sort((a, b) => this.experts[b].compositeScore - this.experts[a].compositeScore);
    return eligible.length > 0 ? eligible[0] : null;
  }

  // ── Dominant selection ──────────────────────────────────────────────────

  private _updateDominant(): void {
    if (this.dominantLockCount > 0) {
      // Shadow leader tracking (always updated during lock)
      this._shadowLeader = this._computeShadowLeader();

      // Shadow promotion: outperforming shadow takes over immediately
      if (
        this.dominant &&
        this._shadowLeader &&
        this._shouldPromoteShadow(this.dominant, this._shadowLeader)
      ) {
        this._shadowPromoted = true;
        this._lockAccelerated = true;
        this.dominantLockCount = 0;
        // Fall through to normal evaluation — shadow will win the election
      }
      // Accelerated unlock check (hard cap at 3 consecutive losses)
      else if (this.dominant && this._shouldAccelerateUnlock(this.dominant)) {
        this._lockAccelerated = true;
        this.dominantLockCount = 0;
        // Fall through to normal evaluation
      } else {
        this.dominantLockCount--;
        this.regimeAge++;
        this.justSwitched = false;
        return;
      }
    } else {
      this._shadowLeader = null;
    }

    const eligible = ALL_KEYS
      .filter((k) => this.experts[k].predCount >= this.cfg.minCounts[k])
      .sort((a, b) => this.experts[b].compositeScore - this.experts[a].compositeScore);

    if (eligible.length === 0) {
      if (this.dominant !== null) this._setDominant(null);
      else { this.regimeAge++; this.justSwitched = false; }
      return;
    }

    let newDom: ExpertKey = eligible[0];

    if (eligible.length >= 2) {
      const gap = this.experts[eligible[0]].compositeScore - this.experts[eligible[1]].compositeScore;
      if (gap < this.cfg.splitThreshold) {
        newDom = this.dominant && eligible.includes(this.dominant) ? this.dominant : eligible[0];
      }
    }

    if (newDom !== this.dominant) {
      if (this.dominant !== null) {
        this.switchTimeline.push({ expert: this.dominant, hands: this.regimeAge });
        if (this.switchTimeline.length > 10) this.switchTimeline.shift();
      }
      this._setDominant(newDom);
    } else {
      this.regimeAge++;
      this.justSwitched = false;
    }
  }

  private _setDominant(newDom: ExpertKey | null): void {
    this.lastDominant = this.dominant;
    this.dominant = newDom;
    this.regimeAge = 0;
    this.justSwitched = this.lastDominant !== null;
    this.dominantLockCount = this.cfg.lockHands;
    if (this.lastDominant !== null) this.switchCount++;
    this._shadowLeader = null; // reset shadow on fresh lock
  }

  // ── Verdict ─────────────────────────────────────────────────────────────

  getVerdict(): RegimeVerdict {
    const dom = this.dominant;

    const expertStats: Record<ExpertKey, ExpertStats> = {} as Record<ExpertKey, ExpertStats>;
    ALL_KEYS.forEach((key) => {
      const exp = this.experts[key];
      const profile = exp.streakProfile;
      const avgWinRun = profile.winRuns.length > 0
        ? profile.winRuns.slice(-5).reduce((a, b) => a + b, 0) / Math.min(profile.winRuns.length, 5)
        : 0;
      const avgLossRun = profile.lossRuns.length > 0
        ? profile.lossRuns.slice(-5).reduce((a, b) => a + b, 0) / Math.min(profile.lossRuns.length, 5)
        : 0;
      expertStats[key] = {
        predCount: exp.predCount,
        wwr: exp.wwr,
        rawWr: exp.rawWr,
        compositeScore: exp.compositeScore,
        momentum: exp.momentum,
        streak: exp.streak,
        hotStreak: exp.hotStreak,
        sparkline: [...exp.sparkline],
        wwrDelta: exp.wwrDelta,
        lastPred: exp.lastPred,
        avgWinRun: Math.round(avgWinRun * 10) / 10,
        avgLossRun: Math.round(avgLossRun * 10) / 10,
        currentRunLen: profile.currentRunLen,
        currentRunIsWin: profile.currentRunIsWin,
      };
    });

    // ── Ensemble voting (10 experts) ────────────────────────────────────
    let scoreP = 0, scoreB = 0;
    ALL_KEYS.forEach((key) => {
      const exp = this.experts[key];
      if (exp.predCount >= this.cfg.minCounts[key] && exp.lastPred) {
        const w = Math.max(0.1, exp.compositeScore);
        if (exp.lastPred === "P") scoreP += w;
        if (exp.lastPred === "B") scoreB += w;
      }
    });
    const totalVote = scoreP + scoreB;
    let ensembleVerdict: Side | null = null;
    let ensemblePercent = 50;
    if (totalVote > 0.001) {
      if (scoreP > scoreB) {
        ensembleVerdict = "P";
        ensemblePercent = Math.round((scoreP / totalVote) * 100);
      } else if (scoreB > scoreP) {
        ensembleVerdict = "B";
        ensemblePercent = Math.round((scoreB / totalVote) * 100);
      }
    }

    // ── Agreement count ────────────────────────────────────────────────
    const voting = ALL_KEYS.filter((k) =>
      this.experts[k].predCount >= this.cfg.minCounts[k] && this.experts[k].lastPred
    );
    const agreingCount = ensembleVerdict
      ? voting.filter((k) => this.experts[k].lastPred === ensembleVerdict).length
      : 0;
    const bothAgree = voting.length >= 6 && agreingCount === voting.length;
    const bothAgreeSide: Side | null = bothAgree ? ensembleVerdict : null;

    // ── Shadow leader stats ────────────────────────────────────────────
    const shadowKey = this._shadowLeader;
    const shadowLeaderPred = shadowKey ? this.experts[shadowKey].lastPred : null;
    const shadowLeaderComposite = shadowKey ? this.experts[shadowKey].compositeScore : 0;

    const base = {
      regimeAge: this.regimeAge,
      switchCount: this.switchCount,
      isLocked: this.dominantLockCount > 0,
      lockRemain: this.dominantLockCount,
      lockMax: this.cfg.lockHands,
      justSwitched: this.justSwitched,
      window: this.cfg.window,
      volatilityIndex: this.volatilityIndex,
      ...expertStats,
      ensembleVerdict,
      ensemblePercent,
      switchTimeline: [...this.switchTimeline],
      bothAgree,
      bothAgreeSide,
      agreeCount: agreingCount,
      shadowLeader: shadowKey ?? null,
      shadowLeaderPred,
      shadowLeaderComposite,
      lockAccelerated: this._lockAccelerated,
      shadowPromoted: this._shadowPromoted,
    };

    if (!dom) {
      return {
        ...base,
        status: "WARMING_UP",
        decision: null,
        expert: null,
        confidence: "NONE",
        isSplit: false,
        gap: 0,
      };
    }

    // ── SPLIT / gap calculation ────────────────────────────────────────
    const eligible = ALL_KEYS
      .filter((k) => this.experts[k].predCount >= this.cfg.minCounts[k])
      .sort((a, b) => this.experts[b].compositeScore - this.experts[a].compositeScore);

    let isSplit = false;
    let gap = 0;
    if (eligible.length >= 2) {
      gap = this.experts[eligible[0]].compositeScore - this.experts[eligible[1]].compositeScore;
      isSplit = gap < this.cfg.splitThreshold;
    }

    let confidence: "NONE" | "LOW" | "MED" | "HIGH" = "LOW";
    if (gap >= 0.15) confidence = "HIGH";
    else if (gap >= 0.08) confidence = "MED";
    else if (gap < 0.02) confidence = "NONE";

    // ── Decision: SPLIT tiebreaker via observer ────────────────────────
    let decision: Side | null = this.experts[dom].lastPred;
    let resolvedExpert: string = dom;
    if (isSplit) {
      const obsPred = this.experts.observer.lastPred;
      if (obsPred) {
        decision = obsPred;
        resolvedExpert = `${dom}+observer`;
      }
    }

    return {
      ...base,
      status: isSplit ? "SPLIT" : "TRACKING",
      decision,
      expert: resolvedExpert,
      confidence,
      isSplit,
      gap,
    };
  }

  // ── Setters / lifecycle ─────────────────────────────────────────────────

  setWindow(n: number): void {
    this.cfg.baseWindow = n;
    this.cfg.window = n;
    this._recompute();
    this.dominantLockCount = 0;
    this._updateDominant();
  }

  undoLast(): void {
    if (this._undoStack.length === 0) return;
    const prev = this._undoStack.pop()!;
    this.experts = prev.experts;
    this.dominant = prev.dominant;
    this.dominantLockCount = prev.dominantLockCount;
    this.lastDominant = prev.lastDominant;
    this.regimeAge = prev.regimeAge;
    this.switchCount = prev.switchCount;
    this.justSwitched = prev.justSwitched;
    this.cfg = prev.cfg;
    this.switchTimeline = prev.switchTimeline;
    this.volatilityIndex = prev.volatilityIndex;
    this._shadowLeader = prev.shadowLeader;
    this._lockAccelerated = prev.lockAccelerated;
    this._shadowPromoted = prev.shadowPromoted;
  }

  reset(): void {
    this.experts = {
      supreme: freshExpert(),
      syndicate: freshExpert(),
      lookAhead: freshExpert(),
      legacyLookAhead: freshExpert(),
      metaAI: freshExpert(),
      observer: freshExpert(),
      bebRoad: freshExpert(),
      smallRoad: freshExpert(),
      cockroachRoad: freshExpert(),
      dualAuth: freshExpert(),
      bot1: freshExpert(),
      bot2: freshExpert(),
      bot3: freshExpert(),
      bot4: freshExpert(),
      bot5: freshExpert(),
      bot6: freshExpert(),
      bot7: freshExpert(),
      bot8: freshExpert(),
      bot9: freshExpert(),
      bot10: freshExpert(),
      bot11: freshExpert(),
    };
    this.dominant = null;
    this.dominantLockCount = 0;
    this.lastDominant = null;
    this.regimeAge = 0;
    this.switchCount = 0;
    this.justSwitched = false;
    this.switchTimeline = [];
    this.volatilityIndex = 0;
    this._shadowLeader = null;
    this._lockAccelerated = false;
    this._shadowPromoted = false;
    this._undoStack = [];
  }
}
