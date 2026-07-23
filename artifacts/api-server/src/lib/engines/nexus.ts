/**
 * Nexus Engine — full port of appA (CYBER-NEXUS v4.0)
 *
 * Contains two sub-engines exactly as implemented in the original HTML source:
 *   • AbacativeEngine  — App2Sandbox: ABACATIVE v62
 *     24 road agents × 4 roads, 21 virtual players, archetype memory bank,
 *     3-strike lockout with failure-fingerprint capture, structural contradiction filter.
 *
 *   • OmniVortexEngine — App3Sandbox: OMNI-VORTEX 9.1
 *     29 named agents (12 core + 17 Omni Cluster nodes), Big Eye Boy road,
 *     5-hand match-window weights, EMA-5 agreement filter.
 *
 * NexusEngine wraps both and exposes the same NexusSnapshot interface
 * that the rest of the pipeline (SupremeBayesianAI, LookAhead) consumes.
 */

type Side = "B" | "P";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ABACATIVE ENGINE (App2Sandbox)
// ─────────────────────────────────────────────────────────────────────────────

interface RoadTelemetry {
  totalBets: number;
  hits: number;
  currentLivePrediction: Side | "--";
}

interface RoadAgent {
  id: number;
  period: number;
  targetRoad: "main" | "k1" | "k2" | "k3";
  weight: number;
  lastPrediction: Side | "--";
  history: number[]; // 5-hand rolling: 1=hit 0=miss
}

interface VirtualPlayer {
  id: number;
  name: string;
  currentPrediction: Side | "--";
  totalBets: number;
  hits: number;
  streak: number;
  maxStreak: number;
  performanceLog: number[]; // 8-hand rolling
}

interface Archetype {
  id: string;
  entropy: number;       // shoe entropy index (avg items per column)
  depthVector: number[]; // last-4-column depths
  failedPrediction: string;
  invertedCorrection: "PLAYER" | "BANKER";
  confidence: number;
}

type MatrixCell = Side;
type BigRoadMatrix = MatrixCell[][];

interface App2Snap {
  roadTelemetry: Record<string, RoadTelemetry>;
  agents: RoadAgent[];
  virtualPlayers: VirtualPlayer[];
  metaLossStreak: number;
  lockOutCounter: number;
  silentFailureCountDuringLockout: number;
  appLastLiveVerdict: string;
  rawVerdictBeforeLockout: string;
  history: string[];
  memoryMatchActiveThisHand: Archetype | null;
}

class AbacativeEngine {
  private history: string[] = [];
  private roadTelemetry: Record<string, RoadTelemetry> = {
    main: { totalBets: 0, hits: 0, currentLivePrediction: "--" },
    k1:   { totalBets: 0, hits: 0, currentLivePrediction: "--" },
    k2:   { totalBets: 0, hits: 0, currentLivePrediction: "--" },
    k3:   { totalBets: 0, hits: 0, currentLivePrediction: "--" },
  };
  private agents: RoadAgent[] = [];
  private virtualPlayers: VirtualPlayer[] = [];
  private archetypeMemoryBank: Archetype[] = [];
  private metaLossStreak = 0;
  private lockOutCounter = 0;
  private silentFailureCountDuringLockout = 0;
  appLastLiveVerdict = "--";
  private rawVerdictBeforeLockout = "--";
  private memoryMatchActiveThisHand: Archetype | null = null;
  private _undoStack: App2Snap[] = [];

  constructor() {
    this._initRoadAgents();
    this._init21VirtualPlayers();
  }

  private _initRoadAgents(): void {
    this.agents = [];
    const roads = ["main", "k1", "k2", "k3"] as const;
    for (let i = 1; i <= 24; i++) {
      this.agents.push({
        id: i,
        period: Math.max(1, Math.floor(i / 2)),
        targetRoad: roads[i % roads.length],
        weight: 1.0,
        lastPrediction: "--",
        history: [],
      });
    }
  }

  private _init21VirtualPlayers(): void {
    this.virtualPlayers = [];
    this.virtualPlayers.push({ id: 0, name: "SPATIAL_RADAR", currentPrediction: "--", totalBets: 0, hits: 0, streak: 0, maxStreak: 0, performanceLog: [] });
    for (let i = 1; i <= 20; i++) {
      this.virtualPlayers.push({ id: i, name: `P${i < 10 ? "0" + i : i}`, currentPrediction: "--", totalBets: 0, hits: 0, streak: 0, maxStreak: 0, performanceLog: [] });
    }
  }

  // ── Matrix builders (faithful port) ────────────────────────────────────────

  private _buildMatrix(data: string[]): { matrix: BigRoadMatrix; list: { x: number; y: number; type: Side }[] } {
    const matrix: BigRoadMatrix = [];
    const list: { x: number; y: number; type: Side }[] = [];
    let curX = 0, curY = 0, last: string | null = null;
    data.forEach((res) => {
      if (res === "T") return;
      if (last && res !== last) {
        curX++;
        curY = 0;
        while (matrix[curX] && matrix[curX][0]) curX++;
      } else if (last) {
        if (curY + 1 < 6 && (!matrix[curX] || !matrix[curX][curY + 1])) curY++;
        else curX++;
      }
      if (!matrix[curX]) matrix[curX] = [];
      matrix[curX][curY] = res as Side;
      list.push({ x: curX, y: curY, type: res as Side });
      last = res;
    });
    return { matrix, list };
  }

  private _derive(matrix: BigRoadMatrix, offset: number): { x: number; y: number; type: Side }[] {
    const results: string[] = [];
    for (let i = offset; i < matrix.length; i++) {
      const startJ = i === offset ? 1 : 0;
      for (let j = startJ; j < matrix[i].length; j++) {
        if (!matrix[i][j]) continue;
        let isRed: boolean;
        if (j === 0) {
          isRed = matrix[i - 1].length === matrix[i - 1 - offset]?.length;
        } else {
          if (matrix[i - offset]?.[j] !== undefined) isRed = true;
          else isRed = matrix[i - offset]?.[j - 1] === undefined;
        }
        results.push(isRed ? "B" : "P");
      }
    }
    return this._buildMatrix(results).list;
  }

  // ── Undo snapshot ───────────────────────────────────────────────────────────

  private _save(): void {
    this._undoStack.push(JSON.parse(JSON.stringify({
      roadTelemetry: this.roadTelemetry,
      agents: this.agents,
      virtualPlayers: this.virtualPlayers,
      metaLossStreak: this.metaLossStreak,
      lockOutCounter: this.lockOutCounter,
      silentFailureCountDuringLockout: this.silentFailureCountDuringLockout,
      appLastLiveVerdict: this.appLastLiveVerdict,
      rawVerdictBeforeLockout: this.rawVerdictBeforeLockout,
      history: this.history,
      memoryMatchActiveThisHand: this.memoryMatchActiveThisHand,
    })) as App2Snap);
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  undoLast(): void {
    if (this._undoStack.length === 0) return;
    const prev = this._undoStack.pop()!;
    this.roadTelemetry = prev.roadTelemetry as Record<string, RoadTelemetry>;
    this.agents = prev.agents;
    this.virtualPlayers = prev.virtualPlayers;
    this.metaLossStreak = prev.metaLossStreak;
    this.lockOutCounter = prev.lockOutCounter;
    this.silentFailureCountDuringLockout = prev.silentFailureCountDuringLockout;
    this.appLastLiveVerdict = prev.appLastLiveVerdict;
    this.rawVerdictBeforeLockout = prev.rawVerdictBeforeLockout;
    this.history = prev.history;
    this.memoryMatchActiveThisHand = prev.memoryMatchActiveThisHand;
  }

  // ── Main input handler ──────────────────────────────────────────────────────

  processInput(result: string): void {
    this._save();

    if (result !== "T" && this.history.length >= 2) {
      const actualStr = result === "P" ? "PLAYER" : "BANKER";

      // Score archetype memory match from previous hand
      if (this.memoryMatchActiveThisHand) {
        const wasRight = this.memoryMatchActiveThisHand.invertedCorrection === actualStr;
        this._updateMatchedMemoryPerformance(this.memoryMatchActiveThisHand.id, wasRight);
      }

      // Lockout tick
      if (this.lockOutCounter > 0) {
        if (this.rawVerdictBeforeLockout && this.rawVerdictBeforeLockout !== "--") {
          const cleanSim = this.rawVerdictBeforeLockout.split(" ")[0];
          if (cleanSim !== actualStr) this.silentFailureCountDuringLockout++;
        }
        this.lockOutCounter--;
        if (this.lockOutCounter === 0) {
          if (this.silentFailureCountDuringLockout >= 2) {
            const big = this._buildMatrix(this.history);
            this._captureAndStoreFailureArchetype(big.matrix);
          }
          this.metaLossStreak = 0;
        }
      } else {
        if (this.appLastLiveVerdict && this.appLastLiveVerdict !== "--" && !this.appLastLiveVerdict.includes("SKIP")) {
          const verdictClean = this.appLastLiveVerdict.split(" ")[0];
          if (verdictClean === actualStr) this.metaLossStreak = 0;
          else this.metaLossStreak++;
        }
      }

      // Score road telemetry
      const roads = ["main", "k1", "k2", "k3"] as const;
      roads.forEach((key) => {
        const p = this.roadTelemetry[key].currentLivePrediction;
        if (p && p !== "--") {
          this.roadTelemetry[key].totalBets++;
          if (p === result) this.roadTelemetry[key].hits++;
        }
      });

      // Score road agents (5-hand window)
      this.agents.forEach((a) => {
        if (a.lastPrediction && a.lastPrediction !== "--") {
          const hit = a.lastPrediction === result ? 1 : 0;
          a.history.push(hit);
          if (a.history.length > 5) a.history.shift();
          a.weight = 0.4 + a.history.reduce((s, c) => s + c, 0) * 0.4;
        }
      });

      // Score virtual players (8-hand window)
      this.virtualPlayers.forEach((p) => {
        if (p.currentPrediction && p.currentPrediction !== "--") {
          p.totalBets++;
          if (p.currentPrediction === result) {
            p.hits++;
            p.streak++;
            if (p.streak > p.maxStreak) p.maxStreak = p.streak;
            p.performanceLog.push(1);
          } else {
            p.streak = 0;
            p.performanceLog.push(0);
          }
          if (p.performanceLog.length > 8) p.performanceLog.shift();
        }
      });
    }

    this.history.push(result);
    this._runCoreMath();
  }

  private _runCoreMath(): void {
    const len = this.history.length;

    if (len < 5) {
      this.appLastLiveVerdict = "--";
      this.memoryMatchActiveThisHand = null;
      return;
    }

    const big = this._buildMatrix(this.history);
    const r1 = this._derive(big.matrix, 1);
    const r2 = this._derive(big.matrix, 2);
    const r3 = this._derive(big.matrix, 3);

    const mainClean = this.history.filter((x) => x !== "T") as Side[];
    const s1 = r1.map((i) => i.type);
    const s2 = r2.map((i) => i.type);
    const s3 = r3.map((i) => i.type);

    // Compute road agent predictions
    this.agents.forEach((a) => {
      let d: Side | "--" = "--";
      if (a.targetRoad === "main") {
        const l = mainClean.length - 1 - a.period;
        d = l >= 0 ? mainClean[l] : mainClean.length % 2 === 0 ? "P" : "B";
      } else if (a.targetRoad === "k1" && s1.length > a.period) {
        d = s1[s1.length - 1 - a.period];
      } else if (a.targetRoad === "k2" && s2.length > a.period) {
        d = s2[s2.length - 1 - a.period];
      } else if (a.targetRoad === "k3" && s3.length > a.period) {
        d = s3[s3.length - 1 - a.period];
      }
      a.lastPrediction = d;
    });

    // Road telemetry weighted vote
    const roads = ["main", "k1", "k2", "k3"] as const;
    roads.forEach((key) => {
      const vw = { P: 0, B: 0 };
      this.agents.forEach((a) => {
        if (a.targetRoad === key && a.lastPrediction !== "--")
          vw[a.lastPrediction] += a.weight;
      });
      this.roadTelemetry[key].currentLivePrediction = vw.P >= vw.B ? "P" : "B";
    });

    const lastHand = mainClean[mainClean.length - 1];

    // Virtual player predictions
    this.virtualPlayers.forEach((p) => {
      let choice: Side | "--" = "--";
      switch (p.id) {
        case 0: {
          if (big.matrix.length >= 2) {
            const totalCols = big.matrix.length;
            const singleItemCols = big.matrix.filter((c) => c && c.length === 1).length;
            const ratio = singleItemCols / totalCols;
            let deepest = 0;
            const start = Math.max(0, big.matrix.length - 4);
            for (let i = start; i < big.matrix.length; i++) {
              if (big.matrix[i]?.length > deepest) deepest = big.matrix[i].length;
            }
            if (deepest >= 4) choice = lastHand;
            else if (ratio > 0.5) choice = lastHand === "P" ? "B" : "P";
            else choice = lastHand;
          } else choice = lastHand;
          break;
        }
        case 1: if (big.matrix.length >= 2) { const lenL = big.matrix[big.matrix.length - 1].length; const lenL2 = big.matrix[big.matrix.length - 2]?.length ?? 0; choice = lenL === lenL2 ? (lastHand === "P" ? "B" : "P") : lastHand; } break;
        case 2: if (big.matrix.length >= 1) { const currColLen = big.matrix[big.matrix.length - 1].length; choice = currColLen === 2 ? lastHand : (lastHand === "P" ? "B" : "P"); } break;
        case 3: choice = lastHand === "P" ? "B" : "P"; break;
        case 4: if (big.matrix.length >= 1) { const cLen = big.matrix[big.matrix.length - 1].length; choice = cLen === 1 ? lastHand : (lastHand === "P" ? "B" : "P"); } break;
        case 5: if (s1.length > 0) choice = s1[s1.length - 1]; break;
        case 6: if (s2.length > 0) choice = s2[s2.length - 1] === "P" ? "B" : "P"; break;
        case 7: if (s3.length > 0) choice = s3[s3.length - 1]; break;
        case 8: {
          if (mainClean.length >= 4) {
            const sig = mainClean.slice(-3).join("");
            let matchFound: Side | "--" = "--";
            for (let i = 0; i < mainClean.length - 4; i++) {
              if (mainClean.slice(i, i + 3).join("") === sig) { matchFound = mainClean[i + 3]; break; }
            }
            choice = matchFound !== "--" ? matchFound : lastHand;
          }
          break;
        }
        case 9: if (mainClean.length >= 3) { choice = mainClean[mainClean.length - 3] === "P" ? "B" : "P"; } break;
        case 10: { const last5 = mainClean.slice(-5); const pC = last5.filter((x) => x === "P").length; choice = pC >= 3 ? "B" : "P"; break; }
        case 11: choice = (big.matrix.length >= 1 && big.matrix[big.matrix.length - 1].length >= 3) ? lastHand : "--"; break;
        case 12: choice = (big.matrix.length >= 1 && big.matrix[big.matrix.length - 1].length >= 4) ? (lastHand === "P" ? "B" : "P") : "--"; break;
        case 13: { const pCols = big.matrix.filter((c) => c?.[0] === "P").length; const bCols = big.matrix.filter((c) => c?.[0] === "B").length; choice = pCols >= bCols ? "P" : "B"; break; }
        case 14: { let alters = 0; for (let i = 1; i < Math.min(6, mainClean.length); i++) { if (mainClean[mainClean.length - i] !== mainClean[mainClean.length - i - 1]) alters++; } choice = alters >= 3 ? lastHand : (lastHand === "P" ? "B" : "P"); break; }
        case 15: { const tcP = mainClean.filter((x) => x === "P").length; const tcB = mainClean.filter((x) => x === "B").length; choice = tcP > tcB ? "B" : "P"; break; }
        case 16: { const lastTieIdx = this.history.lastIndexOf("T"); if (lastTieIdx !== -1 && lastTieIdx < this.history.length - 1) { const after = this.history[lastTieIdx + 1]; choice = after !== "T" ? (after as Side) : "P"; } break; }
        case 17: choice = big.matrix.length % 2 === 0 ? "P" : "B"; break;
        case 18: { let bestRoad = "main", maxAcc = -1; roads.forEach((k) => { const acc = this.roadTelemetry[k].totalBets > 0 ? this.roadTelemetry[k].hits / this.roadTelemetry[k].totalBets : 0; if (acc > maxAcc) { maxAcc = acc; bestRoad = k; } }); choice = this.roadTelemetry[bestRoad].currentLivePrediction; break; }
        case 19: { const rHits = p.performanceLog.slice(-3); choice = (rHits.length >= 2 && rHits.reduce((s, v) => s + v, 0) === 0) ? lastHand : "--"; break; }
        case 20: { let vP = 0, vB = 0; for (let k = 1; k <= 19; k++) { if (this.virtualPlayers[k].currentPrediction === "P") vP++; if (this.virtualPlayers[k].currentPrediction === "B") vB++; } choice = vP >= vB ? "P" : "B"; break; }
      }
      p.currentPrediction = choice === "--" ? lastHand : choice;
    });

    // Road consensus
    const rVotes = { P: 0, B: 0 };
    roads.forEach((k) => { if (this.roadTelemetry[k].currentLivePrediction !== "--") rVotes[this.roadTelemetry[k].currentLivePrediction]++; });
    const roadSideVerdict: Side = rVotes.P >= rVotes.B ? "P" : "B";

    // Floor: top-3 by streak
    const fVotes = { P: 0, B: 0 };
    const top3 = [...this.virtualPlayers].sort((a, b) => b.streak - a.streak).slice(0, 3);
    top3.forEach((p) => { if (p.currentPrediction === "P" || p.currentPrediction === "B") fVotes[p.currentPrediction]++; });
    const floorSideVerdict: Side = fVotes.P >= fVotes.B ? "P" : "B";

    this.rawVerdictBeforeLockout = roadSideVerdict === "P" ? "PLAYER LOCKED" : "BANKER LOCKED";

    // Layer 1: archetype memory recall
    const historicalMatch = this._checkActiveMemoryMatches(big.matrix);
    if (historicalMatch) {
      this.memoryMatchActiveThisHand = historicalMatch;
      this.lockOutCounter = 0;
      const targetSide = historicalMatch.invertedCorrection;
      this.appLastLiveVerdict = `MATCH FOUND: BYPASSING TRAP BASED ON ID ${historicalMatch.id} [CONF: ${historicalMatch.confidence}]\n${targetSide} LOCKED (MEMORY OVERRIDE)`;
      return;
    }
    this.memoryMatchActiveThisHand = null;

    // Layer 2: lockout trigger
    if (this.metaLossStreak >= 3 && this.lockOutCounter === 0) {
      this.lockOutCounter = 3;
      this.silentFailureCountDuringLockout = 0;
    }
    if (this.lockOutCounter > 0) {
      this.appLastLiveVerdict = "RECORDING FINGERPRINT...";
      return;
    }

    // Layer 3: structural contradiction strategy
    let deepVerticalStreakPresent = false;
    const lookbackCols = Math.min(4, big.matrix.length);
    for (let i = big.matrix.length - lookbackCols; i < big.matrix.length; i++) {
      if (big.matrix[i]?.length >= 4) deepVerticalStreakPresent = true;
    }

    let globalHorizontalCeilingActive = false;
    if (big.matrix.length >= 5 && !deepVerticalStreakPresent) {
      let flatCount = 0;
      for (let i = big.matrix.length - 5; i < big.matrix.length; i++) {
        if (big.matrix[i]?.length <= 2) flatCount++;
      }
      if (flatCount >= 4) globalHorizontalCeilingActive = true;
    }

    if (deepVerticalStreakPresent) {
      const lastCol = big.matrix[big.matrix.length - 1];
      const lastSide = lastCol?.[lastCol.length - 1] ?? this.history[this.history.length - 1] as Side;
      this.appLastLiveVerdict = lastSide === "P" ? "PLAYER LOCKED (DRAGON DROP)" : "BANKER LOCKED (DRAGON DROP)";
    } else if (globalHorizontalCeilingActive) {
      if (roadSideVerdict === floorSideVerdict) {
        this.appLastLiveVerdict = roadSideVerdict === "P" ? "PLAYER LOCKED (SHALLOW ROW)" : "BANKER LOCKED (SHALLOW ROW)";
      } else {
        this.appLastLiveVerdict = "ANTI-TRAP FORCE SKIP";
      }
    } else {
      if (roadSideVerdict !== floorSideVerdict) {
        this.appLastLiveVerdict = "CONTRADICTION DETECTED - WAITING FOR STABILITY\nNEUTRAL FILTER ENGAGED (SKIP)";
      } else {
        this.appLastLiveVerdict = roadSideVerdict === "P" ? "PLAYER LOCKED" : "BANKER LOCKED";
      }
    }
  }

  // ── Archetype memory ────────────────────────────────────────────────────────

  private _captureAndStoreFailureArchetype(matrix: BigRoadMatrix): void {
    if (!matrix || matrix.length < 3) return;
    const totalColumns = matrix.length;
    const totalRowItems = matrix.reduce((s, col) => s + (col ? col.length : 0), 0);
    const shoeEntropyIndex = totalColumns > 0 ? totalRowItems / totalColumns : 0;

    const depthVector: number[] = [];
    const lookback = Math.min(4, matrix.length);
    for (let i = matrix.length - lookback; i < matrix.length; i++) {
      depthVector.push(matrix[i] ? matrix[i].length : 0);
    }

    const cleanH = this.history.filter((x) => x !== "T") as Side[];
    const realWinningSide: "PLAYER" | "BANKER" = cleanH[cleanH.length - 1] === "P" ? "PLAYER" : "BANKER";

    const newArch: Archetype = {
      id: "ARK_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      entropy: parseFloat(shoeEntropyIndex.toFixed(2)),
      depthVector,
      failedPrediction: this.rawVerdictBeforeLockout.split(" ")[0],
      invertedCorrection: realWinningSide,
      confidence: 1,
    };

    const exists = this.archetypeMemoryBank.some(
      (arch) =>
        Math.abs(arch.entropy - newArch.entropy) < 0.05 &&
        JSON.stringify(arch.depthVector) === JSON.stringify(newArch.depthVector)
    );
    if (!exists) this.archetypeMemoryBank.push(newArch);
  }

  private _checkActiveMemoryMatches(matrix: BigRoadMatrix): Archetype | null {
    if (this.archetypeMemoryBank.length === 0 || !matrix || matrix.length < 3) return null;
    const totalColumns = matrix.length;
    const totalRowItems = matrix.reduce((s, col) => s + (col ? col.length : 0), 0);
    const currentEntropy = parseFloat((totalRowItems / totalColumns).toFixed(2));

    const currentDepthVector: number[] = [];
    const lookback = Math.min(4, matrix.length);
    for (let i = matrix.length - lookback; i < matrix.length; i++) {
      currentDepthVector.push(matrix[i] ? matrix[i].length : 0);
    }

    for (const arch of this.archetypeMemoryBank) {
      const entropyMatch = Math.abs(arch.entropy - currentEntropy) <= 0.15;
      const vectorMatch = JSON.stringify(arch.depthVector) === JSON.stringify(currentDepthVector);
      if (entropyMatch && vectorMatch) return arch;
    }
    return null;
  }

  private _updateMatchedMemoryPerformance(archId: string, wasCorrect: boolean): void {
    const index = this.archetypeMemoryBank.findIndex((a) => a.id === archId);
    if (index === -1) return;
    if (wasCorrect) this.archetypeMemoryBank[index].confidence++;
    else this.archetypeMemoryBank.splice(index, 1);
  }

  /** Parse the verdict string → Side | "WAIT" */
  getVerdict(): Side | "WAIT" {
    const v = this.appLastLiveVerdict;
    if (v.includes("PLAYER")) return "P";
    if (v.includes("BANKER")) return "B";
    return "WAIT";
  }

  reset(): void {
    this.history = [];
    this.metaLossStreak = 0;
    this.lockOutCounter = 0;
    this.silentFailureCountDuringLockout = 0;
    this.appLastLiveVerdict = "--";
    this.rawVerdictBeforeLockout = "--";
    this.memoryMatchActiveThisHand = null;
    this.roadTelemetry = {
      main: { totalBets: 0, hits: 0, currentLivePrediction: "--" },
      k1:   { totalBets: 0, hits: 0, currentLivePrediction: "--" },
      k2:   { totalBets: 0, hits: 0, currentLivePrediction: "--" },
      k3:   { totalBets: 0, hits: 0, currentLivePrediction: "--" },
    };
    this._initRoadAgents();
    this._init21VirtualPlayers();
    this._undoStack = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — OMNI-VORTEX ENGINE (App3Sandbox)
// ─────────────────────────────────────────────────────────────────────────────

interface OmniAgent {
  id: string;
  name: string;
  weight: number;
  lastVote: Side | "WAIT" | "--";
  matchWindow: number[]; // 5-hand rolling
}

interface App3Snap {
  history: string[];
  agentPopulation: OmniAgent[];
  globalHitStreak: number;
  globalLossStreak: number;
  appLastLiveVerdict: string;
}

class OmniVortexEngine {
  private history: string[] = [];
  private agentPopulation: OmniAgent[] = [];
  private globalHitStreak = 0;
  private globalLossStreak = 0;
  appLastLiveVerdict = "CALIBRATING";
  private _undoStack: App3Snap[] = [];

  constructor() {
    this._initAgents();
  }

  private _initAgents(): void {
    this.agentPopulation = [
      { id: "v8_KINETIC",   name: "v8 Kinetic Core",       weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "SD_MASTER",    name: "v15.3 Deployment",       weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "PC_AGGRESSIVE",name: "v10.9 Aggressive",       weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "C_FULL_DEPLOY",name: "v15.2 Main Model",       weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "ARTHOR_v3",    name: "Arthor v6.3 Engine",     weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "ARTHOR_v2",    name: "Arthor v6.2 Engine",     weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "OMNI_70_CORE", name: "Nexus Omni-70 Engine",   weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "CHROMA_CORE",  name: "Chroma Core Mobile",     weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "QUANTUM_102",  name: "Quantum v102 Engine",    weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "APEX_DUAL",    name: "Apex Dual-Core Node",    weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "SUB_AI_RECON", name: "Sub-AI Recon Matrix",    weight: 1.0, lastVote: "--", matchWindow: [] },
      { id: "VORTEX_v97",   name: "Vortex v97 Shock",       weight: 1.0, lastVote: "--", matchWindow: [] },
    ];
    for (let i = 1; i <= 17; i++) {
      this.agentPopulation.push({
        id: `AGENT_VIRT_${i}`,
        name: `Omni Cluster Node ${i}`,
        weight: 0.8,
        lastVote: "--",
        matchWindow: [],
      });
    }
  }

  private _save(): void {
    this._undoStack.push(JSON.parse(JSON.stringify({
      history: this.history,
      agentPopulation: this.agentPopulation,
      globalHitStreak: this.globalHitStreak,
      globalLossStreak: this.globalLossStreak,
      appLastLiveVerdict: this.appLastLiveVerdict,
    })) as App3Snap);
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  undoLast(): void {
    if (this._undoStack.length === 0) return;
    const prev = this._undoStack.pop()!;
    this.history = prev.history;
    this.agentPopulation = prev.agentPopulation;
    this.globalHitStreak = prev.globalHitStreak;
    this.globalLossStreak = prev.globalLossStreak;
    this.appLastLiveVerdict = prev.appLastLiveVerdict;
  }

  processInput(outcome: string): void {
    if (!outcome || outcome === "T") return;
    this._save();

    // Score agents on their previous vote
    if (this.history.length >= 1) {
      this.agentPopulation.forEach((agent) => {
        if (agent.lastVote !== "--" && agent.lastVote !== "WAIT") {
          const isHit = agent.lastVote === outcome ? 1 : 0;
          agent.matchWindow.push(isHit);
          if (agent.matchWindow.length > 5) agent.matchWindow.shift();
          const windowHits = agent.matchWindow.reduce((s, c) => s + c, 0);
          agent.weight = 0.4 + windowHits * 0.4;
        }
      });
    }

    this.history.push(outcome);
    this._runCoreMath();
  }

  private _runCoreMath(): void {
    const len = this.history.length;
    if (len < 5) {
      this.appLastLiveVerdict = "CALIBRATING";
      return;
    }

    // Big Eye Boy derived road
    const columns: string[][] = [];
    let curCol: string[] = [];
    let lastItem: string | null = null;
    this.history.forEach((item) => {
      if (lastItem && item !== lastItem) { columns.push(curCol); curCol = [item]; }
      else { curCol.push(item); }
      lastItem = item;
    });
    if (curCol.length > 0) columns.push(curCol);

    const BigEyeBoy: string[] = [];
    for (let i = 1; i < columns.length; i++) {
      for (let j = 0; j < columns[i].length; j++) {
        if (j === 0) {
          if (i >= 1 && columns[i - 1] && columns[i - 2]) {
            BigEyeBoy.push(columns[i - 1].length === columns[i - 2].length ? "R" : "B");
          }
        } else {
          if (i >= 1 && columns[i - 1] && columns[i][j - 1] !== undefined) {
            BigEyeBoy.push(columns[i][j - 1] === columns[i - 1][j] ? "R" : "B");
          }
        }
      }
    }

    const lastOutcome = this.history[len - 1] as Side;

    // Agent vote computation
    this.agentPopulation.forEach((agent) => {
      let vote: Side | "WAIT" = "WAIT";
      if (len >= 3) {
        if (agent.id === "v8_KINETIC" || agent.id === "VORTEX_v97") {
          if (BigEyeBoy.length > 0)
            vote = BigEyeBoy[BigEyeBoy.length - 1] === "R" ? lastOutcome : (lastOutcome === "P" ? "B" : "P");
        } else if (agent.id === "PC_AGGRESSIVE") {
          const pC = this.history.filter((x) => x === "P").length;
          vote = pC >= len * 0.5 ? "P" : "B";
        } else if (agent.id === "ARTHOR_v3" || agent.id === "ARTHOR_v2") {
          const tail = this.history.slice(-3).join("");
          if (tail === "PPP" || tail === "BPB") vote = "B";
          else if (tail === "BBB" || tail === "PBP") vote = "P";
          else vote = len % 2 === 0 ? "P" : "B";
        } else if (agent.id === "SD_MASTER" || agent.id === "C_FULL_DEPLOY") {
          let priceIndex = 0;
          this.history.forEach((h) => { priceIndex += h === "P" ? 1 : -1; });
          vote = priceIndex >= 0 ? "P" : "B";
        } else {
          // Generic seed-based deterministic vote for all other agents
          const seed = agent.id.charCodeAt(agent.id.length - 1) + len;
          vote = seed % 2 === 0 ? "P" : "B";
        }
      }
      agent.lastVote = vote;
    });

    // Weighted vote consensus
    let weightedP = 0, weightedB = 0;
    this.agentPopulation.forEach((agent) => {
      if (agent.lastVote === "P") weightedP += agent.weight;
      else if (agent.lastVote === "B") weightedB += agent.weight;
    });
    const finalVote: Side = weightedP >= weightedB ? "P" : "B";

    // EMA-5 market trend
    let cur = 0;
    const priceTrace: number[] = [];
    this.history.forEach((h) => { cur += h === "P" ? 1 : -1; priceTrace.push(cur); });
    const k = 2 / (5 + 1);
    const emas: number[] = [];
    for (let i = 0; i < priceTrace.length; i++) {
      emas.push(i === 0 ? priceTrace[0] : priceTrace[i] * k + emas[i - 1] * (1 - k));
    }
    const marketTrend: Side = priceTrace[priceTrace.length - 1] > emas[emas.length - 1] ? "P" : "B";

    // Stability filter: both must agree
    if (marketTrend === finalVote) {
      this.appLastLiveVerdict = finalVote === "P" ? "BUY PLAYER" : "BUY BANKER";
    } else {
      this.appLastLiveVerdict = "DIVERGENT SIGNALS // STABILITY PROTECTION ACTIVE";
    }
  }

  /** Stateless vote from a given history — used by look-ahead. */
  static computeVerdictForHistory(history: Side[]): Side | "WAIT" {
    const len = history.length;
    if (len < 5) return "WAIT";

    // Big Eye Boy
    const columns: string[][] = [];
    let curCol: string[] = [], lastItem: string | null = null;
    history.forEach((item) => {
      if (lastItem && item !== lastItem) { columns.push(curCol); curCol = [item]; }
      else { curCol.push(item); }
      lastItem = item;
    });
    if (curCol.length > 0) columns.push(curCol);

    const BigEyeBoy: string[] = [];
    for (let i = 1; i < columns.length; i++) {
      for (let j = 0; j < columns[i].length; j++) {
        if (j === 0) {
          if (columns[i - 1] && columns[i - 2])
            BigEyeBoy.push(columns[i - 1].length === columns[i - 2].length ? "R" : "B");
        } else {
          if (columns[i - 1] && columns[i][j - 1] !== undefined)
            BigEyeBoy.push(columns[i][j - 1] === columns[i - 1][j] ? "R" : "B");
        }
      }
    }

    const lastOutcome = history[len - 1];

    const agentIds = [
      "v8_KINETIC", "SD_MASTER", "PC_AGGRESSIVE", "C_FULL_DEPLOY",
      "ARTHOR_v3", "ARTHOR_v2", "OMNI_70_CORE", "CHROMA_CORE",
      "QUANTUM_102", "APEX_DUAL", "SUB_AI_RECON", "VORTEX_v97",
      ...Array.from({ length: 17 }, (_, i) => `AGENT_VIRT_${i + 1}`),
    ];

    let weightedP = 0, weightedB = 0;
    agentIds.forEach((id) => {
      const w = id.startsWith("AGENT_VIRT_") ? 0.8 : 1.0;
      let vote: Side | "WAIT" = "WAIT";
      if (len >= 3) {
        if (id === "v8_KINETIC" || id === "VORTEX_v97") {
          if (BigEyeBoy.length > 0)
            vote = BigEyeBoy[BigEyeBoy.length - 1] === "R" ? lastOutcome : (lastOutcome === "P" ? "B" : "P");
        } else if (id === "PC_AGGRESSIVE") {
          const pC = history.filter((x) => x === "P").length;
          vote = pC >= len * 0.5 ? "P" : "B";
        } else if (id === "ARTHOR_v3" || id === "ARTHOR_v2") {
          const tail = history.slice(-3).join("");
          if (tail === "PPP" || tail === "BPB") vote = "B";
          else if (tail === "BBB" || tail === "PBP") vote = "P";
          else vote = len % 2 === 0 ? "P" : "B";
        } else if (id === "SD_MASTER" || id === "C_FULL_DEPLOY") {
          let pi = 0; history.forEach((h) => { pi += h === "P" ? 1 : -1; });
          vote = pi >= 0 ? "P" : "B";
        } else {
          const seed = id.charCodeAt(id.length - 1) + len;
          vote = seed % 2 === 0 ? "P" : "B";
        }
      }
      if (vote === "P") weightedP += w;
      else if (vote === "B") weightedB += w;
    });

    const finalVote: Side = weightedP >= weightedB ? "P" : "B";

    // EMA-5
    let cur = 0;
    const pt: number[] = [];
    history.forEach((h) => { cur += h === "P" ? 1 : -1; pt.push(cur); });
    const kv = 2 / 6;
    const emas: number[] = [];
    for (let i = 0; i < pt.length; i++)
      emas.push(i === 0 ? pt[0] : pt[i] * kv + emas[i - 1] * (1 - kv));
    const trend: Side = pt[pt.length - 1] > emas[emas.length - 1] ? "P" : "B";

    return trend === finalVote ? finalVote : "WAIT";
  }

  getVerdict(): Side | "WAIT" {
    const v = this.appLastLiveVerdict;
    if (v.includes("PLAYER")) return "P";
    if (v.includes("BANKER")) return "B";
    return "WAIT";
  }

  getWeightedVotes(): { weightedP: number; weightedB: number } {
    let weightedP = 0, weightedB = 0;
    this.agentPopulation.forEach((a) => {
      if (a.lastVote === "P") weightedP += a.weight;
      else if (a.lastVote === "B") weightedB += a.weight;
    });
    return { weightedP, weightedB };
  }

  reset(): void {
    this.history = [];
    this.globalHitStreak = 0;
    this.globalLossStreak = 0;
    this.appLastLiveVerdict = "CALIBRATING";
    this._initAgents();
    this._undoStack = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — NEXUS ENGINE (public wrapper)
// ─────────────────────────────────────────────────────────────────────────────

export interface NexusSnapshot {
  apexSignal: Side | "WAIT";
  probP: number;
  probB: number;
  vol: number;
}

export class NexusEngine {
  private history: Side[] = [];
  private abacative = new AbacativeEngine();
  private omniVortex = new OmniVortexEngine();

  handleInput(value: string): void {
    const actual = value as Side;
    if (actual !== "B" && actual !== "P") return; // ignore T

    this.abacative.processInput(value);
    this.omniVortex.processInput(value);
    this.history.push(actual);
  }

  undoLast(): void {
    if (this.history.length === 0) return;
    this.abacative.undoLast();
    this.omniVortex.undoLast();
    this.history.pop();
  }

  reset(): void {
    this.history = [];
    this.abacative.reset();
    this.omniVortex.reset();
  }

  getSnapshot(): NexusSnapshot {
    const v2 = this.abacative.getVerdict();
    const v3 = this.omniVortex.getVerdict();

    // Apex: both agree → high confidence; App3 alone → moderate; fallback WAIT
    let apexSignal: Side | "WAIT";
    if (v2 !== "WAIT" && v3 !== "WAIT" && v2 === v3) apexSignal = v2;
    else if (v3 !== "WAIT") apexSignal = v3;
    else if (v2 !== "WAIT") apexSignal = v2;
    else apexSignal = "WAIT";

    // probP/probB from App3 weighted votes
    const { weightedP, weightedB } = this.omniVortex.getWeightedVotes();
    const total = weightedP + weightedB;
    const probP = total > 0 ? (weightedP / total) * 100 : 50;
    const probB = 100 - probP;

    // Volatility (chop index)
    let flipCount = 0;
    for (let i = 1; i < this.history.length; i++) {
      if (this.history[i] !== this.history[i - 1]) flipCount++;
    }
    const vol = this.history.length > 1 ? flipCount / (this.history.length - 1) : 0.5;

    return { apexSignal, probP, probB, vol };
  }

  /**
   * Pure-history snapshot for look-ahead simulation.
   * Uses OmniVortex's stateless computation — no accumulated state mutation.
   */
  static computeApexForHistory(history: Side[]): NexusSnapshot {
    const verdict = OmniVortexEngine.computeVerdictForHistory(history);

    // Stateless vote tally for probabilities
    const len = history.length;
    const agentIds = [
      "v8_KINETIC", "SD_MASTER", "PC_AGGRESSIVE", "C_FULL_DEPLOY",
      "ARTHOR_v3", "ARTHOR_v2", "OMNI_70_CORE", "CHROMA_CORE",
      "QUANTUM_102", "APEX_DUAL", "SUB_AI_RECON", "VORTEX_v97",
      ...Array.from({ length: 17 }, (_, i) => `AGENT_VIRT_${i + 1}`),
    ];

    // Re-derive Big Eye Boy for prob calculation
    const columns: string[][] = [];
    let curCol: string[] = [], lastItem: string | null = null;
    history.forEach((item) => {
      if (lastItem && item !== lastItem) { columns.push(curCol); curCol = [item]; }
      else { curCol.push(item); }
      lastItem = item;
    });
    if (curCol.length > 0) columns.push(curCol);
    const BigEyeBoy: string[] = [];
    for (let i = 1; i < columns.length; i++) {
      for (let j = 0; j < columns[i].length; j++) {
        if (j === 0) { if (columns[i - 1] && columns[i - 2]) BigEyeBoy.push(columns[i - 1].length === columns[i - 2].length ? "R" : "B"); }
        else { if (columns[i - 1] && columns[i][j - 1] !== undefined) BigEyeBoy.push(columns[i][j - 1] === columns[i - 1][j] ? "R" : "B"); }
      }
    }
    const lastOutcome = history[len - 1];

    let weightedP = 0, weightedB = 0;
    agentIds.forEach((id) => {
      const w = id.startsWith("AGENT_VIRT_") ? 0.8 : 1.0;
      let vote: Side | "WAIT" = "WAIT";
      if (len >= 3) {
        if (id === "v8_KINETIC" || id === "VORTEX_v97") { if (BigEyeBoy.length > 0) vote = BigEyeBoy[BigEyeBoy.length - 1] === "R" ? lastOutcome : (lastOutcome === "P" ? "B" : "P"); }
        else if (id === "PC_AGGRESSIVE") { const pC = history.filter((x) => x === "P").length; vote = pC >= len * 0.5 ? "P" : "B"; }
        else if (id === "ARTHOR_v3" || id === "ARTHOR_v2") { const tail = history.slice(-3).join(""); if (tail === "PPP" || tail === "BPB") vote = "B"; else if (tail === "BBB" || tail === "PBP") vote = "P"; else vote = len % 2 === 0 ? "P" : "B"; }
        else if (id === "SD_MASTER" || id === "C_FULL_DEPLOY") { let pi = 0; history.forEach((h) => { pi += h === "P" ? 1 : -1; }); vote = pi >= 0 ? "P" : "B"; }
        else { const seed = id.charCodeAt(id.length - 1) + len; vote = seed % 2 === 0 ? "P" : "B"; }
      }
      if (vote === "P") weightedP += w;
      else if (vote === "B") weightedB += w;
    });

    const total = weightedP + weightedB;
    const probP = total > 0 ? (weightedP / total) * 100 : 50;

    let flipCount = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i] !== history[i - 1]) flipCount++;
    }
    const vol = history.length > 1 ? flipCount / (history.length - 1) : 0.5;

    return { apexSignal: verdict, probP, probB: 100 - probP, vol };
  }
}
