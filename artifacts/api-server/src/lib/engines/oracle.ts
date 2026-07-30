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

// ── Core compute ──────────────────────────────────────────────────────────────

export function computeOracle(input: OracleInput): OracleResult {
  // ── Cold-start guard ──────────────────────────────────────────────────────
  if (input.handCount < 10) {
    return waitResult("Collecting data — need 10+ hands", 0, 0, 0, false);
  }

  // ── Bankroll protection — hard WAIT on 3+ consecutive losses ─────────────
  if (input.consecutiveLosses >= 3) {
    return waitResult(
      `${input.consecutiveLosses} consecutive losses — skip to protect bankroll`,
      0, 0, 0, false,
    );
  }

  // ── Build the 4 directional votes ─────────────────────────────────────────
  // Each entry: [direction, base weight, label]
  const votes: Array<{ dir: 1 | -1 | 0; weight: number; label: string }> = [];

  // --- Signal 1: Main Prediction (regime.decision) -------------------------
  const mainDir = toDir(input.regimeDecision);
  votes.push({
    dir: mainDir,
    weight: 1.5,
    label: mainDir === 1 ? "Main→P" : mainDir === -1 ? "Main→B" : "Main→skip",
  });

  // --- Signal 2: Ensemble Vote ---------------------------------------------
  // Weight boosted when the vote is lopsided (high ensemblePercent)
  const ensDir = toDir(input.ensembleVerdict);
  const ensBias = Math.min(input.ensemblePercent / 100, 1.0);   // 0–1
  const ensWeight = 2.0 + ensBias * 0.8;                        // 2.0–2.8
  votes.push({
    dir: ensDir,
    weight: ensWeight,
    label: ensDir === 1 ? "Ensemble→P" : ensDir === -1 ? "Ensemble→B" : "Ensemble→skip",
  });

  // --- Signal 3: Crisis AI -------------------------------------------------
  // When active, use the active (override) prediction at higher weight.
  // When in standby, use the background (always-on) prediction at lower weight.
  const crisisDir = input.crisisActive
    ? toDir(input.crisisPrediction)
    : toDir(input.crisisBackgroundPrediction);
  const crisisWeight = input.crisisActive
    ? 2.5 * confMult(input.crisisConfidence)   // boosted when triggered
    : 1.2;                                     // lower when background
  votes.push({
    dir: crisisDir,
    weight: crisisWeight,
    label: crisisDir === 1
      ? `Crisis${input.crisisActive ? "(active)" : "(bg)"}→P`
      : crisisDir === -1
      ? `Crisis${input.crisisActive ? "(active)" : "(bg)"}→B`
      : "Crisis→skip",
  });

  // --- Signal 4: Meta Combiner ---------------------------------------------
  // Highest base weight — already synthesizes MetaAI, Observer, LookAhead, Roads.
  // Further boosted by its own confidence tier and rolling accuracy.
  const mcDir = toDir(input.mcPrediction);
  const mcAccBoost = input.mcRecentAccuracy != null
    ? 0.8 + input.mcRecentAccuracy * 0.5        // 0.8–1.3 range
    : 1.0;
  const mcWeight = 3.0 * confMult(input.mcConfidence) * mcAccBoost;
  votes.push({
    dir: mcDir,
    weight: mcWeight,
    label: mcDir === 1 ? "MetaCombiner→P" : mcDir === -1 ? "MetaCombiner→B" : "MetaCombiner→skip",
  });

  // ── Tally ─────────────────────────────────────────────────────────────────
  let netScore = 0;
  let pScore = 0;
  let bScore = 0;
  let pVotes = 0;
  let bVotes = 0;
  let totalSignals = 0;
  const reasons: string[] = [];

  for (const v of votes) {
    if (v.dir === 0) continue;           // abstain — skip
    totalSignals++;
    const contrib = v.dir * v.weight;
    netScore += contrib;
    if (v.dir === 1) { pScore += v.weight; pVotes++; }
    else             { bScore += v.weight; bVotes++; }
    reasons.push(v.label);
  }

  // ── No signals at all — all abstained ────────────────────────────────────
  if (totalSignals === 0) {
    return waitResult("No active signals — all systems abstaining", 0, 0, 0, false);
  }

  // ── Consensus bonus: when all active signals agree, amplify ──────────────
  if (pVotes > 0 && bVotes === 0 && pVotes >= 2) netScore += 1.2;
  if (bVotes > 0 && pVotes === 0 && bVotes >= 2) netScore -= 1.2;

  // ── WAIT — signals split too evenly ──────────────────────────────────────
  if (pVotes > 0 && bVotes > 0 && Math.abs(netScore) < 1.2) {
    return waitResult(
      `Signals split — ${pVotes} lean Player, ${bVotes} lean Banker`,
      netScore, pVotes, bVotes, false,
      reasons,
    );
  }

  // ── WAIT — very weak net score with multiple signals ─────────────────────
  if (totalSignals >= 2 && Math.abs(netScore) < 1.0) {
    return waitResult("Signal too weak — no reliable edge", netScore, pVotes, bVotes, false, reasons);
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  const verdict: string = netScore > 0 ? "P" : "B";
  const agreementCount = verdict === "P" ? pVotes : bVotes;
  const consensusPulse = agreementCount >= 3;

  // MetaCombiner aligned = the most reliable signal agrees with verdict
  const mcAligned = mcDir !== 0 && (mcDir === 1) === (verdict === "P");

  // Confidence
  const absScore = Math.abs(netScore);
  const confidence =
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
  };
}

// ── Wait result helper ────────────────────────────────────────────────────────

function waitResult(
  reason: string,
  netScore: number,
  pVotes: number,
  bVotes: number,
  consensusPulse: boolean,
  reasons: string[] = [],
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
  };
}
