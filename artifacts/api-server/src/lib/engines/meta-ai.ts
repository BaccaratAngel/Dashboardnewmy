/**
 * MetaAI — Online logistic-regression perceptron.
 * Ported faithfully from app.html MetaAI.
 *
 * Feature vector built from signals available server-side:
 *   nexus apex, road BEB/SR/CP, derived consensus, volatility,
 *   probability diff, history recency, markov, count bias.
 */

import type { RoadSnapshot } from "./road.js";
import type { NexusSnapshot } from "./nexus.js";

export const META_AI_DIM = 18;

// ── Helpers ──────────────────────────────────────────────────────────────────

function normPB(val: string | null | undefined): number {
  if (val === "P") return 1;
  if (val === "B") return -1;
  return 0;
}

function activeMean(sigs: number[]): number {
  const active = sigs.filter((s) => s !== 0);
  if (active.length === 0) return 0;
  return active.reduce((a, b) => a + b, 0) / active.length;
}

// ── Feature building ─────────────────────────────────────────────────────────

export interface MetaFeaturePacket {
  x: number[];
  meta: {
    apexSignal: number;
    roadFinalSignal: number;
    bebSignal: number;
    srSignal: number;
    cpSignal: number;
    vol: number;
    probDiff: number;
    coreTransMean: number;
    countBias: number;
  };
}

export function buildMetaFeatures(
  roadSnap: RoadSnapshot,
  nexusSnap: NexusSnapshot,
  history: string[],
  markovPred: string
): MetaFeaturePacket {
  const BOOST_APEX = 2.0;
  const BOOST_DERIVED = 2.0;

  const apexSignal = normPB(nexusSnap.apexSignal) * BOOST_APEX;
  const roadFinalSignal = normPB(roadSnap.nextPrediction);
  const bebSignal = normPB(roadSnap.beb) * BOOST_DERIVED;
  const srSignal = normPB(roadSnap.sr) * BOOST_DERIVED;
  const cpSignal = normPB(roadSnap.cp) * BOOST_DERIVED;
  const consensusSignal = normPB(roadSnap.consensus);

  const nonTies = history.filter((h) => h === "P" || h === "B");
  const cntP = nonTies.filter((h) => h === "P").length;
  const cntB = nonTies.filter((h) => h === "B").length;
  const total = Math.max(1, cntP + cntB);
  const countBias = (cntP - cntB) / total;

  // Last 4 outcomes as ±1 features (most-recent first), padded with 0
  const rawLast4 = nonTies.slice(-4).reverse().map((h) => (h === "P" ? 1 : -1) as number);
  while (rawLast4.length < 4) rawLast4.push(0);
  const [l1, l2, l3, l4] = rawLast4;

  const vol = nexusSnap.vol; // 0-1
  const probDiff = (nexusSnap.probP - nexusSnap.probB) / 100;

  const coreTransMean = activeMean([apexSignal, bebSignal, srSignal, cpSignal]);
  const markovNorm = normPB(markovPred);

  const x = [
    1, // [0]  bias
    apexSignal, // [1]  nexus APEX (boosted ×2)
    roadFinalSignal, // [2]  road final prediction
    bebSignal, // [3]  BEB derived road (boosted ×2)
    srSignal, // [4]  SR derived road (boosted ×2)
    cpSignal, // [5]  CP derived road (boosted ×2)
    consensusSignal, // [6]  derived roads consensus
    vol, // [7]  volatility (chop index)
    probDiff, // [8]  nexus P-B probability diff
    coreTransMean, // [9]  core transition composite
    countBias, // [10] P vs B count bias in history
    l1, // [11] last outcome
    l2, // [12] 2nd last outcome
    l3, // [13] 3rd last outcome
    l4, // [14] 4th last outcome
    markovNorm, // [15] short-markov prediction
    roadFinalSignal * apexSignal, // [16] apex×road interaction
    bebSignal * srSignal, // [17] derived roads interaction
  ];

  return {
    x,
    meta: {
      apexSignal,
      roadFinalSignal,
      bebSignal,
      srSignal,
      cpSignal,
      vol,
      probDiff,
      coreTransMean,
      countBias,
    },
  };
}

// ── MetaAI class ─────────────────────────────────────────────────────────────

export class MetaAI {
  private w: number[];
  private samples: { x: number[]; y: 0 | 1 }[] = [];
  private stats = { seen: 0, correct: 0 };
  private recent: number[] = []; // rolling last-20 correctness
  private readonly lr = 0.08;
  private readonly l2 = 0.001;
  revision = 0;

  constructor(dim: number = META_AI_DIM) {
    this.w = new Array(dim).fill(0);
  }

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-z));
  }

  private dot(a: number[], b: number[]): number {
    let s = 0;
    const max = Math.min(a.length, b.length);
    for (let i = 0; i < max; i++) {
      s += (isFinite(a[i]) ? a[i] : 0) * (isFinite(b[i]) ? b[i] : 0);
    }
    return isFinite(s) ? s : 0;
  }

  predictProba(x: number[]): number {
    return this.sigmoid(this.dot(this.w, x));
  }

  predict(x: number[]): { pPlayer: number; decision: "P" | "B" } {
    const p = this.predictProba(x);
    return { pPlayer: p, decision: p >= 0.5 ? "P" : "B" };
  }

  /** Used by look-ahead: partial dot up to min(x.len, w.len) then sigmoid */
  predictPartial(x: number[]): { pPlayer: number; decision: "P" | "B" } {
    let z = 0;
    const max = Math.min(x.length, this.w.length);
    for (let i = 0; i < max; i++) z += (isFinite(x[i]) ? x[i] : 0) * (isFinite(this.w[i]) ? this.w[i] : 0);
    const p = this.sigmoid(z);
    return { pPlayer: p, decision: p >= 0.5 ? "P" : "B" };
  }

  private learnOne(x: number[], y: 0 | 1): void {
    const p = this.predictProba(x);
    const err = p - y;
    for (let i = 0; i < this.w.length; i++) {
      const xi = isFinite(x[i]) ? x[i] : 0;
      const wi = isFinite(this.w[i]) ? this.w[i] : 0;
      this.w[i] -= this.lr * (err * xi + this.l2 * wi);
    }
  }

  /** Call after each hand resolves to update the perceptron */
  onLabeled(x: number[], actual: "P" | "B"): void {
    const y: 0 | 1 = actual === "P" ? 1 : 0;
    const predNow = this.predict(x).decision;
    this.stats.seen++;
    if (predNow === actual) this.stats.correct++;
    this.recent.push(predNow === actual ? 1 : 0);
    if (this.recent.length > 20) this.recent.shift();
    this.samples.push({ x: [...x], y });
    if (this.samples.length > 500) this.samples.shift();
    this.learnOne(x, y);
    this.revision++;
  }

  undoLast(): void {
    if (this.samples.length === 0) return;
    this.samples.pop();
    this.stats = { seen: 0, correct: 0 };
    this.recent = [];
    this.w.fill(0);
    for (const s of this.samples) {
      const pred = this.predict(s.x).decision;
      this.stats.seen++;
      const actual = s.y === 1 ? "P" : "B";
      if (pred === actual) this.stats.correct++;
      this.recent.push(pred === actual ? 1 : 0);
      if (this.recent.length > 20) this.recent.shift();
      this.learnOne(s.x, s.y);
    }
    this.revision++;
  }

  reset(): void {
    this.samples = [];
    this.stats = { seen: 0, correct: 0 };
    this.recent = [];
    this.w.fill(0);
    this.revision++;
  }

  getRecentAccuracy(): number | null {
    if (!this.recent.length) return null;
    return this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
  }

  getStats() {
    return { ...this.stats };
  }
}
