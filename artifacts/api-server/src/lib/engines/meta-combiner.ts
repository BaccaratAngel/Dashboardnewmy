/**
 * MetaCombiner — Online learned meta-layer that combines all sub-system outputs.
 *
 * Unlike MetaAI (which learns from raw road/nexus signals), this model learns
 * from the *decisions* of every other AI system in the stack. It discovers
 * which combinations of systems are actually reliable for the current shoe
 * rather than using fixed hand-written weights.
 *
 * Feature vector (22 dimensions):
 *   [0]  bias
 *   [1]  MetaAI pPlayer centered (×2 −1)
 *   [2]  Observer decision ±1
 *   [3]  Observer WR centered (×2 −1, 0 if unknown)
 *   [4]  LookAhead v1 verdict ±1
 *   [5]  LookAhead v1 bias (clamped −1..1)
 *   [6]  LookAhead v2 verdict ±1
 *   [7]  LookAhead v2 bias (clamped −1..1)
 *   [8]  Crisis AI prediction ±1 (0 = no prediction)
 *   [9]  Crisis AI active flag 0/1
 *   [10] Crisis AI confidence 0/0.5/1
 *   [11] Ensemble verdict ±1
 *   [12] Ensemble percent centered (÷50 −1)
 *   [13] Regime dominant decision ±1
 *   [14] Shadow leader prediction ±1
 *   [15] Volatility index 0..1
 *   [16] Convergence score −1..1 (weighted majority vote across all above)
 *   [17] MetaAI × Observer interaction
 *   [18] LookAhead v1 × LookAhead v2 interaction
 *   [19] Crisis × Ensemble interaction
 *   [20] Regime × MetaAI interaction
 *   [21] Convergence × Ensemble interaction
 */

type Side = "B" | "P";

// ── Public types ──────────────────────────────────────────────────────────────

export interface MetaCombinerInput {
  /** MetaAI raw 0-1 probability for Player */
  metaAIPPlayer: number;
  /** Observer current decision */
  observerDecision: Side | "WAIT" | null;
  /** Observer best sub-system win rate (null if not enough data) */
  observerWR: number | null;
  /** LookAhead v1 verdict */
  lookAhead1Verdict: Side | null;
  /** LookAhead v1 bias score (raw, any range) */
  lookAhead1Bias: number;
  /** LookAhead v2 verdict */
  lookAhead2Verdict: Side | null;
  /** LookAhead v2 bias score (raw, any range) */
  lookAhead2Bias: number;
  /** Crisis AI panel prediction (null = WAIT / not active) */
  crisisPrediction: Side | null;
  /** Whether Crisis AI panel is currently active */
  crisisActive: boolean;
  /** Crisis AI confidence level */
  crisisConfidence: "LOW" | "MED" | "HIGH";
  /** Regime ensemble verdict */
  ensembleVerdict: Side | null;
  /** Regime ensemble vote percentage */
  ensemblePercent: number;
  /** Regime dominant expert decision */
  regimeDecision: Side | null;
  /** Shadow leader prediction */
  shadowLeaderPred: Side | null;
  /** Shoe volatility index 0-1 */
  volatilityIndex: number;
}

export interface MetaCombinerResult {
  /** Final combined prediction. "WAIT" when model is cold or margin is too thin */
  prediction: Side | "WAIT";
  /** Raw 0-1 P(Player) from the logistic regression */
  pPlayer: number;
  /** Confidence tier based on margin */
  confidence: "LOW" | "MED" | "HIGH";
  /** Rolling recent accuracy (last 20 hands), null while warming up */
  recentAccuracy: number | null;
  /** Total hands the model has learned from */
  seen: number;
  /** Which sub-systems drove this call (top contributing features) */
  topFactors: string[];
  /** How many of the 7 core systems are currently agreeing on the same side */
  convergenceCount: number;
  /** Total core systems with a non-null prediction */
  convergenceTotal: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const FEATURE_NAMES = [
  "bias",
  "MetaAI_pPlayer",
  "Observer_decision",
  "Observer_WR",
  "LookAhead1_verdict",
  "LookAhead1_bias",
  "LookAhead2_verdict",
  "LookAhead2_bias",
  "Crisis_prediction",
  "Crisis_active",
  "Crisis_confidence",
  "Ensemble_verdict",
  "Ensemble_pct",
  "Regime_decision",
  "Shadow_pred",
  "Volatility",
  "Convergence",
  "MetaAI×Observer",
  "LookAhead1×2",
  "Crisis×Ensemble",
  "Regime×MetaAI",
  "Conv×Ensemble",
];

const DIM = FEATURE_NAMES.length; // 22

function normPB(val: Side | "WAIT" | null | undefined): number {
  if (val === "P") return 1;
  if (val === "B") return -1;
  return 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function confScore(c: "LOW" | "MED" | "HIGH"): number {
  return c === "HIGH" ? 1 : c === "MED" ? 0.5 : 0;
}

// ── Feature builder ───────────────────────────────────────────────────────────

export function buildMetaCombinerFeatures(inp: MetaCombinerInput): number[] {
  const metaC = clamp((inp.metaAIPPlayer - 0.5) * 2, -1, 1);
  const obsD = normPB(inp.observerDecision);
  const obsWR = inp.observerWR !== null ? clamp((inp.observerWR - 0.5) * 2, -1, 1) : 0;
  const la1V = normPB(inp.lookAhead1Verdict);
  const la1B = clamp(inp.lookAhead1Bias * 10, -1, 1); // bias is typically small
  const la2V = normPB(inp.lookAhead2Verdict);
  const la2B = clamp(inp.lookAhead2Bias * 10, -1, 1);
  const crisisP = normPB(inp.crisisPrediction);
  const crisisA = inp.crisisActive ? 1 : 0;
  const crisisC = confScore(inp.crisisConfidence);
  const ensV = normPB(inp.ensembleVerdict);
  const ensPct = clamp((inp.ensemblePercent - 50) / 50, -1, 1);
  const regD = normPB(inp.regimeDecision);
  const shadowP = normPB(inp.shadowLeaderPred);
  const vol = clamp(inp.volatilityIndex, 0, 1);

  // Convergence: weighted vote across 7 independent signals
  const votes = [metaC, obsD, la1V, la2V, crisisP * crisisA, ensV, regD];
  const activeVotes = votes.filter((v) => v !== 0);
  const convergence =
    activeVotes.length > 0
      ? activeVotes.reduce((s, v) => s + v, 0) / activeVotes.length
      : 0;

  const x: number[] = [
    1,              // [0]  bias
    metaC,          // [1]
    obsD,           // [2]
    obsWR,          // [3]
    la1V,           // [4]
    la1B,           // [5]
    la2V,           // [6]
    la2B,           // [7]
    crisisP,        // [8]
    crisisA,        // [9]
    crisisC,        // [10]
    ensV,           // [11]
    ensPct,         // [12]
    regD,           // [13]
    shadowP,        // [14]
    vol,            // [15]
    convergence,    // [16]
    metaC * obsD,   // [17] MetaAI × Observer
    la1V * la2V,    // [18] LookAhead1 × 2
    crisisP * ensV, // [19] Crisis × Ensemble
    regD * metaC,   // [20] Regime × MetaAI
    convergence * ensV, // [21] Conv × Ensemble
  ];

  return x;
}

// ── MetaCombiner class ────────────────────────────────────────────────────────

/** Minimum hands with a non-Tie outcome before the model will issue predictions */
const MIN_HANDS_BEFORE_PREDICT = 8;
/** Margin below which the model abstains (outputs WAIT) */
const ABSTAIN_MARGIN = 0.06; // |pPlayer − 0.5| < 0.06 → WAIT

export class MetaCombiner {
  private w: number[] = new Array(DIM).fill(0);
  private samples: { x: number[]; y: 0 | 1 }[] = [];
  private stats = { seen: 0, correct: 0 };
  private recent: number[] = []; // rolling 20-hand correctness
  private readonly lr = 0.05;
  private readonly l2 = 0.002;

  // Pending feature vector — set in capture(), consumed in onLabeled()
  private _pendingX: number[] | null = null;
  // Last prediction for undo support
  private _undoStack: {
    w: number[];
    samples: { x: number[]; y: 0 | 1 }[];
    stats: { seen: number; correct: number };
    recent: number[];
    pendingX: number[] | null;
  }[] = [];

  // ── Internals ─────────────────────────────────────────────────────────────

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-clamp(z, -30, 30)));
  }

  private dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      s += (isFinite(a[i]) ? a[i] : 0) * (isFinite(b[i]) ? b[i] : 0);
    }
    return isFinite(s) ? s : 0;
  }

  private predictProba(x: number[]): number {
    return this.sigmoid(this.dot(this.w, x));
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

  private _topFactors(x: number[], prediction: Side | "WAIT"): string[] {
    // Compute weighted contributions (w[i] × x[i]) for non-bias features
    const contribs: { name: string; contrib: number }[] = [];
    for (let i = 1; i < Math.min(this.w.length, x.length); i++) {
      const c = (isFinite(this.w[i]) ? this.w[i] : 0) * (isFinite(x[i]) ? x[i] : 0);
      if (c !== 0) contribs.push({ name: FEATURE_NAMES[i] ?? `f${i}`, contrib: c });
    }
    // Sort by absolute magnitude, take top 3 that push toward the prediction
    const sign = prediction === "P" ? 1 : -1;
    return contribs
      .filter((c) => c.contrib * sign > 0)
      .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib))
      .slice(0, 3)
      .map((c) => c.name.replace(/_/g, " ").replace(/×/, "×"));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Store the feature vector for the current hand. Must be called BEFORE
   * onLabeled() — typically at the same time as you compute the prediction.
   */
  captureFeatures(inp: MetaCombinerInput): MetaCombinerResult {
    const x = buildMetaCombinerFeatures(inp);
    this._pendingX = x;

    const pPlayer = this.predictProba(x);
    const margin = Math.abs(pPlayer - 0.5);
    const isWarm = this.stats.seen >= MIN_HANDS_BEFORE_PREDICT;

    let prediction: Side | "WAIT";
    if (!isWarm || margin < ABSTAIN_MARGIN) {
      prediction = "WAIT";
    } else {
      prediction = pPlayer >= 0.5 ? "P" : "B";
    }

    const confidence: "LOW" | "MED" | "HIGH" =
      margin >= 0.18 ? "HIGH" : margin >= 0.10 ? "MED" : "LOW";

    // Convergence count for display
    const votes = [
      normPB(inp.observerDecision !== "WAIT" ? inp.observerDecision : null),
      normPB(inp.lookAhead1Verdict),
      normPB(inp.lookAhead2Verdict),
      normPB(inp.crisisActive ? inp.crisisPrediction : null),
      normPB(inp.ensembleVerdict),
      normPB(inp.regimeDecision),
      clamp((inp.metaAIPPlayer - 0.5) * 2, -1, 1),
    ];
    const activeVotes = votes.filter((v) => v !== 0);
    const majority = activeVotes.length > 0
      ? activeVotes.reduce((s, v) => s + v, 0) / activeVotes.length
      : 0;
    const majoritySign = majority >= 0 ? 1 : -1;
    const convergenceCount = activeVotes.filter((v) => v * majoritySign > 0).length;

    return {
      prediction,
      pPlayer,
      confidence,
      recentAccuracy: this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : null,
      seen: this.stats.seen,
      topFactors: prediction !== "WAIT" ? this._topFactors(x, prediction) : [],
      convergenceCount,
      convergenceTotal: activeVotes.length,
    };
  }

  /**
   * Score the previous prediction against the actual outcome.
   * Call once per hand, after the outcome is known.
   */
  onLabeled(actual: Side): void {
    const x = this._pendingX;
    if (!x) return;
    const y: 0 | 1 = actual === "P" ? 1 : 0;
    const pred = this.predictProba(x) >= 0.5 ? "P" : "B";
    this.stats.seen++;
    if (pred === actual) this.stats.correct++;
    this.recent.push(pred === actual ? 1 : 0);
    if (this.recent.length > 20) this.recent.shift();
    this.samples.push({ x: [...x], y });
    if (this.samples.length > 500) this.samples.shift();
    this.learnOne(x, y);
  }

  /** Undo the last hand — rebuilds weights from sample history */
  undoLast(): void {
    const prev = this._undoStack.pop();
    if (!prev) return;
    this.w = [...prev.w];
    this.samples = prev.samples.map((s) => ({ ...s, x: [...s.x] }));
    this.stats = { ...prev.stats };
    this.recent = [...prev.recent];
    this._pendingX = prev.pendingX ? [...prev.pendingX] : null;
  }

  /** Save state before processing a hand (call at start of handleInput) */
  saveState(): void {
    this._undoStack.push({
      w: [...this.w],
      samples: this.samples.map((s) => ({ ...s, x: [...s.x] })),
      stats: { ...this.stats },
      recent: [...this.recent],
      pendingX: this._pendingX ? [...this._pendingX] : null,
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  reset(): void {
    this.w = new Array(DIM).fill(0);
    this.samples = [];
    this.stats = { seen: 0, correct: 0 };
    this.recent = [];
    this._pendingX = null;
    this._undoStack = [];
  }

  getStats() {
    return { ...this.stats };
  }
}
