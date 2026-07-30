/**
 * OracleAI — Final Prediction Synthesizer
 *
 * Reads every sub-system signal (MetaCombiner, CrisisAI, Regime Ensemble,
 * MetaAI, Observer, LookAhead x2, Race Tracker) and produces a single
 * authoritative verdict: BET PLAYER, BET BANKER, or WAIT.
 *
 * Philosophy:
 *   - Bankroll safety first: every loss streak pattern triggers conservative
 *     WAIT logic before the user bleeds chips.
 *   - Signal quality over quantity: each source is weighted by its tracked
 *     live accuracy, not just its presence.
 *   - Consensus amplification: when multiple independent engines converge,
 *     confidence is boosted; when they diverge, WAIT is preferred.
 *
 * Algorithm: Reliability-Weighted Directional Scoring
 *   1. Convert each sub-system output → directional score (+P, −B, 0=skip)
 *   2. Weight each signal by the engine's live rolling accuracy
 *   3. Sum → netScore (positive = Player lean, negative = Banker lean)
 *   4. Apply WAIT override rules (crisis, split, volatility, cold start)
 *   5. Threshold the score for the final call
 */

type Side = "B" | "P";

// ── Inputs ─────────────────────────────────────────────────────────────────────

export interface OracleInput {
  handCount: number;

  // MetaCombiner
  mcPrediction: string;           // "P" | "B" | "WAIT"
  mcPPlayer: number;              // 0-1
  mcConfidence: string;           // "LOW" | "MED" | "HIGH"
  mcRecentAccuracy: number | null;
  mcConvergenceCount: number;
  mcConvergenceTotal: number;

  // CrisisAI
  crisisActive: boolean;
  crisisPrediction: string | null;        // "P" | "B" | null
  crisisBackgroundPrediction: string | null;
  crisisConfidence: string;               // "LOW" | "MED" | "HIGH"
  crisisConsecutiveLosses: number;

  // Regime
  ensembleVerdict: string | null;         // "P" | "B" | null
  ensemblePercent: number;
  regimeDecision: string | null;          // "P" | "B" | null
  bothAgree: boolean;
  bothAgreeSide: string | null;
  agreeCount: number;
  totalExperts: number;
  isLocked: boolean;
  isSplit: boolean;
  volatilityIndex: number;
  shadowLeaderPred: string | null;

  // MetaAI
  metaAIDecision: string;         // "P" | "B" | "WAIT"
  metaAIPPlayer: number;
  metaAIAccuracy: number | null;
  metaAISeen: number;

  // Observer
  observerDecision: string;       // "P" | "B" | "WAIT"
  observerWR: number | null;
  observerIsFallback: boolean;

  // LookAhead v1
  laVerdict: string | null;       // "P" | "B" | null
  laBias: number;
  laStrength: number;
  laRecentAcc: number | null;

  // LookAhead v2 (legacy)
  la2Verdict: string | null;
  la2Bias: number;
  la2Strength: number;

  // Race tracker
  raceActive: boolean;
  raceChampion: string | null;    // "metaCombiner" | "crisisAI" | "ensemble" | null
  raceChampionStreak: number;
  raceAllAgree: boolean;
  raceAgreeSide: string | null;
  raceMCAccuracy: number | null;
  raceCrisisAccuracy: number | null;
  raceEnsembleAccuracy: number | null;
  raceMCPrediction: string | null;
  raceCrisisPrediction: string | null;
  raceEnsemblePrediction: string | null;
}

// ── Output ────────────────────────────────────────────────────────────────────

export interface OracleResult {
  /** Final call: "P", "B", or "WAIT" */
  verdict: string;
  /** Confidence tier based on net score magnitude */
  confidence: string;
  /** Weighted directional net score. Positive = Player lean. */
  netScore: number;
  /** How many non-null signals agree with the verdict direction */
  agreementCount: number;
  /** Total non-null, non-WAIT signals considered */
  totalSignals: number;
  /** True when the current race champion's prediction aligns with verdict */
  championAligned: boolean;
  /** True when race tracker allAgree pulse fires */
  consensusPulse: boolean;
  /** If WAIT, the primary reason why */
  waitReason: string | null;
  /** Up to 4 key factors explaining the call */
  topReasons: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDir(s: string | null): 1 | -1 | 0 {
  if (s === "P") return 1;
  if (s === "B") return -1;
  return 0;
}

function confMult(c: string): number {
  if (c === "HIGH") return 1.0;
  if (c === "MED") return 0.70;
  return 0.40; // LOW
}

// Reliability: use rolling accuracy if available, else a conservative prior
function rel(acc: number | null, prior = 0.50): number {
  return acc !== null ? Math.max(0.35, acc) : prior;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const WAIT_THRESHOLD = 1.4;   // |netScore| below this → WAIT (signals split)
const MED_THRESHOLD  = 3.0;   // |netScore| above this → MED confidence
const HIGH_THRESHOLD = 5.5;   // |netScore| above this → HIGH confidence
const MIN_HANDS      = 10;    // cold-start gate

// ── Core compute ──────────────────────────────────────────────────────────────

export function computeOracle(input: OracleInput): OracleResult {
  const reasons: string[] = [];

  // ── Cold-start guard ──────────────────────────────────────────────────────
  if (input.handCount < MIN_HANDS) {
    return {
      verdict: "WAIT",
      confidence: "LOW",
      netScore: 0,
      agreementCount: 0,
      totalSignals: 0,
      championAligned: false,
      consensusPulse: false,
      waitReason: `Collecting data (${input.handCount}/${MIN_HANDS} hands)`,
      topReasons: ["Insufficient history for reliable prediction"],
    };
  }

  // ── Emergency bankroll protection ────────────────────────────────────────
  // Hard WAIT on sustained loss streaks regardless of any other signal
  if (input.crisisConsecutiveLosses >= 3 && !input.isLocked) {
    return {
      verdict: "WAIT",
      confidence: "HIGH",
      netScore: 0,
      agreementCount: 0,
      totalSignals: 0,
      championAligned: false,
      consensusPulse: false,
      waitReason: `${input.crisisConsecutiveLosses} consecutive losses — bankroll protection active`,
      topReasons: [
        `Crisis: ${input.crisisConsecutiveLosses} straight losses detected`,
        "Protecting bankroll until pattern stabilises",
      ],
    };
  }

  // ── Signal collection ─────────────────────────────────────────────────────
  // Each signal contributes: direction × baseWeight × reliabilityFactor
  // net positive → Player, net negative → Banker

  let netScore = 0;
  let totalWeight = 0;
  let totalSignals = 0;

  // Track per-side weighted votes for agreement count
  let pVotes = 0;
  let bVotes = 0;

  function addSignal(
    label: string,
    direction: 1 | -1 | 0,
    baseWeight: number,
    reliability: number
  ) {
    if (direction === 0) return;
    const contribution = direction * baseWeight * reliability;
    netScore += contribution;
    totalWeight += baseWeight * reliability;
    totalSignals++;
    if (direction === 1) { pVotes++; reasons.push(`${label}→P`); }
    else { bVotes++; reasons.push(`${label}→B`); }
  }

  // 1. MetaCombiner (highest authority — online learned from all signals)
  {
    const dir = toDir(input.mcPrediction);
    const r = rel(input.mcRecentAccuracy, 0.52);
    addSignal("MetaCombiner", dir, 3.2, r);

    // Extra: convergence quality bonus
    if (dir !== 0 && input.mcConvergenceTotal > 0) {
      const convRatio = input.mcConvergenceCount / input.mcConvergenceTotal;
      if (convRatio >= 0.65) {
        netScore += dir * 0.8;
        reasons.push(`MC-convergence(${input.mcConvergenceCount}/${input.mcConvergenceTotal})`);
      }
    }
  }

  // 2. Regime Ensemble Vote
  {
    const dir = toDir(input.ensembleVerdict);
    if (dir !== 0) {
      const r = input.ensemblePercent / 100;
      addSignal("Ensemble", dir, 2.2, r);
    }
  }

  // 3. Race champion's prediction (tracks who's currently most accurate live)
  let championAligned = false;
  if (input.raceActive && input.raceChampion) {
    const champAcc = input.raceChampion === "metaCombiner" ? input.raceMCAccuracy
      : input.raceChampion === "crisisAI" ? input.raceCrisisAccuracy
      : input.raceEnsembleAccuracy;
    const champPred = input.raceChampion === "metaCombiner" ? input.raceMCPrediction
      : input.raceChampion === "crisisAI" ? input.raceCrisisPrediction
      : input.raceEnsemblePrediction;
    const dir = toDir(champPred);
    if (dir !== 0 && champAcc !== null) {
      addSignal(`RaceChampion(${input.raceChampion})`, dir, 2.5, champAcc);
      const verdictDir = netScore >= 0 ? 1 : -1;
      championAligned = dir === verdictDir;
    }
  }

  // 4. CrisisAI — active prediction (when panel fires)
  if (input.crisisActive && input.crisisPrediction) {
    const dir = toDir(input.crisisPrediction);
    const r = confMult(input.crisisConfidence);
    addSignal("CrisisAI(active)", dir, 2.2, r);
  }

  // 5. CrisisAI background (always-running, lower weight)
  {
    const dir = toDir(input.crisisBackgroundPrediction);
    addSignal("CrisisAI(bg)", dir, 1.3, 0.60);
  }

  // 6. MetaAI — online logistic regression on feature vector
  if (input.metaAISeen >= 8) {
    const dir = toDir(input.metaAIDecision);
    const r = rel(input.metaAIAccuracy, 0.50);
    addSignal("MetaAI", dir, 1.6, r);
  }

  // 7. Observer Master AI
  {
    const dir = toDir(input.observerDecision);
    const r = input.observerIsFallback ? 0.38 : rel(input.observerWR, 0.50);
    const w = input.observerIsFallback ? 0.8 : 1.5;
    addSignal(input.observerIsFallback ? "Observer(fallback)" : "Observer", dir, w, r);
  }

  // 8. LookAhead v1 (depth-1 branch simulation)
  if (input.laStrength > 0.1) {
    const dir = toDir(input.laVerdict);
    const r = input.laStrength * rel(input.laRecentAcc, 0.50);
    addSignal("LookAhead-v1", dir, 1.1, r);
  }

  // 9. LookAhead v2 / legacy (depth-2)
  if (input.la2Strength > 0.1) {
    const dir = toDir(input.la2Verdict);
    const r = input.la2Strength * 0.55;
    addSignal("LookAhead-v2", dir, 0.8, r);
  }

  // ── Consensus amplifiers (additive) ──────────────────────────────────────

  const consensusPulse = input.raceAllAgree && input.raceAgreeSide !== null;
  if (consensusPulse) {
    const dir = toDir(input.raceAgreeSide);
    netScore += dir * 1.6;
    reasons.push(`RaceConsensus→${input.raceAgreeSide}`);
  }

  if (input.bothAgree && input.bothAgreeSide) {
    const dir = toDir(input.bothAgreeSide);
    netScore += dir * 1.6;
    reasons.push(`RegimeBothAgree→${input.bothAgreeSide}`);
  } else if (input.agreeCount >= Math.ceil(input.totalExperts * 0.6) && input.ensembleVerdict) {
    // Strong majority (≥60% of experts)
    const dir = toDir(input.ensembleVerdict);
    netScore += dir * 0.8;
    reasons.push(`MajorityAgree(${input.agreeCount}/${input.totalExperts})→${input.ensembleVerdict}`);
  }

  // Race champion streak bonus
  if (input.raceActive && input.raceChampion && input.raceChampionStreak >= 3) {
    const champPred = input.raceChampion === "metaCombiner" ? input.raceMCPrediction
      : input.raceChampion === "crisisAI" ? input.raceCrisisPrediction
      : input.raceEnsemblePrediction;
    const dir = toDir(champPred);
    if (dir !== 0) {
      netScore += dir * (0.2 * Math.min(input.raceChampionStreak, 6));
      reasons.push(`ChampStreak(${input.raceChampionStreak}×)→${champPred}`);
    }
  }

  // ── WAIT override conditions ──────────────────────────────────────────────
  // Applied after scoring so we can base decisions on the actual signal split

  // Condition A: Signals are too diverged — no reliable bet
  if (Math.abs(netScore) < WAIT_THRESHOLD && totalSignals >= 3) {
    const topWaitReasons = buildTopReasons(reasons, netScore, pVotes, bVotes, true);
    return {
      verdict: "WAIT",
      confidence: "MED",
      netScore: parseFloat(netScore.toFixed(3)),
      agreementCount: netScore >= 0 ? pVotes : bVotes,
      totalSignals,
      championAligned,
      consensusPulse,
      waitReason: "Signals diverge — no reliable edge this hand",
      topReasons: topWaitReasons,
    };
  }

  // Condition B: MetaCombiner abstains AND no ensemble verdict → skip
  if (input.mcPrediction === "WAIT" && !input.ensembleVerdict) {
    return {
      verdict: "WAIT",
      confidence: "MED",
      netScore: parseFloat(netScore.toFixed(3)),
      agreementCount: netScore >= 0 ? pVotes : bVotes,
      totalSignals,
      championAligned,
      consensusPulse,
      waitReason: "MetaCombiner and Ensemble both abstaining",
      topReasons: ["No strong directional signal from primary engines"],
    };
  }

  // Condition C: High volatility with low expert agreement → skip
  if (input.volatilityIndex > 0.75 && input.mcConvergenceCount < 3) {
    return {
      verdict: "WAIT",
      confidence: "MED",
      netScore: parseFloat(netScore.toFixed(3)),
      agreementCount: netScore >= 0 ? pVotes : bVotes,
      totalSignals,
      championAligned,
      consensusPulse,
      waitReason: `Pattern volatility high (${(input.volatilityIndex * 100).toFixed(0)}%) — unstable shoe`,
      topReasons: [`Volatility ${(input.volatilityIndex * 100).toFixed(0)}%`, "Expert agreement too low to bet safely"],
    };
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  const verdict: string = netScore >= 0 ? "P" : "B";
  const absScore = Math.abs(netScore);
  const confidence =
    absScore >= HIGH_THRESHOLD ? "HIGH" :
    absScore >= MED_THRESHOLD  ? "MED"  : "LOW";

  const agreementCount = verdict === "P" ? pVotes : bVotes;

  // Update champion alignment with final verdict direction
  if (input.raceActive && input.raceChampion) {
    const champPred = input.raceChampion === "metaCombiner" ? input.raceMCPrediction
      : input.raceChampion === "crisisAI" ? input.raceCrisisPrediction
      : input.raceEnsemblePrediction;
    championAligned = champPred === verdict;
  }

  return {
    verdict,
    confidence,
    netScore: parseFloat(netScore.toFixed(3)),
    agreementCount,
    totalSignals,
    championAligned,
    consensusPulse,
    waitReason: null,
    topReasons: buildTopReasons(reasons, netScore, pVotes, bVotes, false),
  };
}

function buildTopReasons(
  reasons: string[],
  netScore: number,
  pVotes: number,
  bVotes: number,
  isWait: boolean
): string[] {
  if (isWait) {
    return [
      `Signals split: ${pVotes} lean Player, ${bVotes} lean Banker`,
      "Edge below confidence threshold",
    ];
  }
  // Take first 4 unique engine labels (strip direction tag)
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of reasons) {
    const label = r.replace(/→[PB]$/, "").replace(/\(.*\)/, "");
    if (!seen.has(label)) {
      seen.add(label);
      out.push(r);
    }
    if (out.length >= 4) break;
  }
  return out;
}
