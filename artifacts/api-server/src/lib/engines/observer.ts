/**
 * ObserverMasterAI — Self-learning layer that tracks rolling win-rates
 * of Meta AI, Look-Ahead, and Derived Roads, then votes for the best performer.
 * Ported faithfully from app.html ObserverMasterAI.
 */

type Side = "B" | "P";

interface SystemMemory {
  hits: number;
  total: number;
  history: number[]; // rolling last-10: 1=correct, 0=wrong
  lastPred: Side | null;
  winRate: number;
}

function freshMem(): SystemMemory {
  return { hits: 0, total: 0, history: [], lastPred: null, winRate: 0 };
}

export interface ObserverVerdict {
  decision: Side | "WAIT";
  wr: number | null;
  reasoning: string;
  isFallback: boolean;
}

export class ObserverMasterAI {
  private memory = {
    meta: freshMem(),
    lookAhead: freshMem(),
    derived: freshMem(),
  };

  /**
   * Call AFTER computing new predictions for the upcoming hand.
   * Stores what each sub-system is predicting so evaluateOutcome can score it.
   */
  capturePredictions(
    metaPred: Side | "WAIT" | null,
    lookAheadVerdict: Side | "WAIT" | null,
    derivedConsensus: Side | "NEUTRAL" | null
  ): void {
    this.memory.meta.lastPred = metaPred === "P" || metaPred === "B" ? metaPred : null;
    this.memory.lookAhead.lastPred =
      lookAheadVerdict === "P" || lookAheadVerdict === "B" ? lookAheadVerdict : null;
    this.memory.derived.lastPred =
      derivedConsensus === "P" || derivedConsensus === "B" ? derivedConsensus : null;
  }

  /** Call when actual hand outcome is known — updates rolling win-rates */
  evaluateOutcome(actual: Side): void {
    const update = (sys: SystemMemory) => {
      if (sys.lastPred === "P" || sys.lastPred === "B") {
        const isHit = sys.lastPred === actual ? 1 : 0;
        sys.history.push(isHit);
        if (sys.history.length > 10) sys.history.shift(); // 10-hand rolling window
        sys.hits = sys.history.reduce((a, b) => a + b, 0);
        sys.total = sys.history.length;
        sys.winRate = sys.total > 0 ? sys.hits / sys.total : 0;
      }
    };
    update(this.memory.meta);
    update(this.memory.lookAhead);
    update(this.memory.derived);
  }

  /** Returns the best-performing sub-system's current prediction */
  getUltimateVerdict(): ObserverVerdict {
    let bestKey: keyof typeof this.memory | null = null;
    let maxWR = -1;
    const votes = { P: 0, B: 0 };

    (["meta", "lookAhead", "derived"] as const).forEach((key) => {
      const sys = this.memory[key];
      if (sys.total >= 3 && (sys.lastPred === "P" || sys.lastPred === "B")) {
        if (sys.winRate > maxWR) {
          maxWR = sys.winRate;
          bestKey = key;
        }
        votes[sys.lastPred]++;
      }
    });

    // Best system wins if it has ≥50% win-rate
    if (bestKey !== null && maxWR >= 0.5) {
      const k = bestKey as "meta" | "lookAhead" | "derived";
      const names = { meta: "Meta AI", lookAhead: "Look-Ahead", derived: "Derived Roads" };
      return {
        decision: this.memory[k].lastPred!,
        wr: maxWR,
        reasoning: `Siding with ${names[k]} (${Math.round(maxWR * 100)}% WR)`,
        isFallback: false,
      };
    }

    // Democratic fallback
    if (votes.P > votes.B)
      return { decision: "P", wr: null, reasoning: "Democratic Consensus (P)", isFallback: true };
    if (votes.B > votes.P)
      return { decision: "B", wr: null, reasoning: "Democratic Consensus (B)", isFallback: true };
    return { decision: "WAIT", wr: null, reasoning: "Insufficient Data or Tie", isFallback: true };
  }

  getMemorySnapshot() {
    return {
      meta: { winRate: this.memory.meta.winRate, total: this.memory.meta.total, lastPred: this.memory.meta.lastPred },
      lookAhead: { winRate: this.memory.lookAhead.winRate, total: this.memory.lookAhead.total, lastPred: this.memory.lookAhead.lastPred },
      derived: { winRate: this.memory.derived.winRate, total: this.memory.derived.total, lastPred: this.memory.derived.lastPred },
    };
  }

  undoLast(): void {
    (["meta", "lookAhead", "derived"] as const).forEach((key) => {
      const sys = this.memory[key];
      if (sys.history.length > 0) {
        sys.history.pop();
        sys.hits = sys.history.reduce((a, b) => a + b, 0);
        sys.total = sys.history.length;
        sys.winRate = sys.total > 0 ? sys.hits / sys.total : 0;
      }
    });
  }

  reset(): void {
    this.memory.meta = freshMem();
    this.memory.lookAhead = freshMem();
    this.memory.derived = freshMem();
  }
}
