/**
 * Meta Regime Switch Tracker — 6-expert ensemble with Option C composite scoring.
 *
 * Option C = Bayesian-adjusted base rate (50%) + Momentum (25%) + Hot-streak bonus (25%).
 *
 * Experts tracked: supreme, syndicate, lookAhead, legacyLookAhead, metaAI, observer
 *
 * Additions over original:
 *   • Expert Momentum Arrows — trend over last 4 wwr values (up/down/flat)
 *   • Ensemble Voting Mode — blend all experts' predictions by compositeScore
 *   • Hot Streak Bonus — 4+ consecutive correct → compositeScore boost
 *   • Dynamic Window — shrinks (→8) during volatile shoes, expands (→16) during stable ones
 *   • Split Tiebreaker — observer breaks SPLIT ties instead of freezing
 *   • Per-Expert Sparkline — last 8 hit/miss
 *   • Regime Switch Timeline — last 10 dominant transitions with hand counts
 *   • Lock Countdown Bar — lockRemain + lockMax for progress display
 *   • WWR Delta — wwr change since last hand
 *   • Current prediction P/B pill per expert
 */

import type { B2BAlert } from "./syndicate.js";

type Side = "B" | "P";

// ── Internal state ────────────────────────────────────────────────────────────

interface ExpertHistory {
  pred: Side;
  actual: Side | null;
}

interface ExpertState {
  history: ExpertHistory[];
  lastPred: Side | null;
  wwr: number;          // Bayesian-adjusted weighted win rate
  rawWr: number;        // raw win rate
  predCount: number;
  streak: number;       // consecutive correct picks from most recent
  hotStreak: boolean;   // streak ≥ 4
  wwrHistory: number[]; // last 4 wwr values (for momentum)
  momentum: "up" | "down" | "flat";
  sparkline: number[];  // last 8: 1=hit 0=miss
  prevWwr: number;
  wwrDelta: number;     // wwr - prevWwr
  compositeScore: number;
}

export type ExpertKey = "supreme" | "syndicate" | "lookAhead" | "legacyLookAhead" | "metaAI" | "observer";

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
  // All 6 experts
  supreme: ExpertStats;
  syndicate: ExpertStats;
  lookAhead: ExpertStats;
  legacyLookAhead: ExpertStats;
  metaAI: ExpertStats;
  observer: ExpertStats;
  // Ensemble
  ensembleVerdict: Side | null;
  ensemblePercent: number; // 0–100 lean toward ensembleVerdict
  // Timeline
  switchTimeline: TimelineEntry[];
}

interface RegimeConfig {
  baseWindow: number; // user-set baseline
  window: number;     // dynamic effective window
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
}

// ── Option C scoring helpers ──────────────────────────────────────────────────

/**
 * Bayesian-adjusted win rate (Laplace / Beta(1,1) smoothing).
 * Shrinks toward 0.5 when sample count is low.
 *   4/4 → ~0.625   (not 1.0)
 *   14/20 → ~0.688
 *   0/0 → 0.5
 */
function bayesianWwr(rawWr: number, n: number): number {
  if (n === 0) return 0.5;
  return (rawWr * n + 1) / (n + 2);
}

/**
 * Option C composite: Bayesian(50%) + Momentum(25%) + StreakBonus(25%)
 * Hot streak adds a flat +5% cap bonus.
 */
function computeComposite(exp: ExpertState): number {
  if (exp.predCount === 0) return 0;
  const bayesAdj = bayesianWwr(exp.rawWr, exp.predCount);
  const momentumScore = exp.momentum === "up" ? 1 : exp.momentum === "down" ? 0 : 0.5;
  const streakScore = Math.min(exp.streak / 8, 1);
  const hotBonus = exp.hotStreak ? 0.05 : 0;
  return Math.min(1, bayesAdj * 0.5 + momentumScore * 0.25 + streakScore * 0.25 + hotBonus);
}

function freshExpert(): ExpertState {
  return {
    history: [],
    lastPred: null,
    wwr: 0,
    rawWr: 0,
    predCount: 0,
    streak: 0,
    hotStreak: false,
    wwrHistory: [],
    momentum: "flat",
    sparkline: [],
    prevWwr: 0,
    wwrDelta: 0,
    compositeScore: 0,
  };
}

const ALL_KEYS: ExpertKey[] = ["supreme", "syndicate", "lookAhead", "legacyLookAhead", "metaAI", "observer"];

// ── Main class ────────────────────────────────────────────────────────────────

export class RegimeSwitchTracker {
  private cfg: RegimeConfig = {
    baseWindow: 12,
    window: 12,
    minCounts: { supreme: 6, syndicate: 4, lookAhead: 4, legacyLookAhead: 4, metaAI: 4, observer: 4 },
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
  };

  private dominant: ExpertKey | null = null;
  private dominantLockCount = 0;
  private lastDominant: ExpertKey | null = null;
  private regimeAge = 0;
  private switchCount = 0;
  private justSwitched = false;
  private switchTimeline: TimelineEntry[] = [];
  private volatilityIndex = 0;
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
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  // ── Capture methods (called before evaluateOutcome) ─────────────────────

  captureSupreme(decision: Side | "WAIT" | null): void {
    const exp = this.experts.supreme;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
      this._trimHistory(exp);
    }
  }

  captureSyndicate(alert: B2BAlert): void {
    const exp = this.experts.syndicate;
    if (alert.active && !alert.hasConflict && alert.consensusSide) {
      exp.lastPred = alert.consensusSide;
      exp.history.push({ pred: exp.lastPred, actual: null });
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
      this._trimHistory(exp);
    }
  }

  captureLegacyLookAhead(verdict: Side | null): void {
    const exp = this.experts.legacyLookAhead;
    exp.lastPred = verdict;
    if (verdict) {
      exp.history.push({ pred: verdict, actual: null });
      this._trimHistory(exp);
    }
  }

  captureMetaAI(decision: Side | "WAIT"): void {
    const exp = this.experts.metaAI;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
      this._trimHistory(exp);
    }
  }

  captureObserver(decision: Side | "WAIT"): void {
    const exp = this.experts.observer;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
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

    // Fill in actual for the most-recent pending prediction per expert
    ALL_KEYS.forEach((key) => {
      const hist = this.experts[key].history;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].actual === null) { hist[i].actual = actual; break; }
      }
    });

    this._recompute();
    this._adjustWindow();
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
        return;
      }

      // Weighted win rate (exponential decay, recent = heavier)
      let wH = 0, wT = 0, rH = 0;
      scored.forEach((h, i) => {
        const age = scored.length - 1 - i;
        const w = Math.pow(this.cfg.decayFactor, age);
        const hit = h.pred === h.actual ? 1 : 0;
        wH += hit * w; wT += w; rH += hit;
      });
      exp.rawWr = rH / scored.length;
      // Apply Bayesian adjustment to raw win rate
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
    });
  }

  // ── Dynamic window ──────────────────────────────────────────────────────

  private _adjustWindow(): void {
    // Use switch timeline to gauge volatility:
    // Short-lived regimes → volatile → shrink window
    // Long-lived regimes → stable → expand window
    const recent = this.switchTimeline.slice(-6);
    if (recent.length >= 2) {
      const avgHands = recent.reduce((s, e) => s + e.hands, 0) / recent.length;
      // avgHands < 4 → very volatile; avgHands > 10 → stable
      const volatility = Math.max(0, Math.min(1, 1 - (avgHands - 2) / 12));
      this.volatilityIndex = volatility;
      if (volatility > 0.65) this.cfg.window = 8;
      else if (volatility < 0.25) this.cfg.window = Math.min(16, this.cfg.baseWindow + 4);
      else this.cfg.window = this.cfg.baseWindow;
    }
  }

  // ── Dominant selection ──────────────────────────────────────────────────

  private _updateDominant(): void {
    if (this.dominantLockCount > 0) {
      this.dominantLockCount--;
      this.regimeAge++;
      this.justSwitched = false;
      return;
    }

    // Eligible experts: enough predictions to be considered
    const eligible = ALL_KEYS
      .filter((k) => this.experts[k].predCount >= this.cfg.minCounts[k])
      .sort((a, b) => this.experts[b].compositeScore - this.experts[a].compositeScore);

    if (eligible.length === 0) {
      if (this.dominant !== null) this._setDominant(null);
      else { this.regimeAge++; this.justSwitched = false; }
      return;
    }

    let newDom: ExpertKey = eligible[0];

    // SPLIT check: if top two are within splitThreshold — preserve current dominant
    if (eligible.length >= 2) {
      const gap = this.experts[eligible[0]].compositeScore - this.experts[eligible[1]].compositeScore;
      if (gap < this.cfg.splitThreshold) {
        // Keep existing dominant if still eligible; otherwise pick best
        newDom = this.dominant && eligible.includes(this.dominant) ? this.dominant : eligible[0];
      }
    }

    if (newDom !== this.dominant) {
      // Record the outgoing dominant in the switch timeline
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
  }

  // ── Verdict ─────────────────────────────────────────────────────────────

  getVerdict(): RegimeVerdict {
    const dom = this.dominant;

    // Build per-expert public stats
    const expertStats: Record<ExpertKey, ExpertStats> = {} as Record<ExpertKey, ExpertStats>;
    ALL_KEYS.forEach((key) => {
      const exp = this.experts[key];
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
      };
    });

    // ── Ensemble voting ────────────────────────────────────────────────
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
    const bothAgree = voting.length >= 4 && agreingCount === voting.length;
    const bothAgreeSide: Side | null = bothAgree ? ensembleVerdict : null;

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
  }

  reset(): void {
    this.experts = {
      supreme: freshExpert(),
      syndicate: freshExpert(),
      lookAhead: freshExpert(),
      legacyLookAhead: freshExpert(),
      metaAI: freshExpert(),
      observer: freshExpert(),
    };
    this.dominant = null;
    this.dominantLockCount = 0;
    this.lastDominant = null;
    this.regimeAge = 0;
    this.switchCount = 0;
    this.justSwitched = false;
    this.switchTimeline = [];
    this.volatilityIndex = 0;
    this._undoStack = [];
  }
}
