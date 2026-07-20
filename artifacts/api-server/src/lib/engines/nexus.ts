/**
 * Nexus Engine — ported from appA (CYBER-NEXUS)
 * Implements the 38 virtual prediction engines, performance tracking,
 * and the getTop5 filtered consensus.
 * Also provides the main APEX verdict for SupremeBayesianAI.
 */

type Side = "B" | "P";

// ── 38 Virtual Prediction Engines ───────────────────────────────────────────

const ENGINES: Record<string, (h: Side[]) => Side> = {
  L1: (h) => h[h.length - 1] ?? "B",
  L2: (h) => (h[h.length - 1] === "B" ? "P" : "B"),
  L3: (h) => h[h.length - 2] ?? "B",
  L4: (h) => (h.filter((x) => x === "B").length > h.length / 2 ? "B" : "P"),
  L5: (h) => h[0] ?? "B",
  L6: (h) => (h.length % 3 === 0 ? "B" : "P"),
  L7: (h) => {
    const s = h.slice(-4).join("");
    return s === "BBBB" ? "P" : s === "PPPP" ? "B" : (h[h.length - 1] ?? "B");
  },
  L8: (h) => {
    let b = 0, p = 0;
    h.slice(-10).forEach((x, i) => (x === "B" ? (b += i) : (p += i)));
    return b > p ? "B" : "P";
  },
  L9: (h) => {
    const last = h[h.length - 1];
    return h.slice(-3).every((x) => x === last)
      ? last === "B" ? "P" : "B"
      : last ?? "B";
  },
  L10: (h) => (["B", "B", "P", "P"] as Side[])[h.length % 4],
  L11: (h) => (["B", "P", "B", "P", "P"] as Side[])[h.length % 5],
  L12: (h) => (h.slice(-6).filter((x) => x === "B").length >= 3 ? "B" : "P"),
  L13: (h) =>
    h[h.length - 1] === h[h.length - 3]
      ? h[h.length - 2] ?? "B"
      : h[h.length - 1] ?? "B",
  L14: (h) => (h.length % 2 === 0 ? "B" : h[0] ?? "B"),
  L15: (h) => (h[h.length - 1] === "B" ? "B" : "P"),
  L16: (h) => (["B", "P", "B", "B", "P"] as Side[])[h.length % 5],
  L17: (h) => {
    const l3 = h.slice(-3).join("");
    return l3 === "BPB" || l3 === "PBP"
      ? h[h.length - 1] ?? "B"
      : h[h.length - 1] === "B" ? "P" : "B";
  },
  L18: (h) =>
    h.length < 5 ? "B" : h[h.length - 1] === h[h.length - 5] ? "P" : "B",
  L19: (h) => (h.slice(-2).includes("B") ? "P" : "B"),
  L20: (h) => (h.slice(-8).filter((x) => x === "P").length > 4 ? "B" : "P"),
  L21: (h) => h[Math.floor(h.length / 2)] ?? "B",
  L22: (h) => (h.length % 7 === 0 ? "P" : "B"),
  L23: (h) => (h.map((x) => (x === "B" ? "P" : "B") as Side)[h.length - 1] ?? "B"),
  L24: (h) =>
    h.length % 4 === 0
      ? h[h.length - 1] ?? "B"
      : h[0] === "B" ? "P" : "B",
  L25: (h) =>
    h.slice(-10).includes("B") && h.slice(-10).includes("P")
      ? h[h.length - 1] ?? "B"
      : "B",
  L26: (h) => h[h.length - 4] ?? "B",
  L27: (h) => (h.length > 20 ? h[h.length - 20] : h[0]) ?? "B",
  L28: (h) => (h.slice(-2).join("") === "BP" ? "B" : "P"),
  L29: (h) => {
    const s = h.slice(-2).join("");
    return s === "BB" || s === "PP" ? h[h.length - 1] ?? "B" : "B";
  },
  L30: () => "B",
  L31: () => "P",
  L32: (h) => (h.length % 2 === 0 ? "B" : "P"),
  L33: (h) => (h.length % 2 === 0 ? "P" : "B"),
  L34: (h) => {
    const first = h[0] ?? "B";
    const idx = h.length % 4;
    return first === "P" ? idx < 2 ? "P" : "B" : idx < 2 ? "B" : "P";
  },
  L35: (h) => {
    const first = h[0] ?? "B";
    const idx = h.length % 6;
    return first === "P" ? idx < 3 ? "P" : "B" : idx < 3 ? "B" : "P";
  },
  L36: (h) => {
    const first = h[0] ?? "B";
    const idx = h.length % 3;
    return first === "P" ? idx === 0 ? "P" : "B" : idx === 0 ? "B" : "P";
  },
  L37: (h) => {
    const first = h[0] ?? "B";
    const idx = h.length % 5;
    return first === "P" ? idx < 2 ? "P" : "B" : idx < 2 ? "B" : "P";
  },
  L38: (h) => {
    const first = h[0] ?? "B";
    const idx = h.length % 4;
    return first === "P" ? idx === 0 ? "P" : "B" : idx === 0 ? "B" : "P";
  },
};

interface EngineStats {
  wins: number;
  losses: number;
  total: number;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number; // positive = win streak, negative = loss streak
}

function freshStats(): EngineStats {
  return { wins: 0, losses: 0, total: 0, maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0 };
}

interface NexusStateSnap {
  history: Side[];
  registry: Record<string, EngineStats>;
}

export interface NexusSnapshot {
  apexSignal: Side | "WAIT";
  probP: number;
  probB: number;
  vol: number; // volatility 0-1
}

export class NexusEngine {
  private history: Side[] = [];
  private registry: Record<string, EngineStats> = {};
  private _undoStack: NexusStateSnap[] = [];

  constructor() {
    Object.keys(ENGINES).forEach((k) => {
      this.registry[k] = freshStats();
    });
  }

  private _save(): void {
    this._undoStack.push({
      history: [...this.history],
      registry: JSON.parse(JSON.stringify(this.registry)) as Record<string, EngineStats>,
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  handleInput(value: string): void {
    this._save();
    const actual = value as Side;
    if (actual !== "B" && actual !== "P") return; // ignore T

    const priorHistory = [...this.history];

    // Score all engines against this outcome using prior history
    Object.keys(ENGINES).forEach((key) => {
      const pred = ENGINES[key](priorHistory);
      const stats = this.registry[key];
      stats.total++;
      if (pred === actual) {
        stats.wins++;
        if (stats.currentStreak < 0) stats.currentStreak = 1;
        else stats.currentStreak++;
        if (stats.currentStreak > stats.maxWinStreak) stats.maxWinStreak = stats.currentStreak;
      } else {
        stats.losses++;
        if (stats.currentStreak > 0) stats.currentStreak = -1;
        else stats.currentStreak--;
        if (-stats.currentStreak > stats.maxLossStreak) stats.maxLossStreak = -stats.currentStreak;
      }
    });

    this.history.push(actual);
  }

  undoLast(): void {
    if (this._undoStack.length === 0) return;
    const prev = this._undoStack.pop()!;
    this.history = prev.history;
    this.registry = prev.registry;
  }

  reset(): void {
    this.history = [];
    Object.keys(ENGINES).forEach((k) => {
      this.registry[k] = freshStats();
    });
    this._undoStack = [];
  }

  private _getTop5Consensus(): Side | null {
    const h = this.history;

    const getHybridScore = (stats: EngineStats) =>
      (stats.currentStreak > 0 ? stats.currentStreak : 0) * 0.7 +
      stats.maxWinStreak * 0.3;

    const compiled = Object.keys(ENGINES).map((key) => {
      const stats = this.registry[key] ?? { wins: 0, losses: 0, total: 0, maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0 };
      const winRate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 50;
      const nextPred = ENGINES[key](h);
      return { id: key, winRate, nextPred, total: stats.total, dynamicScore: getHybridScore(stats) };
    });

    let pVotes = 0, bVotes = 0;
    const addVotes = (list: typeof compiled, invert: boolean) => {
      list.slice(0, 5).forEach((eng) => {
        const target = invert ? (eng.nextPred === "P" ? "B" : "P") : eng.nextPred;
        if (target === "P") pVotes++;
        else if (target === "B") bVotes++;
      });
    };

    const topWinRate = [...compiled].filter((e) => e.winRate >= 50 && e.total > 2).sort((a, b) => b.winRate - a.winRate);
    addVotes(topWinRate, false);

    const topLossRate = [...compiled].filter((e) => e.winRate < 50 && e.total > 2).sort((a, b) => a.winRate - b.winRate);
    addVotes(topLossRate, true);

    const topWinStreak = [...compiled].filter((e) => e.dynamicScore > 0).sort((a, b) => b.dynamicScore - a.dynamicScore);
    addVotes(topWinStreak, false);
    addVotes(topWinStreak, true);

    return pVotes > bVotes ? "P" : bVotes > pVotes ? "B" : null;
  }

  private _computeEMASignal(): Side | null {
    if (this.history.length < 5) return null;
    let cur = 0;
    const priceTrace: number[] = [];
    this.history.forEach((h) => { cur += h === "P" ? 1 : -1; priceTrace.push(cur); });
    const period = 5, k = 2 / (period + 1);
    const emas: number[] = [];
    for (let i = 0; i < priceTrace.length; i++) {
      emas.push(i === 0 ? priceTrace[0] : priceTrace[i] * k + emas[i - 1] * (1 - k));
    }
    const lastPrice = priceTrace[priceTrace.length - 1];
    const lastEMA = emas[emas.length - 1];
    return lastPrice > lastEMA ? "P" : "B";
  }

  getSnapshot(): NexusSnapshot {
    const h = this.history;
    const top5 = this._getTop5Consensus();
    const ema = this._computeEMASignal();

    // Both signals must agree for high confidence
    let apexSignal: Side | "WAIT" = "WAIT";
    if (top5 && ema && top5 === ema) apexSignal = top5;
    else if (top5) apexSignal = top5;

    // Rough probability estimate from vote distribution
    const allVotes = Object.keys(ENGINES).map((k) => ENGINES[k](h));
    const pCount = allVotes.filter((v) => v === "P").length;
    const bCount = allVotes.filter((v) => v === "B").length;
    const total = pCount + bCount;
    const probP = total > 0 ? (pCount / total) * 100 : 50;
    const probB = 100 - probP;

    // Volatility (chop index)
    const nonTieHistory = h;
    let flipCount = 0;
    for (let i = 1; i < nonTieHistory.length; i++) {
      if (nonTieHistory[i] !== nonTieHistory[i - 1]) flipCount++;
    }
    const vol = nonTieHistory.length > 1 ? flipCount / (nonTieHistory.length - 1) : 0.5;

    return { apexSignal, probP, probB, vol };
  }

  /**
   * Pure-history snapshot for look-ahead simulation.
   * Does NOT touch engine registry — uses only raw ENGINES votes + EMA.
   * Fast: O(38 + n) with no state mutation.
   */
  static computeApexForHistory(history: Side[]): NexusSnapshot {
    const h = history;
    const engineKeys = Object.keys(ENGINES);

    // Simple vote consensus (no accumulated registry)
    const votes = engineKeys.map((k) => ENGINES[k](h));
    const pVotes = votes.filter((v) => v === "P").length;
    const bVotes = votes.filter((v) => v === "B").length;
    const total = pVotes + bVotes;
    const rawTop5: Side | null = pVotes > bVotes ? "P" : bVotes > pVotes ? "B" : null;

    // EMA signal
    let ema: Side | null = null;
    if (h.length >= 5) {
      let cur = 0;
      const priceTrace: number[] = [];
      h.forEach((x) => { cur += x === "P" ? 1 : -1; priceTrace.push(cur); });
      const k = 2 / (5 + 1);
      const emas: number[] = [];
      for (let i = 0; i < priceTrace.length; i++) {
        emas.push(i === 0 ? priceTrace[0] : priceTrace[i] * k + emas[i - 1] * (1 - k));
      }
      const lastPrice = priceTrace[priceTrace.length - 1];
      const lastEMA = emas[emas.length - 1];
      ema = lastPrice > lastEMA ? "P" : "B";
    }

    let apexSignal: Side | "WAIT" = "WAIT";
    if (rawTop5 && ema && rawTop5 === ema) apexSignal = rawTop5;
    else if (rawTop5) apexSignal = rawTop5;

    const probP = total > 0 ? (pVotes / total) * 100 : 50;
    const probB = 100 - probP;

    let flipCount = 0;
    for (let i = 1; i < h.length; i++) {
      if (h[i] !== h[i - 1]) flipCount++;
    }
    const vol = h.length > 1 ? flipCount / (h.length - 1) : 0.5;

    return { apexSignal, probP, probB, vol };
  }
}
