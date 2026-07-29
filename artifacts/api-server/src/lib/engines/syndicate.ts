/**
 * Syndicate B2B Engine — ported from app.html SyndicateMirror
 * Tracks 11 virtual players' back-to-back misses and produces
 * a consensus side when any player hits ≥5 consecutive misses.
 */

export interface PlayerState {
  id: number;
  wins: number;
  losses: number;
  currentStreak: number;
  b2bMisses: number;
  consecutiveWins: number;
  nextBet: "B" | "P" | null;
}

export interface B2BAlert {
  active: boolean;
  maxMiss: number;
  qualifyingCount: number;
  consensusSide: "B" | "P" | null;
  hasConflict: boolean;
  highestPlayers: PlayerState[];
}

function getStrategyBet(id: number, h: string[]): "B" | "P" | null {
  const len = h.length;
  const last = h[len - 1] as "B" | "P" | undefined;
  const first = h[0] as "B" | "P" | undefined;
  if (id <= 4) {
    if (id === 1) return "B";
    if (id === 2) return "P";
    if (id === 3) return len % 2 === 0 ? "B" : "P";
    if (id === 4) return len % 2 === 0 ? "P" : "B";
  }
  if (len === 0) return "B";
  switch (id) {
    case 5:
      return (["B", "B", "P", "P"] as const)[len % 4];
    case 6:
      return last === "B" ? "P" : "B";
    case 7:
      return last ?? "B";
    case 8: {
      const cycle = first === "P"
        ? (["P", "P", "P", "B", "B", "B"] as const)
        : (["B", "B", "B", "P", "P", "P"] as const);
      return cycle[len % 6];
    }
    case 9: {
      const cycle = first === "P"
        ? (["P", "B", "B"] as const)
        : (["B", "P", "P"] as const);
      return cycle[len % 3];
    }
    case 10: {
      const cycle = first === "P"
        ? (["P", "P", "B", "B", "B"] as const)
        : (["B", "B", "P", "P", "P"] as const);
      return cycle[len % 5];
    }
    case 11: {
      const cycle = first === "P"
        ? (["P", "B", "B", "B"] as const)
        : (["B", "P", "P", "P"] as const);
      return cycle[len % 4];
    }
  }
  return "B";
}

function initPlayers(): PlayerState[] {
  return Array.from({ length: 11 }, (_, i) => ({
    id: i + 1,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    b2bMisses: 0,
    consecutiveWins: 0,
    nextBet: null,
  }));
}

interface SyndicateStateSnapshot {
  players: PlayerState[];
  history: string[];
}

export class SyndicateEngine {
  private history: string[] = [];
  private players: PlayerState[] = initPlayers();
  private _stateHistory: SyndicateStateSnapshot[] = [];

  calculateSyndicate(actual: "B" | "P"): void {
    // Save state for undo
    this._stateHistory.push({
      players: JSON.parse(JSON.stringify(this.players)) as PlayerState[],
      history: [...this.history],
    });
    if (this._stateHistory.length > 200) this._stateHistory.shift();

    this.history.push(actual);

    this.players.forEach((p) => {
      // First hand: bots 5-11 are in shadow — check theoretical vs actual
      if (this.history.length === 1 && p.id >= 5) {
        const theoreticalBet = getStrategyBet(p.id, []);
        if (theoreticalBet && theoreticalBet !== actual) p.b2bMisses++;
      } else if (p.nextBet) {
        if (p.nextBet === actual) {
          p.wins++;
          p.consecutiveWins++;
          p.currentStreak = p.currentStreak < 0 ? 1 : p.currentStreak + 1;
          if (p.consecutiveWins >= 2) p.b2bMisses = 0;
        } else {
          p.losses++;
          p.consecutiveWins = 0;
          p.currentStreak = p.currentStreak > 0 ? -1 : p.currentStreak - 1;
          p.b2bMisses++;
        }
      }
      p.nextBet = getStrategyBet(p.id, this.history);
    });
  }

  undoLast(): void {
    if (this._stateHistory.length === 0) return;
    const prev = this._stateHistory.pop()!;
    this.players = prev.players;
    this.history = prev.history;
    this.players.forEach((p) => {
      p.nextBet = getStrategyBet(p.id, this.history);
    });
  }

  reset(): void {
    this.history = [];
    this.players = initPlayers();
    this._stateHistory = [];
  }

  /** Returns each bot's current next-bet prediction (null if no prediction yet). */
  getBotPredictions(): Array<{ id: number; pred: "B" | "P" | null }> {
    return this.players.map((p) => ({ id: p.id, pred: p.nextBet }));
  }

  getB2BAlert(): B2BAlert {
    const THRESHOLD = 5;
    const maxMissAll = this.players.reduce(
      (m, p) => Math.max(m, p.b2bMisses),
      0,
    );
    const allQualified = this.players.filter(
      (p) => p.b2bMisses >= THRESHOLD && p.nextBet,
    );
    if (allQualified.length === 0) {
      return { active: false, maxMiss: maxMissAll, qualifyingCount: 0, consensusSide: null, hasConflict: false, highestPlayers: [] };
    }
    const maxMissQ = allQualified.reduce((m, p) => Math.max(m, p.b2bMisses), 0);
    const highestPlayers = allQualified.filter((p) => p.b2bMisses === maxMissQ);
    const sides = [...new Set(highestPlayers.map((p) => p.nextBet).filter(Boolean))] as string[];
    const consensusSide = sides.length === 1 ? (sides[0] as "B" | "P") : null;
    return {
      active: true,
      maxMiss: maxMissAll,
      qualifyingCount: allQualified.length,
      highestPlayers,
      consensusSide,
      hasConflict: sides.length > 1,
    };
  }
}
