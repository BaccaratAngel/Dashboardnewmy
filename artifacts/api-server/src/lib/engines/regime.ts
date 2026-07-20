/**
 * Regime Switch Tracker — ported faithfully from app.html
 * Scores Supreme Bayesian and Syndicate B2B win rates over a rolling window,
 * determines which expert is dominant, and outputs the final prediction.
 */

import type { B2BAlert } from "./syndicate.js";

type Side = "B" | "P";

interface ExpertHistory {
  pred: Side;
  actual: Side | null;
}

interface ExpertState {
  history: ExpertHistory[];
  lastPred: Side | null;
  wwr: number;   // weighted win rate
  rawWr: number; // raw win rate
  predCount: number;
}

interface RegimeConfig {
  window: number;
  minSupreme: number;
  minSyndicate: number;
  decayFactor: number;
  lockHands: number;
  splitThreshold: number;
}

export interface RegimeVerdict {
  status: "WARMING_UP" | "TRACKING" | "SPLIT";
  decision: Side | null;
  expert: "supreme" | "syndicate" | null;
  confidence: "NONE" | "LOW" | "MED" | "HIGH";
  isSplit: boolean;
  gap: number;
  bothAgree: boolean;
  bothAgreeSide: Side | null;
  regimeAge: number;
  switchCount: number;
  justSwitched: boolean;
  isLocked: boolean;
  lockRemain: number;
  window: number;
  supreme: { predCount: number; wwr: number; rawWr: number };
  syndicate: { predCount: number; wwr: number; rawWr: number };
}

interface RegimeStateSnap {
  experts: { supreme: ExpertState; syndicate: ExpertState };
  dominant: "supreme" | "syndicate" | null;
  dominantLockCount: number;
  lastDominant: "supreme" | "syndicate" | null;
  regimeAge: number;
  switchCount: number;
  justSwitched: boolean;
  cfg: RegimeConfig;
}

function freshExpert(): ExpertState {
  return { history: [], lastPred: null, wwr: 0, rawWr: 0, predCount: 0 };
}

export class RegimeSwitchTracker {
  private cfg: RegimeConfig = {
    window: 12,
    minSupreme: 6,
    minSyndicate: 4,
    decayFactor: 0.88,
    lockHands: 5,
    splitThreshold: 0.06,
  };
  private experts: { supreme: ExpertState; syndicate: ExpertState } = {
    supreme: freshExpert(),
    syndicate: freshExpert(),
  };
  private dominant: "supreme" | "syndicate" | null = null;
  private dominantLockCount = 0;
  private lastDominant: "supreme" | "syndicate" | null = null;
  private regimeAge = 0;
  private switchCount = 0;
  private justSwitched = false;
  private _undoStack: RegimeStateSnap[] = [];

  private _save(): void {
    this._undoStack.push({
      experts: JSON.parse(JSON.stringify(this.experts)) as { supreme: ExpertState; syndicate: ExpertState },
      dominant: this.dominant,
      dominantLockCount: this.dominantLockCount,
      lastDominant: this.lastDominant,
      regimeAge: this.regimeAge,
      switchCount: this.switchCount,
      justSwitched: this.justSwitched,
      cfg: { ...this.cfg },
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  captureSupreme(decision: Side | "WAIT" | null): void {
    const exp = this.experts.supreme;
    exp.lastPred = decision === "P" || decision === "B" ? decision : null;
    if (exp.lastPred) {
      exp.history.push({ pred: exp.lastPred, actual: null });
      if (exp.history.length > this.cfg.window + 8) exp.history.shift();
    }
  }

  captureSyndicate(alert: B2BAlert): void {
    const exp = this.experts.syndicate;
    if (alert.active && !alert.hasConflict && alert.consensusSide) {
      exp.lastPred = alert.consensusSide;
      exp.history.push({ pred: exp.lastPred, actual: null });
      if (exp.history.length > this.cfg.window + 8) exp.history.shift();
    } else {
      exp.lastPred = null;
    }
  }

  evaluateOutcome(actual: Side): void {
    this._save();
    if (actual !== "P" && actual !== "B") return;
    (["supreme", "syndicate"] as const).forEach((key) => {
      const hist = this.experts[key].history;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].actual === null) { hist[i].actual = actual; break; }
      }
    });
    this._recompute();
    this._updateDominant();
  }

  private _recompute(): void {
    (["supreme", "syndicate"] as const).forEach((key) => {
      const exp = this.experts[key];
      const scored = exp.history.filter((h) => h.actual !== null).slice(-this.cfg.window);
      exp.predCount = scored.length;
      if (!scored.length) { exp.wwr = 0; exp.rawWr = 0; return; }
      let wH = 0, wT = 0, rH = 0;
      scored.forEach((h, i) => {
        const age = scored.length - 1 - i;
        const w = Math.pow(this.cfg.decayFactor, age);
        const hit = h.pred === h.actual ? 1 : 0;
        wH += hit * w; wT += w; rH += hit;
      });
      exp.wwr = wT > 0 ? wH / wT : 0;
      exp.rawWr = scored.length > 0 ? rH / scored.length : 0;
    });
  }

  private _updateDominant(): void {
    const sup = this.experts.supreme;
    const syn = this.experts.syndicate;

    if (this.dominantLockCount > 0) {
      this.dominantLockCount--;
      this.regimeAge++;
      this.justSwitched = false;
      return;
    }

    const supReady = sup.predCount >= this.cfg.minSupreme;
    const synReady = syn.predCount >= this.cfg.minSyndicate;
    let newDom: "supreme" | "syndicate" | null;

    if (!supReady && !synReady) newDom = null;
    else if (supReady && !synReady) newDom = "supreme";
    else if (!supReady && synReady) newDom = "syndicate";
    else {
      const gap = Math.abs(sup.wwr - syn.wwr);
      newDom = gap < this.cfg.splitThreshold
        ? (this.dominant ?? "supreme")
        : sup.wwr >= syn.wwr ? "supreme" : "syndicate";
    }

    if (newDom !== this.dominant) {
      this.lastDominant = this.dominant;
      this.dominant = newDom;
      this.regimeAge = 0;
      this.justSwitched = this.lastDominant !== null;
      this.dominantLockCount = this.cfg.lockHands;
      if (this.lastDominant !== null) this.switchCount++;
    } else {
      this.regimeAge++;
      this.justSwitched = false;
    }
  }

  getVerdict(): RegimeVerdict {
    const sup = this.experts.supreme;
    const syn = this.experts.syndicate;
    const dom = this.dominant;

    const base = {
      regimeAge: this.regimeAge,
      switchCount: this.switchCount,
      isLocked: this.dominantLockCount > 0,
      lockRemain: this.dominantLockCount,
      justSwitched: this.justSwitched,
      lastDominant: this.lastDominant,
      window: this.cfg.window,
      supreme: { predCount: sup.predCount, wwr: sup.wwr, rawWr: sup.rawWr },
      syndicate: { predCount: syn.predCount, wwr: syn.wwr, rawWr: syn.rawWr },
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
        bothAgree: false,
        bothAgreeSide: null,
      };
    }

    const domExp = this.experts[dom];
    const altExp = this.experts[dom === "supreme" ? "syndicate" : "supreme"];
    const gap = Math.abs(domExp.wwr - altExp.wwr);
    const isSplit = gap < this.cfg.splitThreshold && altExp.predCount >= this.cfg.minSyndicate;

    let confidence: "NONE" | "LOW" | "MED" | "HIGH" = "LOW";
    if (gap >= 0.15) confidence = "HIGH";
    else if (gap >= 0.08) confidence = "MED";

    const supLast = sup.lastPred;
    const synLast = syn.lastPred;
    const bothAgree = !!(
      supLast && synLast && supLast === synLast &&
      sup.predCount >= 4 && syn.predCount >= 4
    );

    return {
      ...base,
      status: isSplit ? "SPLIT" : "TRACKING",
      decision: domExp.lastPred,
      expert: dom,
      confidence,
      isSplit,
      gap,
      bothAgree,
      bothAgreeSide: bothAgree ? supLast : null,
    };
  }

  setWindow(n: number): void {
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
  }

  reset(): void {
    this.experts = { supreme: freshExpert(), syndicate: freshExpert() };
    this.dominant = null;
    this.dominantLockCount = 0;
    this.lastDominant = null;
    this.regimeAge = 0;
    this.switchCount = 0;
    this.justSwitched = false;
    this._undoStack = [];
  }
}
