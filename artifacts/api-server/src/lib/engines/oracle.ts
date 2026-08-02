/**
 * OracleAI — Final Prediction Synthesizer
 *
 * Synthesizes exactly 4 signals the user sees and trusts:
 *   1. Main Prediction   — regime.decision (the main bottom call)
 *   2. Ensemble Vote     — regime.ensembleVerdict (all experts voting)
 *   3. Crisis AI         — active override if triggered, background otherwise
 *   4. Meta Combiner     — online LR that already synthesizes sub-engines
 *
 * Each signal casts a directional vote (P / B / abstain). Votes are
 * weighted by signal reliability, then summed into a netScore.
 * WAIT is chosen when bankroll protection kicks in, signals split,
 * or confidence is too low.
 *
 * ADAPTIVE MODE: OracleSignalTracker tracks per-signal rolling accuracy
 * over the last 15 hands and flexes weights dynamically via multiplier
 * formula: 0.5 + accuracy (0%→0.5×, 50%→1.0×, 100%→1.5×).
 * Requires ≥5 samples per signal before activating; otherwise neutral (1.0×).
 */

type Side = "B" | "P";

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface OracleInput {
  handCount: number;
  consecutiveLosses: number;  // from CrisisAI — used for bankroll WAIT override

  // Signal 1 — Main Prediction (regime.decision)
  regimeDecision: string | null;         // "P" | "B" | null

  // Signal 2 — Ensemble Vote (regime.ensembleVerdict)
  ensembleVerdict: string | null;        // "P" | "B" | null
  ensemblePercent: number;               // 0-100, how lopsided the vote is

  // Signal 3 — Crisis AI
  crisisActive: boolean;
  crisisPrediction: string | null;       // active prediction (null when standby)
  crisisBackgroundPrediction: string | null; // always-on background prediction
  crisisConfidence: string;              // "LOW" | "MED" | "HIGH"

  // Signal 4 — Meta Combiner
  mcPrediction: string;                  // "P" | "B" | "WAIT"
  mcConfidence: string;                  // "LOW" | "MED" | "HIGH"
  mcRecentAccuracy: number | null;       // 0-1, recent rolling accuracy
}

// ── Per-signal accuracy stat (exposed in adaptive mode) ────────────────────

export interface OracleSignalStats {
  key: string;
  label: string;
  /** Hands scored (max WINDOW=15) */
  samples: number;
  /** Rolling accuracy 0-1, null if fewer than MIN_SAMPLES=5 */
  accuracy: number | null;
  /** Weight multiplier applied: 0.5 + accuracy (1.0 when insufficient data) */
  multiplier: number;
  /** Base weight before adaptive scaling */
  baseWeight: number;
  /** Effective weight = base × multiplier */
  effectiveWeight: number;
}

// ── Output ────────────────────────────────────────────────────────────────────

export interface OracleResult {
  /** Final call: "P", "B", or "WAIT" */
  verdict: string;
  /** Confidence tier: "LOW" | "MED" | "HIGH" */
  confidence: string;
  /** Weighted directional net score. Positive = Player lean, negative = Banker lean. */
  netScore: number;
  /** How many of the active signals agree with the verdict direction */
  agreementCount: number;
  /** Total active signals (non-null, non-WAIT) this hand */
  totalSignals: number;
  /** True when Meta Combiner (the most reliable signal) aligns with the verdict */
  championAligned: boolean;
  /** True when 3 or more signals agree on the same side */
  consensusPulse: boolean;
  /** If verdict is WAIT, explains why */
  waitReason: string | null;
  /** Up to 4 key contributing factors for the verdict */
  topReasons: string[];
  /** True when adaptive weight multipliers are active */
  adaptive: boolean;
  /** Per-signal rolling accuracy stats (populated when adaptive=true) */
  signalStats: OracleSignalStats[];
}

// ── Adaptive Signal Tracker ────────────────────────────────────────────────────

const TRACKER_WINDOW    = 15;
const TRACKER_MIN_SAMP  = 5;

/** Keys matching the 4 Oracle signals */
const SIGNAL_KEYS = ["main", "ensemble", "crisis", "metaCombiner"] as const;
type SignalKey = typeof SIGNAL_KEYS[number];

export class OracleSignalTracker {
  // Rolling boolean arrays: true = correct prediction that hand
  private history: Map<SignalKey, boolean[]> = new Map(
    SIGNAL_KEYS.map((k) => [k, []] as [SignalKey, boolean[]])
  );

  // Predictions captured at end of last _captureNewPredictions (for next scoring)
  private pending: { main: string | null; ensemble: string | null; crisis: string | null; metaCombiner: string | null } = {
    main: null, ensemble: null, crisis: null, metaCombiner: null,
  };

  /**
   * Call inside _captureNewPredictions() after building oracleInput,
   * to record this hand's signals for next-hand scoring.
   */
  captureSignals(
    main: string | null,
    ensemble: string | null,
    crisis: string | null,
    metaCombiner: string | null,
  ): void {
    this.pending = { main, ensemble, crisis, metaCombiner };
  }

  /**
   * Call in handleInput() after resolving the actual outcome (before
   * _captureNewPredictions). Scores the signals captured last hand.
   * Ties (actual=null) are skipped — no signal is credited or penalised.
   */
  scoreOutcome(actual: string | null): void {
    if (!actual) return;
    this._score("main",         this.pending.main,         actual);
    this._score("ensemble",     this.pending.ensemble,     actual);
    this._score("crisis",       this.pending.crisis,       actual);
    this._score("metaCombiner", this.pending.metaCombiner, actual);
  }

  /** Weight multiplier for a signal key. Returns 1.0 when insufficient data. */
  getMultiplier(key: SignalKey): number {
    const arr = this.history.get(key)!;
    if (arr.length < TRACKER_MIN_SAMP) return 1.0;
    const acc = arr.filter(Boolean).length / arr.length;
    return 0.5 + acc; // 0%→0.5×, 50%→1.0×, 100%→1.5×
  }

  /** Full stats object for a signal. baseWeight is the nominal weight before scaling. */
  getStats(key: SignalKey, label: string, baseWeight: number): OracleSignalStats {
    const arr  = this.history.get(key)!;
    const samp = arr.length;
    const accuracy = samp >= TRACKER_MIN_SAMP
      ? parseFloat((arr.filter(Boolean).length / samp).toFixed(3))
      : null;
    const multiplier = samp >= TRACKER_MIN_SAMP ? 0.5 + (accuracy ?? 0.5) : 1.0;
    return {
      key,
      label,
      samples: samp,
      accuracy,
      multiplier: parseFloat(multiplier.toFixed(3)),
      baseWeight: parseFloat(baseWeight.toFixed(3)),
      effectiveWeight: parseFloat((baseWeight * multiplier).toFixed(3)),
    };
  }

  reset(): void {
    for (const k of SIGNAL_KEYS) this.history.set(k, []);
    this.pending = { main: null, ensemble: null, crisis: null, metaCombiner: null };
  }

  private _score(key: SignalKey, pred: string | null, actual: string): void {
    if (!pred || pred === "WAIT") return; // Abstain — don't count
    const arr = this.history.get(key)!;
    arr.push(pred === actual);
    if (arr.length > TRACKER_WINDOW) arr.shift();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDir(s: string | null | undefined): 1 | -1 | 0 {
  if (s === "P") return 1;
  if (s === "B") return -1;
  return 0;
}

function confMult(c: string): number {
  if (c === "HIGH") return 1.3;
  if (c === "MED") return 1.0;
  return 0.65;
}

// ── Base weight computation (shared by both modes) ────────────────────────────

interface VoteEntry {
  key: SignalKey;
  dir: 1 | -1 | 0;
  baseWeight: number;
  label: string;
}

function buildVotes(input: OracleInput): VoteEntry[] {
  const votes: VoteEntry[] = [];

  // Signal 1: Main Prediction
  const mainDir = toDir(input.regimeDecision);
  votes.push({
    key: "main",
    dir: mainDir,
    baseWeight: 1.5,
    label: mainDir === 1 ? "Main→P" : mainDir === -1 ? "Main→B" : "Main→skip",
  });

  // Signal 2: Ensemble Vote (weight boosted by lopsidedness)
  const ensDir   = toDir(input.ensembleVerdict);
  const ensBias  = Math.min(input.ensemblePercent / 100, 1.0);
  const ensBase  = 2.0 + ensBias * 0.8;  // 2.0–2.8
  votes.push({
    key: "ensemble",
    dir: ensDir,
    baseWeight: ensBase,
    label: ensDir === 1 ? "Ensemble→P" : ensDir === -1 ? "Ensemble→B" : "Ensemble→skip",
  });

  // Signal 3: Crisis AI
  const crisisDir = input.crisisActive
    ? toDir(input.crisisPrediction)
    : toDir(input.crisisBackgroundPrediction);
  const crisisBase = input.crisisActive
    ? 2.5 * confMult(input.crisisConfidence)
    : 1.2;
  votes.push({
    key: "crisis",
    dir: crisisDir,
    baseWeight: crisisBase,
    label: crisisDir === 1
      ? `Crisis${input.crisisActive ? "(active)" : "(bg)"}→P`
      : crisisDir === -1
      ? `Crisis${input.crisisActive ? "(active)" : "(bg)"}→B`
      : "Crisis→skip",
  });

  // Signal 4: Meta Combiner (highest base weight)
  const mcDir     = toDir(input.mcPrediction);
  const mcAccBoost = input.mcRecentAccuracy != null
    ? 0.8 + input.mcRecentAccuracy * 0.5   // 0.8–1.3
    : 1.0;
  const mcBase = 3.0 * confMult(input.mcConfidence) * mcAccBoost;
  votes.push({
    key: "metaCombiner",
    dir: mcDir,
    baseWeight: mcBase,
    label: mcDir === 1 ? "MetaCombiner→P" : mcDir === -1 ? "MetaCombiner→B" : "MetaCombiner→skip",
  });

  return votes;
}

// ── Tally votes into a result ─────────────────────────────────────────────────

function tallyVotes(
  votes: VoteEntry[],
  effectiveWeights: number[],
  input: OracleInput,
  adaptive: boolean,
  signalStats: OracleSignalStats[],
): OracleResult {
  // ── Cold-start guard ──────────────────────────────────────────────────────
  if (input.handCount < 10) {
    return waitResult("Collecting data — need 10+ hands", 0, 0, 0, false, [], adaptive, signalStats);
  }

  // ── Bankroll protection ───────────────────────────────────────────────────
  if (input.consecutiveLosses >= 3) {
    return waitResult(
      `${input.consecutiveLosses} consecutive losses — skip to protect bankroll`,
      0, 0, 0, false, [], adaptive, signalStats,
    );
  }

  let netScore = 0;
  let pScore   = 0;
  let bScore   = 0;
  let pVotes   = 0;
  let bVotes   = 0;
  let totalSignals = 0;
  const reasons: string[] = [];
  let mcDir: 1 | -1 | 0 = 0;

  for (let i = 0; i < votes.length; i++) {
    const v = votes[i];
    const w = effectiveWeights[i];
    if (v.key === "metaCombiner") mcDir = v.dir;
    if (v.dir === 0) continue;
    totalSignals++;
    netScore += v.dir * w;
    if (v.dir === 1) { pScore += w; pVotes++; }
    else             { bScore += w; bVotes++; }
    reasons.push(v.label);
  }

  if (totalSignals === 0) {
    return waitResult("No active signals — all systems abstaining", 0, 0, 0, false, [], adaptive, signalStats);
  }

  // Consensus bonus
  if (pVotes > 0 && bVotes === 0 && pVotes >= 2) netScore += 1.2;
  if (bVotes > 0 && pVotes === 0 && bVotes >= 2) netScore -= 1.2;

  // WAIT — split
  if (pVotes > 0 && bVotes > 0 && Math.abs(netScore) < 1.2) {
    return waitResult(
      `Signals split — ${pVotes} lean Player, ${bVotes} lean Banker`,
      netScore, pVotes, bVotes, false, reasons, adaptive, signalStats,
    );
  }

  // WAIT — weak
  if (totalSignals >= 2 && Math.abs(netScore) < 1.0) {
    return waitResult(
      "Signal too weak — no reliable edge",
      netScore, pVotes, bVotes, false, reasons, adaptive, signalStats,
    );
  }

  const verdict: string    = netScore > 0 ? "P" : "B";
  const agreementCount     = verdict === "P" ? pVotes : bVotes;
  const consensusPulse     = agreementCount >= 3;
  const mcAligned          = mcDir !== 0 && (mcDir === 1) === (verdict === "P");
  const absScore           = Math.abs(netScore);
  const confidence         =
    absScore >= 5.0 && agreementCount >= 3 ? "HIGH" :
    absScore >= 2.8 ? "MED" :
    "LOW";

  return {
    verdict,
    confidence,
    netScore: parseFloat(netScore.toFixed(3)),
    agreementCount,
    totalSignals,
    championAligned: mcAligned,
    consensusPulse,
    waitReason: null,
    topReasons: reasons.slice(0, 4),
    adaptive,
    signalStats,
  };
}

// ── Public compute functions ──────────────────────────────────────────────────

/** Fixed-weight Oracle (legacy mode). */
export function computeOracle(input: OracleInput): OracleResult {
  const votes   = buildVotes(input);
  const weights = votes.map((v) => v.baseWeight);
  return tallyVotes(votes, weights, input, false, []);
}

/** Adaptive-weight Oracle — applies tracker multipliers to each signal's base weight. */
export function computeOracleAdaptive(
  input:   OracleInput,
  tracker: OracleSignalTracker,
): OracleResult {
  const votes   = buildVotes(input);
  const weights = votes.map((v) => v.baseWeight * tracker.getMultiplier(v.key));

  // Build signalStats for the dashboard display
  const LABELS: Record<SignalKey, string> = {
    main:         "Main Prediction",
    ensemble:     "Ensemble Vote",
    crisis:       "Crisis AI",
    metaCombiner: "MetaCombiner",
  };
  const signalStats: OracleSignalStats[] = votes.map((v, i) =>
    tracker.getStats(v.key, LABELS[v.key], v.baseWeight)
  );

  return tallyVotes(votes, weights, input, true, signalStats);
}

// ── Wait result helper ────────────────────────────────────────────────────────

function waitResult(
  reason: string,
  netScore: number,
  pVotes: number,
  bVotes: number,
  consensusPulse: boolean,
  reasons: string[] = [],
  adaptive = false,
  signalStats: OracleSignalStats[] = [],
): OracleResult {
  return {
    verdict: "WAIT",
    confidence: pVotes + bVotes >= 2 ? "MED" : "LOW",
    netScore: parseFloat(netScore.toFixed(3)),
    agreementCount: 0,
    totalSignals: pVotes + bVotes,
    championAligned: false,
    consensusPulse,
    waitReason: reason,
    topReasons: reasons.slice(0, 4),
    adaptive,
    signalStats,
  };
}
