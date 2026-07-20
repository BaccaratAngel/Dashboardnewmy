/**
 * Road Engine — ported from appB (Nexus Elite)
 * Implements BaccaratVectorEngine, Big Road generation,
 * derived road analysis (BEB/SR/CP), and the final prediction.
 */

type Side = "B" | "P";
type RoadColor = "RED" | "BLUE";

// ── BaccaratVectorEngine ─────────────────────────────────────────────────────

function generateBigRoad(history: string[]): Side[][] {
  const clean = history.filter((x): x is Side => x === "B" || x === "P");
  if (clean.length === 0) return [];
  const bigRoad: Side[][] = [[clean[0]]];
  let col = 0;
  for (let i = 1; i < clean.length; i++) {
    const outcome = clean[i];
    if (outcome === bigRoad[col][0]) {
      bigRoad[col].push(outcome);
    } else {
      bigRoad.push([outcome]);
      col++;
    }
  }
  return bigRoad;
}

function evaluateRoadColor(bigRoad: Side[][], X: number): RoadColor | null {
  const colIdx = bigRoad.length - 1;
  if (colIdx < X) return null;
  const currentCol = bigRoad[colIdx];
  const rowIdx = currentCol.length - 1;
  if (rowIdx === 0) {
    const prevColLen = bigRoad[colIdx - 1].length;
    const targetColLen = bigRoad[colIdx - 1 - X]?.length ?? 0;
    return prevColLen === targetColLen ? "RED" : "BLUE";
  }
  const targetCol = bigRoad[colIdx - X];
  if (targetCol?.[rowIdx] !== undefined) {
    return "RED";
  }
  const cellAboveExists = targetCol?.[rowIdx - 1] !== undefined;
  return !cellAboveExists ? "RED" : "BLUE";
}

function interpretRoadCreativePattern(roadHistory: RoadColor[]): RoadColor | null {
  if (roadHistory.length === 0) return null;
  const columns: { color: RoadColor; height: number }[] = [];
  let current: { color: RoadColor; height: number } = { color: roadHistory[0], height: 1 };
  for (let i = 1; i < roadHistory.length; i++) {
    if (roadHistory[i] === current.color) {
      current.height++;
    } else {
      columns.push(current);
      current = { color: roadHistory[i], height: 1 };
    }
  }
  columns.push(current);

  const n = columns.length;
  const last = columns[n - 1];

  if (n >= 3) {
    let singletons = 0;
    if (columns[n - 1].height === 1) singletons++;
    if (columns[n - 2].height === 1) singletons++;
    if (columns[n - 3].height === 1) singletons++;
    if (singletons >= 2) return last.color === "RED" ? "BLUE" : "RED";
  }
  if (n >= 2) {
    const prev = columns[n - 2];
    if (last.height >= prev.height) return last.color === "RED" ? "BLUE" : "RED";
  }
  if (n >= 4) {
    if (
      columns[n - 2].height === columns[n - 4].height &&
      last.height < columns[n - 3].height
    ) {
      return last.color;
    }
  }
  return last.color === "RED" ? "BLUE" : "RED";
}

function generateHistoricalDerivedArray(cleanHistory: string[], offset: number): RoadColor[] {
  const outputs: RoadColor[] = [];
  for (let i = 1; i <= cleanHistory.length; i++) {
    const slice = cleanHistory.slice(0, i);
    const br = generateBigRoad(slice);
    const color = evaluateRoadColor(br, offset);
    if (color) outputs.push(color);
  }
  return outputs;
}

// ── Engine pool (simplified Nexus Elite engines) ─────────────────────────────

interface ShoeEngine {
  id: number;
  strategy: number;
  memoryDepth: number;
  nextPred: Side;
  lastPred: Side | null;
  globalScore: number;
  recent4Acc: number;
  recentHistory: number[];
}

function createEngines(): ShoeEngine[] {
  const pool: ShoeEngine[] = [];
  for (let i = 0; i < 1000; i++) {
    pool.push({
      id: i,
      strategy: i % 7,
      memoryDepth: (i % 5) + 1,
      nextPred: "B",
      lastPred: null,
      globalScore: 0,
      recent4Acc: 0,
      recentHistory: [],
    });
  }
  return pool;
}

function getEnginePrediction(e: ShoeEngine, nonTies: string[]): Side {
  if (nonTies.length < e.memoryDepth) return nonTies.length % 2 === 0 ? "B" : "P";
  const last = nonTies[nonTies.length - 1] as Side;
  const strategy = e.strategy;
  if (strategy === 0 || strategy === 1) {
    const target = nonTies.slice(-e.memoryDepth).join("");
    const full = nonTies.join("");
    const idx = full.lastIndexOf(target, full.length - target.length - 1);
    let pred: Side = last;
    if (idx !== -1 && idx + target.length < full.length) {
      pred = full[idx + target.length] as Side;
    }
    return strategy === 1 ? (pred === "B" ? "P" : "B") : pred;
  }
  if (strategy === 2) return last === "B" ? "P" : "B";
  if (strategy === 3) {
    const prev = nonTies.length > 1 ? nonTies[nonTies.length - 2] as Side : null;
    return last === prev ? (last === "B" ? "P" : "B") : last;
  }
  if (strategy === 4) {
    const prev = nonTies.length > 1 ? nonTies[nonTies.length - 2] as Side : null;
    return last === "B" && prev !== "B" ? "B" : last;
  }
  if (strategy === 5) return last === "B" ? "P" : "B";
  if (strategy === 6) return (nonTies[nonTies.length - 2] ?? last) as Side;
  return "B";
}

// ── Road snapshot type ────────────────────────────────────────────────────────

export interface RoadSnapshot {
  nextPrediction: Side | "WAIT";
  beb: Side | "NEUTRAL";
  sr: Side | "NEUTRAL";
  cp: Side | "NEUTRAL";
  consensus: Side | "NEUTRAL";
  volatility: number;
}

// ── RoadEngine class ─────────────────────────────────────────────────────────

interface RoadState {
  shoe: string[];
  engines: ShoeEngine[];
  derivedRoadTracker: {
    beb: { hits: number; total: number; lastPrediction: Side | "NEUTRAL" | null };
    sr: { hits: number; total: number; lastPrediction: Side | "NEUTRAL" | null };
    cp: { hits: number; total: number; lastPrediction: Side | "NEUTRAL" | null };
  };
  showdownTrustedParty: "ENGINES" | "DERIVED" | null;
}

interface RoadHistory {
  state: RoadState;
}

export class RoadEngine {
  private state: RoadState;
  private _history: RoadHistory[] = [];

  constructor() {
    this.state = this._fresh();
  }

  private _fresh(): RoadState {
    return {
      shoe: [],
      engines: createEngines(),
      derivedRoadTracker: {
        beb: { hits: 0, total: 0, lastPrediction: null },
        sr: { hits: 0, total: 0, lastPrediction: null },
        cp: { hits: 0, total: 0, lastPrediction: null },
      },
      showdownTrustedParty: null,
    };
  }

  private _cloneState(): RoadState {
    return JSON.parse(JSON.stringify(this.state)) as RoadState;
  }

  private _gradeEngines(actual: Side): void {
    const { engines, shoe } = this.state;
    const nonTies = shoe.filter((x) => x !== "T");
    engines.forEach((e) => {
      if (e.lastPred !== null) {
        const win = e.lastPred === actual ? 1 : 0;
        e.globalScore += win;
        e.recentHistory.push(win);
        if (e.recentHistory.length > 4) e.recentHistory.shift();
        e.recent4Acc =
          e.recentHistory.filter((x) => x === 1).length /
          e.recentHistory.length;
      }
      e.lastPred = getEnginePrediction(e, nonTies);
    });
  }

  handleInput(value: string): void {
    this._history.push({ state: this._cloneState() });
    if (this._history.length > 200) this._history.shift();

    const prev = { ...this.state.derivedRoadTracker };
    const s = this.state;

    // Grade engines on actual outcome (if not a tie)
    if ((value === "B" || value === "P") && s.shoe.length > 0) {
      this._gradeEngines(value as Side);
    }

    // Grade derived road accuracy
    if (value === "B" || value === "P") {
      const keys = ["beb", "sr", "cp"] as const;
      keys.forEach((key) => {
        const tracker = s.derivedRoadTracker[key];
        if (tracker.lastPrediction && tracker.lastPrediction !== "NEUTRAL") {
          tracker.total++;
          if (tracker.lastPrediction === value) tracker.hits++;
        }
      });
    }

    s.shoe.push(value);

    // Update engine predictions
    const nonTies = s.shoe.filter((x) => x !== "T");
    s.engines.forEach((e) => {
      e.nextPred = getEnginePrediction(e, nonTies);
    });

    // Compute current derived road predictions
    const snap = this._computeSnapshot();
    s.derivedRoadTracker.beb.lastPrediction = snap.beb;
    s.derivedRoadTracker.sr.lastPrediction = snap.sr;
    s.derivedRoadTracker.cp.lastPrediction = snap.cp;

    void prev;
  }

  undoLast(): void {
    if (this._history.length === 0) return;
    const prev = this._history.pop()!;
    this.state = prev.state;
  }

  reset(): void {
    this._history = [];
    this.state = this._fresh();
  }

  private _computeSnapshot(): RoadSnapshot {
    const { shoe, engines } = this.state;
    const nonTies = shoe.filter((x): x is Side => x === "B" || x === "P");

    // Engine consensus
    const sorted = [...engines].sort((a, b) => {
      if (b.recent4Acc !== a.recent4Acc) return b.recent4Acc - a.recent4Acc;
      return (b.globalScore / (shoe.length || 1)) - (a.globalScore / (shoe.length || 1));
    });
    const topEngines = sorted.slice(0, 15);
    const mathVotes = { B: 0, P: 0 };
    topEngines.forEach((e, i) => {
      const key = e.nextPred as "B" | "P";
      mathVotes[key] += 15 - i;
    });
    const engineFinal: Side = mathVotes.B > mathVotes.P ? "B" : "P";

    // Derived roads
    const brB = generateBigRoad([...nonTies, "B"]);
    const brP = generateBigRoad([...nonTies, "P"]);
    const simB = { be: evaluateRoadColor(brB, 1), sr: evaluateRoadColor(brB, 2), cp: evaluateRoadColor(brB, 3) };
    const simP = { be: evaluateRoadColor(brP, 1), sr: evaluateRoadColor(brP, 2), cp: evaluateRoadColor(brP, 3) };

    const bebHist = generateHistoricalDerivedArray(nonTies, 1);
    const srHist = generateHistoricalDerivedArray(nonTies, 2);
    const cpHist = generateHistoricalDerivedArray(nonTies, 3);

    const tgt = {
      beb: interpretRoadCreativePattern(bebHist),
      sr: interpretRoadCreativePattern(srHist),
      cp: interpretRoadCreativePattern(cpHist),
    };

    function roadPred(simBColor: RoadColor | null, simPColor: RoadColor | null, target: RoadColor | null): Side | "NEUTRAL" {
      if (!target) return "NEUTRAL";
      if (simBColor === target && simPColor !== target) return "B";
      if (simPColor === target && simBColor !== target) return "P";
      return "NEUTRAL";
    }

    const beb = roadPred(simB.be, simP.be, tgt.beb);
    const sr = roadPred(simB.sr, simP.sr, tgt.sr);
    const cp = roadPred(simB.cp, simP.cp, tgt.cp);

    const votes = { B: 0, P: 0 };
    if (beb === "B") votes.B++; else if (beb === "P") votes.P++;
    if (sr === "B") votes.B++; else if (sr === "P") votes.P++;
    if (cp === "B") votes.B++; else if (cp === "P") votes.P++;
    let metaConsensus: Side | "NEUTRAL" = "NEUTRAL";
    if (votes.B >= 2) metaConsensus = "B";
    else if (votes.P >= 2) metaConsensus = "P";

    // Dragon (streak) and ping-pong override
    let finalAction: Side | "WAIT" = engineFinal;
    if (nonTies.length >= 3) {
      const last3 = nonTies.slice(-3);
      if (last3.every((x) => x === last3[0])) finalAction = last3[0];
    }
    if (nonTies.length >= 4) {
      const l4 = nonTies.slice(-4);
      if (
        l4[0] !== l4[1] && l4[1] !== l4[2] && l4[2] !== l4[3] &&
        l4[0] === l4[2] && l4[1] === l4[3]
      ) {
        finalAction = l4[3] === "B" ? "P" : "B";
      }
    }

    // Meta override
    if (metaConsensus !== "NEUTRAL") finalAction = metaConsensus;

    // Volatility index
    const cols = generateBigRoad(shoe);
    let volatility = 0;
    if (cols.length >= 4) {
      const scope = cols.slice(-6);
      volatility = Math.round((scope.filter((c) => c.length === 1).length / scope.length) * 100);
    }

    return { nextPrediction: nonTies.length >= 6 ? finalAction : "WAIT", beb, sr, cp, consensus: metaConsensus, volatility };
  }

  getSnapshot(): RoadSnapshot {
    return this._computeSnapshot();
  }
}
