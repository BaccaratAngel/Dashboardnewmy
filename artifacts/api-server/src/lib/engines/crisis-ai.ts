/**
 * Internal Crisis AI — a bounded, self-learning recovery engine.
 *
 * It runs entirely in-process. There are no API calls, credentials, model
 * timeouts, or external responses to wait for. Every hand:
 *   1. scores the previous Crisis AI prediction against the actual outcome,
 *   2. updates shoe-pattern and per-expert trust (base learning),
 *   3. runs deep wrong-prediction analysis when prediction missed — examining
 *      recent context, which experts were correct, and what score path would
 *      have led to the right answer — and adjusts shoe-specific biases,
 *   4. generates the next prediction from the newly learned state.
 *
 * The background process always runs regardless of panel visibility.
 * Panel activation: two consecutive main-prediction losses.
 * Panel close: when Crisis AI's own prediction wins.
 * Panel re-arm: if main prediction loses 2 consecutive times again after close.
 *
 * ── v2 upgrades ──────────────────────────────────────────────────────────────
 *
 * Upgrade 1 — Own loss streak + abstain mode
 *   Crisis AI now tracks its own consecutive background-prediction losses
 *   independently of the main-prediction streak. After 4+ consecutive own
 *   losses it abstains for 1 hand (prediction=null) and resets the counter
 *   to 1 so normal operation resumes the next hand. This directly stops the
 *   "keeps losing continuously" behaviour on chaotic shoes.
 *
 * Upgrade 2 — Shoe-survival contrarian mode (replaces 3-loss flip)
 *   Instead of flipping on any 3-loss streak, Crisis AI now tracks its total
 *   shoe accuracy (shoeOwnWins / shoeOwnLosses). Contrarian mode only engages
 *   when:
 *     • at least CONTRARIAN_MIN_SAMPLE hands have been predicted this shoe, AND
 *     • shoe accuracy falls below CONTRARIAN_ACC_THRESHOLD (≤ 38%)
 *   Once engaged, all predictions are flipped for a block of CONTRARIAN_BLOCK
 *   hands. If contrarian mode accuracy is itself ≤ CONTRARIAN_FAIL_THRESHOLD,
 *   Crisis AI self-disables for the rest of the shoe (shoeSurvivalFailed=true).
 *   This avoids the noisy 3-hand trigger and models the shoe as genuinely
 *   inverted rather than reacting to short-term variance.
 *
 * Upgrade 3 — Volatility-aware scoring
 *   volatilityIndex (0-1) is now passed in from the regime tracker. When
 *   volatility > 0.70 all expert weights are scaled by 0.62 and confidence is
 *   capped at MED. High-volatility shoes produce noisy expert signals.
 *
 * Upgrade 4 — Adaptive ensemble/shadow weighting
 *   The last 6 ensemble and shadow-leader verdict outcomes are tracked. Their
 *   score bonuses are scaled by their actual recent accuracy (min 0.35, max 1.5
 *   for ensemble; min 0.2, max 1.0 for shadow) instead of being hardcoded.
 *
 * Upgrade 5 — Thrash guard
 *   Counts panel on→off cycles (panelToggleCount). After 4+ cycles all expert
 *   weights are reduced by 20% and confidence is capped at MED.
 *
 * Upgrade 6 — Auto-length pattern scanner (replaces fixed windows)
 *   scoreRecentPattern now tests run/alternating/dominance at all meaningful
 *   window sizes automatically and selects the strongest confirmed signal,
 *   scaling its weight by how long the pattern has persisted. A 6-hand run
 *   carries more evidence than a 2-hand run; a 10-hand alternating stretch
 *   outweighs a 4-hand one.
 */

type Side = "P" | "B";
type PatternMode = "run" | "alternating" | "balanced";

const CRISIS_THRESHOLD = 2;
const OWN_LOSS_ABSTAIN_THRESHOLD = 4;   // abstain after this many consecutive own losses

// ── Shoe-survival contrarian constants ──────────────────────────────────────
/** Minimum hands predicted before shoe-survival check can engage */
const CONTRARIAN_MIN_SAMPLE = 15;       // raised from 10 — need more evidence before committing
/** Shoe accuracy at or below this → enter contrarian mode */
const CONTRARIAN_ACC_THRESHOLD = 0.38;
/** How many hands contrarian mode stays active */
const CONTRARIAN_BLOCK = 8;             // raised from 6 — give contrarian more runway to prove itself
/** If contrarian accuracy itself falls at or below this → self-disable for the shoe */
const CONTRARIAN_FAIL_THRESHOLD = 0.35; // lowered from 0.40 — require worse performance to self-disable
/** Hands after self-disable before Crisis AI retries with fresh shoe stats */
const SHOE_SURVIVAL_RECOVERY_HANDS = 10;
/** Consecutive main losses that force an emergency prediction even when self-disabled */
const EMERGENCY_OVERRIDE_LOSSES = 5;

const VOLATILITY_HIGH_THRESHOLD = 0.70;  // volatilityIndex above this = high-vol mode
const THRASH_TOGGLE_THRESHOLD = 4;       // panel on→off cycles before thrash guard kicks in
const VOLATILITY_EXPERT_SCALE = 0.62;    // scale factor applied to expert weights in high-vol
const THRASH_EXPERT_SCALE = 0.80;        // scale factor applied in thrash mode
const ADAPTIVE_WINDOW = 6;              // how many recent ensemble/shadow results to track

const EXPERT_LABELS: Record<string, string> = {
  supreme: "Supreme Bayesian",
  syndicate: "Syndicate",
  lookAhead: "Look-Ahead v1",
  legacyLookAhead: "Look-Ahead v2",
  metaAI: "Meta AI",
  observer: "Observer",
  bebRoad: "Big Eye Boy",
  smallRoad: "Small Road",
  cockroachRoad: "Cockroach Road",
  dualAuth: "Dual-Auth",
};

const EXPERT_KEYS = Object.keys(EXPERT_LABELS);

export interface ExpertShoeData {
  key: string;
  wins: number;
  losses: number;
  lastPred: Side | null;
  currentRunIsWin: boolean | null;
  currentRunLen: number;
  momentum: string;
  compositeScore: number;
}

export interface CrisisResult {
  active: boolean;
  prediction: Side | null;
  confidence: "LOW" | "MED" | "HIGH";
  reasoning: string;
  consecutiveLosses: number;
  /** Always-computed background prediction (even when panel is inactive) */
  backgroundPrediction: Side | null;
  /** Latest background self-learning analysis message */
  bgLearning: string;
}

interface ExpertLearning {
  trust: number;
  correct: number;
  wrong: number;
}

interface LocalSignal {
  p: number;
  b: number;
  mode: PatternMode;
  note: string;
}

/**
 * Shoe-specific adaptations learned through wrong-prediction analysis.
 * These are additive corrections on top of the base scoring logic,
 * tuned to the current shoe's observed behavior.
 */
interface ShoeAdaptation {
  /** Additive P score bonus learned from shoe tendencies */
  playerBias: number;
  /** Additive B score bonus learned from shoe tendencies */
  bankerBias: number;
  /** Per-expert shoe-specific multiplier boost (separate from trust) */
  expertBoost: Record<string, number>;
  /** Per-pattern-mode additive score correction for this shoe */
  patternBoost: Record<PatternMode, number>;
  /** Total hands analyzed in background */
  handsAnalyzed: number;
  /** Count of wrong predictions analyzed */
  wrongCount: number;
  /** Count of correct predictions confirmed */
  correctCount: number;
  /** Last self-learning analysis string */
  lastAnalysis: string;
}

interface CrisisSnap {
  consecutiveLosses: number;
  suppressedAtLosses: number;
  lastMainPred: Side | null;
  lastPrediction: Side | null;
  lastPatternMode: PatternMode;
  panelSuppressed: boolean;
  lastAnalysis: string;
  result: CrisisResult;
  expertLearning: Record<string, ExpertLearning>;
  patternTrust: Record<PatternMode, number>;
  shoeAdaptation: ShoeAdaptation;
  // v2 state
  ownConsecutiveLosses: number;
  ownConsecutiveLossMax: number;
  panelToggleCount: number;
  lastWasActive: boolean;
  recentEnsembleCorrect: boolean[];
  recentShadowCorrect: boolean[];
  // v2 shoe-survival contrarian
  shoeOwnWins: number;
  shoeOwnLosses: number;
  contrарianMode: boolean;
  contrарianHandsRemaining: number;
  contrарianWins: number;
  contrарianLosses: number;
  shoeSurvivalFailed: boolean;
  shoeSurvivalFailedHands: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sideName(side: Side): string {
  return side === "P" ? "PLAYER" : "BANKER";
}

function opposite(side: Side): Side {
  return side === "P" ? "B" : "P";
}

function freshExpertLearning(): ExpertLearning {
  return { trust: 1, correct: 0, wrong: 0 };
}

function createExpertLearning(): Record<string, ExpertLearning> {
  return Object.fromEntries(EXPERT_KEYS.map((key) => [key, freshExpertLearning()]));
}

function freshShoeAdaptation(): ShoeAdaptation {
  return {
    playerBias: 0,
    bankerBias: 0,
    expertBoost: Object.fromEntries(EXPERT_KEYS.map((k) => [k, 0])),
    patternBoost: { run: 0, alternating: 0, balanced: 0 },
    handsAnalyzed: 0,
    wrongCount: 0,
    correctCount: 0,
    lastAnalysis: "",
  };
}

function cloneShoeAdaptation(sa: ShoeAdaptation): ShoeAdaptation {
  return {
    ...sa,
    expertBoost: { ...sa.expertBoost },
    patternBoost: { ...sa.patternBoost },
  };
}

function cleanHistory(history: string[]): Side[] {
  return history.filter((hand): hand is Side => hand === "P" || hand === "B");
}

/**
 * Auto-length pattern scanner (Upgrade 6).
 *
 * Tests run / alternating / dominance at all meaningful window sizes and
 * returns the strongest confirmed signal, scaled by how long the pattern
 * has been sustained. A 6-hand run outweighs a 2-hand one; a 10-hand
 * alternating stretch outweighs a 4-hand one.
 *
 * The signal is deliberately capped so it tunes expert scores without
 * overpowering broad expert agreement.
 */
function scoreRecentPattern(history: string[]): LocalSignal {
  const clean = cleanHistory(history);
  if (clean.length === 0) {
    return { p: 0, b: 0, mode: "balanced", note: "waiting for road data" };
  }

  const last = clean[clean.length - 1];

  // ── 1. Run detection (auto-length) ────────────────────────────────────────
  let runLength = 1;
  for (let i = clean.length - 2; i >= 0 && clean[i] === last; i--) runLength++;

  if (runLength >= 2) {
    // Scale weight with run length; cap at 10 to avoid over-commitment
    const effectiveLen = Math.min(runLength, 10);
    const amount = clamp(0.06 + (effectiveLen - 2) * 0.018, 0.06, 0.20);
    const p = last === "P" ? amount : 0;
    const b = last === "B" ? amount : 0;
    return { p, b, mode: "run", note: `${runLength}-hand ${sideName(last)} run` };
  }

  // ── 2. Alternating detection (auto-length, windows 4–14) ─────────────────
  let bestAltScore = 0;
  let bestAltLen = 0;
  const maxAltWindow = Math.min(14, clean.length);
  for (let w = 4; w <= maxAltWindow; w += 2) {
    const window = clean.slice(-w);
    let transitions = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i] !== window[i - 1]) transitions++;
    }
    const altScore = transitions / (window.length - 1);
    // Require at least 75% transition rate; prefer longer confirmed windows
    if (altScore >= 0.75 && w > bestAltLen) {
      bestAltScore = altScore;
      bestAltLen = w;
    }
  }

  if (bestAltLen >= 4) {
    // Scale weight with how many hands confirmed the pattern
    const amount = clamp(0.06 + (bestAltLen - 4) * 0.010, 0.06, 0.16);
    const reversal = opposite(last);
    const p = reversal === "P" ? amount : 0;
    const b = reversal === "B" ? amount : 0;
    return {
      p, b, mode: "alternating",
      note: `${bestAltLen}-hand alternating road (${Math.round(bestAltScore * 100)}% transitions)`,
    };
  }

  // ── 3. Side-dominance detection (auto-length, windows 6–24) ──────────────
  // Find the window that shows the strongest imbalance toward one side.
  let bestImbalance = 0;
  let bestDomSide: Side | null = null;
  let bestDomLen = 0;
  const maxDomWindow = Math.min(24, clean.length);
  for (let w = 6; w <= maxDomWindow; w += 2) {
    const window = clean.slice(-w);
    const pCount = window.filter((h) => h === "P").length;
    const imbalance = Math.abs(pCount - (w - pCount)) / w;
    if (imbalance > bestImbalance) {
      bestImbalance = imbalance;
      bestDomSide = pCount > w - pCount ? "P" : "B";
      bestDomLen = w;
    }
  }

  if (bestImbalance >= 0.30 && bestDomSide !== null) {
    // Gentle nudge toward the dominant side — not a strong signal on its own
    const amount = clamp(bestImbalance * 0.20, 0.04, 0.09);
    const p = bestDomSide === "P" ? amount : 0;
    const b = bestDomSide === "B" ? amount : 0;
    return {
      p, b, mode: "balanced",
      note: `${sideName(bestDomSide)} dominant over last ${bestDomLen} hands (${Math.round(bestImbalance * 100)}% imbalance)`,
    };
  }

  return { p: 0, b: 0, mode: "balanced", note: "mixed recent road" };
}

export class CrisisAI {
  private consecutiveLosses = 0;
  private suppressedAtLosses = 0;
  private lastMainPred: Side | null = null;
  private lastPrediction: Side | null = null;
  private lastPatternMode: PatternMode = "balanced";
  private panelSuppressed = false;
  private lastAnalysis = "";
  private expertLearning = createExpertLearning();
  private patternTrust: Record<PatternMode, number> = {
    run: 1,
    alternating: 1,
    balanced: 1,
  };
  private shoeAdaptation: ShoeAdaptation = freshShoeAdaptation();
  private _result: CrisisResult = {
    active: false,
    prediction: null,
    confidence: "LOW",
    reasoning: "",
    consecutiveLosses: 0,
    backgroundPrediction: null,
    bgLearning: "",
  };
  private _undoStack: CrisisSnap[] = [];

  // ── v2 state ────────────────────────────────────────────────────────────────
  /** Crisis AI's own consecutive background-prediction losses (separate from main losses) */
  private ownConsecutiveLosses = 0;
  /** Highest own loss streak seen this shoe (for analysis messages) */
  private ownConsecutiveLossMax = 0;
  /** Count of panel on→off cycles this shoe (for thrash detection) */
  private panelToggleCount = 0;
  /** Previous active state — used to detect on→off transitions */
  private lastWasActive = false;
  /** Rolling window of last ADAPTIVE_WINDOW ensemble verdict correctness */
  private recentEnsembleCorrect: boolean[] = [];
  /** Rolling window of last ADAPTIVE_WINDOW shadow-leader prediction correctness */
  private recentShadowCorrect: boolean[] = [];

  // ── v2 shoe-survival contrarian ──────────────────────────────────────────
  /** Total own wins this shoe (background predictions) */
  private shoeOwnWins = 0;
  /** Total own losses this shoe (background predictions) */
  private shoeOwnLosses = 0;
  /** Whether contrarian mode is currently active */
  private contrарianMode = false;
  /** Hands remaining in the current contrarian block */
  private contrарianHandsRemaining = 0;
  /** Wins scored while in contrarian mode (current block) */
  private contrарianWins = 0;
  /** Losses scored while in contrarian mode (current block) */
  private contrарianLosses = 0;
  /** True when even contrarian mode failed — self-disable for this shoe */
  private shoeSurvivalFailed = false;
  /** Hands elapsed since self-disable (for auto-recovery countdown) */
  private shoeSurvivalFailedHands = 0;

  setMainPrediction(pred: Side | null): void {
    this.lastMainPred = pred;
  }

  /**
   * Score the previous local prediction, learn from the current shoe, and
   * produce the next prediction. Background process always runs — panel
   * visibility is controlled separately by the active/suppressed flags.
   *
   * @param volatilityIndex  0-1 shoe-volatility from the regime tracker. Pass 0
   *   if unavailable; the system handles it gracefully.
   */
  evaluateOutcome(
    actual: Side | null,
    history: string[],
    experts: ExpertShoeData[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
    volatilityIndex = 0,
  ): void {
    this._save();

    // Capture previous active state BEFORE anything changes (for toggle counting)
    const prevResultActive = this._result.active;
    const previousPrediction = this.lastPrediction;
    let crisisPredictionCorrect: boolean | null = null;

    if (actual !== null) {
      // ── Background self-learning: always runs ────────────────────────────
      this.shoeAdaptation.handsAnalyzed++;

      // ── Upgrade 4: track ensemble/shadow accuracy for adaptive weighting ─
      if (ensembleVerdict !== null) {
        this.recentEnsembleCorrect.push(ensembleVerdict === actual);
        if (this.recentEnsembleCorrect.length > ADAPTIVE_WINDOW) {
          this.recentEnsembleCorrect.shift();
        }
      }
      if (shadowPred !== null) {
        this.recentShadowCorrect.push(shadowPred === actual);
        if (this.recentShadowCorrect.length > ADAPTIVE_WINDOW) {
          this.recentShadowCorrect.shift();
        }
      }

      if (previousPrediction !== null) {
        crisisPredictionCorrect = previousPrediction === actual;

        // ── Upgrade 1: track own consecutive losses ───────────────────────
        if (crisisPredictionCorrect) {
          this.ownConsecutiveLosses = 0;
          this.shoeOwnWins++;
        } else {
          this.ownConsecutiveLosses++;
          this.ownConsecutiveLossMax = Math.max(
            this.ownConsecutiveLossMax,
            this.ownConsecutiveLosses,
          );
          this.shoeOwnLosses++;
        }

        // ── Upgrade 2: shoe-survival contrarian tracking ─────────────────
        if (this.contrарianMode) {
          if (crisisPredictionCorrect) {
            this.contrарianWins++;
          } else {
            this.contrарianLosses++;
          }
          this.contrарianHandsRemaining--;

          // If contrarian block is exhausted, evaluate its effectiveness
          if (this.contrарianHandsRemaining <= 0) {
            const contrárianTotal = this.contrарianWins + this.contrарianLosses;
            const contrárianAcc = contrárianTotal > 0
              ? this.contrарianWins / contrárianTotal
              : 0;
            if (contrárianAcc <= CONTRARIAN_FAIL_THRESHOLD) {
              // Contrarian didn't help either — self-disable for the rest of the shoe
              this.shoeSurvivalFailed = true;
            }
            // Exit contrarian mode whether it worked or not
            this.contrарianMode = false;
            this.contrарianHandsRemaining = 0;
          }
        }

        // Base learning (preserved)
        this._learnFromOutcome(actual, history, experts, crisisPredictionCorrect);

        // Deep wrong-prediction analysis (preserved)
        if (!crisisPredictionCorrect) {
          this._analyzeWrongPrediction(previousPrediction, actual, history, experts);
        } else {
          this.shoeAdaptation.correctCount++;
          this.shoeAdaptation.lastAnalysis = `Correct: predicted ${sideName(previousPrediction)} — confirmed. Shoe model reinforced.`;
        }
      }
      // If previousPrediction was null (we abstained last hand), counts stay unchanged.

      // Main prediction loss tracking
      if (this.lastMainPred !== null) {
        if (this.lastMainPred === actual) {
          this.consecutiveLosses = 0;
          this.panelSuppressed = false;
          this.suppressedAtLosses = 0;
        } else {
          this.consecutiveLosses++;
        }
      }

      // Panel close: when Crisis AI wins while active
      if (prevResultActive && crisisPredictionCorrect === true && this.consecutiveLosses > 0) {
        this.panelSuppressed = true;
        this.suppressedAtLosses = this.consecutiveLosses;
      }
    }

    // Panel re-arm: if suppressed but main prediction loses 2 more times, re-open
    if (this.panelSuppressed) {
      const lossesAfterSuppression = this.consecutiveLosses - this.suppressedAtLosses;
      if (lossesAfterSuppression >= CRISIS_THRESHOLD) {
        this.panelSuppressed = false;
      }
    }

    // ── Upgrade 1: abstain decision ──────────────────────────────────────────
    // After OWN_LOSS_ABSTAIN_THRESHOLD consecutive own losses, skip this hand
    // entirely and reset the counter so normal operation resumes next hand.
    let forceAbstain = false;
    let abstainReason = "";
    if (this.ownConsecutiveLosses >= OWN_LOSS_ABSTAIN_THRESHOLD) {
      forceAbstain = true;
      abstainReason =
        `Crisis AI standing by — ${this.ownConsecutiveLosses} consecutive background` +
        ` misses (peak this shoe: ${this.ownConsecutiveLossMax}).` +
        ` Observing this hand without prediction to recalibrate shoe model.`;
      // Reset to "skeptical" (1) so we're still somewhat guarded but making predictions next hand
      this.ownConsecutiveLosses = 1;
    }

    // ── Upgrade 2: shoe-survival contrarian engagement check ─────────────────
    // Only engage after a sufficient sample and when shoe-level accuracy is poor.
    // Never engage if self-disable has already fired.
    if (!forceAbstain && !this.shoeSurvivalFailed && !this.contrарianMode) {
      const shoeTotalPredicted = this.shoeOwnWins + this.shoeOwnLosses;
      if (shoeTotalPredicted >= CONTRARIAN_MIN_SAMPLE) {
        const shoeAcc = this.shoeOwnWins / shoeTotalPredicted;
        if (shoeAcc <= CONTRARIAN_ACC_THRESHOLD) {
          // Enter contrarian mode for a block of hands
          this.contrарianMode = true;
          this.contrарianHandsRemaining = CONTRARIAN_BLOCK;
          this.contrарianWins = 0;
          this.contrарianLosses = 0;
        }
      }
    }

    // ── Shoe-survival auto-recovery countdown ────────────────────────────────
    // After SHOE_SURVIVAL_RECOVERY_HANDS hands since self-disable, reset and
    // try again with fresh shoe stats. The shoe pattern may have changed.
    if (this.shoeSurvivalFailed && actual !== null) {
      this.shoeSurvivalFailedHands++;
      if (this.shoeSurvivalFailedHands >= SHOE_SURVIVAL_RECOVERY_HANDS) {
        this.shoeSurvivalFailed = false;
        this.shoeSurvivalFailedHands = 0;
        this.shoeOwnWins = 0;
        this.shoeOwnLosses = 0;
        this.contrарianMode = false;
        this.contrарianHandsRemaining = 0;
        this.contrарianWins = 0;
        this.contrарianLosses = 0;
      }
    }

    // ── Emergency override: extreme loss streak bypasses self-disable ─────────
    // When the main prediction has lost EMERGENCY_OVERRIDE_LOSSES+ consecutive
    // hands and shoeSurvivalFailed is set, the user needs help most. Rather than
    // showing WAIT, we run a reduced scoring pass using ensemble + pattern only.
    const isEmergencyOverride =
      this.shoeSurvivalFailed && this.consecutiveLosses >= EMERGENCY_OVERRIDE_LOSSES;

    // Generate next prediction
    const active = this.consecutiveLosses >= CRISIS_THRESHOLD && !this.panelSuppressed;

    let next: ReturnType<typeof this._scoreRecovery>;
    if (forceAbstain) {
      const pattern = scoreRecentPattern(history);
      next = {
        prediction: null,
        confidence: "LOW" as const,
        reasoning: abstainReason,
        mode: pattern.mode,
        inContrарianMode: false,
        isHighVolatility: false,
        isThrashing: false,
        shoeSurvivalFailed: false,
      };
    } else if (this.shoeSurvivalFailed && !isEmergencyOverride) {
      // Self-disabled, not yet at emergency threshold — show WAIT with retry countdown
      const pattern = scoreRecentPattern(history);
      const handsUntilRetry = SHOE_SURVIVAL_RECOVERY_HANDS - this.shoeSurvivalFailedHands;
      const shoePct = Math.round(
        this.shoeOwnWins / Math.max(1, this.shoeOwnWins + this.shoeOwnLosses) * 100,
      );
      next = {
        prediction: null,
        confidence: "LOW" as const,
        reasoning:
          `Crisis AI self-disabled — shoe survival failed ` +
          `(normal: ${shoePct}%, contrarian also failed). ` +
          `Retrying in ${handsUntilRetry} hand${handsUntilRetry !== 1 ? "s" : ""}. Observing only.`,
        mode: pattern.mode,
        inContrарianMode: false,
        isHighVolatility: false,
        isThrashing: false,
        shoeSurvivalFailed: true,
      };
    } else {
      // Normal scoring OR emergency override (isEmergencyOverride = true)
      next = this._scoreRecovery(
        history,
        experts,
        shadowLeader,
        shadowPred,
        ensembleVerdict,
        ensemblePercent,
        volatilityIndex,
      );
      if (isEmergencyOverride) {
        next = {
          ...next,
          reasoning:
            `⚠ EMERGENCY OVERRIDE — ${this.consecutiveLosses}× loss streak, self-check bypassed; ` +
            next.reasoning,
        };
      }
    }

    this.lastPrediction = next.prediction;
    this.lastPatternMode = next.mode;

    // ── Upgrade 5: track panel toggle count ─────────────────────────────────
    // A "toggle" is panel going from active→inactive (Crisis AI won)
    if (prevResultActive && !active) {
      this.panelToggleCount++;
    }
    this.lastWasActive = active;

    // Build bgLearning message — surface new state modes prominently
    const statusNotes: string[] = [];
    if (this.shoeSurvivalFailed) {
      statusNotes.push(next.reasoning);
    } else if (forceAbstain) {
      statusNotes.push(abstainReason);
    } else {
      if (next.inContrарianMode) {
        const shoeTot = this.shoeOwnWins + this.shoeOwnLosses;
        const shoeAccPct = shoeTot > 0
          ? Math.round(this.shoeOwnWins / shoeTot * 100)
          : 0;
        statusNotes.push(
          `⟳ Contrarian mode active — shoe accuracy ${shoeAccPct}% over ${shoeTot} hands; ` +
          `${this.contrарianHandsRemaining} hands remaining in block`,
        );
      }
      if (next.isHighVolatility) {
        statusNotes.push(
          `High-volatility shoe (VI: ${Math.round(volatilityIndex * 100)}%) — ` +
          `expert weights reduced, confidence capped`,
        );
      }
      if (next.isThrashing) {
        statusNotes.push(
          `Thrash guard active (${this.panelToggleCount} panel cycles) — low-conviction mode`,
        );
      }
    }

    let bgLearning: string;
    if (statusNotes.length > 0) {
      bgLearning = statusNotes.join("; ");
      if (!forceAbstain && this.shoeAdaptation.lastAnalysis) {
        bgLearning += `; ${this.shoeAdaptation.lastAnalysis}`;
      }
    } else if (this.shoeAdaptation.lastAnalysis) {
      bgLearning = this.shoeAdaptation.lastAnalysis;
    } else if (this.shoeAdaptation.handsAnalyzed > 0) {
      bgLearning =
        `Background learning: ${this.shoeAdaptation.handsAnalyzed} hands, ` +
        `${this.shoeAdaptation.wrongCount} corrections applied`;
    } else {
      bgLearning = "Background process active — warming up";
    }

    this._result = active
      ? {
          active: true,
          prediction: next.prediction,
          confidence: next.confidence,
          reasoning: this.lastAnalysis
            ? `${next.reasoning}; ${this.lastAnalysis}`
            : next.reasoning,
          consecutiveLosses: this.consecutiveLosses,
          backgroundPrediction: next.prediction,
          bgLearning,
        }
      : {
          active: false,
          prediction: null,
          confidence: "LOW",
          reasoning: "",
          consecutiveLosses: this.consecutiveLosses,
          backgroundPrediction: next.prediction,
          bgLearning,
        };
  }

  /**
   * Compute reliability from a rolling boolean hit window.
   * Returns 0.75 (neutral baseline) when there are fewer than 2 data points.
   */
  private _computeReliability(hits: boolean[]): number {
    if (hits.length < 2) return 0.75;
    const correct = hits.filter(Boolean).length;
    return clamp(correct / hits.length, 0.25, 1.0);
  }

  /**
   * Base learning layer (original logic, preserved).
   * Updates per-expert trust and per-pattern-mode trust.
   */
  private _learnFromOutcome(
    actual: Side,
    history: string[],
    experts: ExpertShoeData[],
    crisisPredictionCorrect: boolean,
  ): void {
    const learningWords = crisisPredictionCorrect ? "recovery correct" : "recovery missed";
    const priorHands = cleanHistory(history).slice(-3, -1).join(" ") || "limited history";

    for (const expert of experts) {
      if (!expert.lastPred) continue;
      const learning = this.expertLearning[expert.key] ?? freshExpertLearning();
      this.expertLearning[expert.key] = learning;
      if (expert.lastPred === actual) {
        learning.correct++;
        learning.trust = clamp(learning.trust + 0.06, 0.55, 1.45);
      } else {
        learning.wrong++;
        learning.trust = clamp(learning.trust - 0.08, 0.55, 1.45);
      }
    }

    const previousModeTrust = this.patternTrust[this.lastPatternMode];
    this.patternTrust[this.lastPatternMode] = clamp(
      previousModeTrust + (crisisPredictionCorrect ? 0.05 : -0.07),
      0.55,
      1.45,
    );

    if (crisisPredictionCorrect) {
      this.lastAnalysis = `self-check ${learningWords} after ${priorHands}`;
      return;
    }

    const downweighted = experts
      .filter((expert) => expert.lastPred && expert.lastPred !== actual)
      .sort((a, b) => {
        const aTrust = this.expertLearning[a.key]?.trust ?? 1;
        const bTrust = this.expertLearning[b.key]?.trust ?? 1;
        return aTrust - bTrust;
      })
      .slice(0, 2)
      .map((expert) => EXPERT_LABELS[expert.key] ?? expert.key)
      .join(" and ");
    const adjustment = downweighted
      ? `downweighted ${downweighted}`
      : `${this.lastPatternMode} pattern trust adjusted`;
    this.lastAnalysis = `self-check ${learningWords} after ${priorHands}; ${adjustment}`;
  }

  /**
   * Deep wrong-prediction analysis.
   *
   * When Crisis AI's prediction was wrong, this method:
   *   1. Examines recent context using an auto-length window (up to 5 prior hands,
   *      scaled to what's available) rather than a fixed 2-hand look-back.
   *   2. Identifies which experts correctly pointed to the actual outcome
   *   3. Identifies which experts were misleading (agreed with wrong prediction)
   *   4. Adjusts shoe-specific expert boosts and side bias
   *   5. Produces a human-readable analysis of what went wrong
   */
  private _analyzeWrongPrediction(
    wrongPred: Side,
    actual: Side,
    history: string[],
    experts: ExpertShoeData[],
  ): void {
    this.shoeAdaptation.wrongCount++;

    const clean = cleanHistory(history);
    // Auto-length context: use up to 5 prior hands (excluding the outcome itself)
    // so the analysis reflects a richer window as the shoe develops
    const contextLen = Math.min(5, Math.max(1, clean.length - 1));
    const contextHands = clean.slice(-(contextLen + 1), -1);
    const contextStr = contextHands.length >= 2
      ? contextHands.join("→")
      : contextHands.join("") || "early shoe";

    const correctExperts: Array<{ key: string; baseWeight: number }> = [];
    const wrongExperts: Array<{ key: string; baseWeight: number }> = [];

    for (const expert of experts) {
      if (!expert.lastPred) continue;
      const total = expert.wins + expert.losses;
      if (total === 0) continue;
      const reliability = clamp((expert.wins + 1) / (total + 2), 0.25, 0.75);
      const composite = clamp(expert.compositeScore || reliability, 0.2, 1);
      const baseWeight = 0.65 + reliability * 0.55 + composite * 0.35;

      if (expert.lastPred === actual) {
        correctExperts.push({ key: expert.key, baseWeight });
        this.shoeAdaptation.expertBoost[expert.key] = clamp(
          (this.shoeAdaptation.expertBoost[expert.key] ?? 0) + 0.035,
          -0.35,
          0.35,
        );
      } else if (expert.lastPred === wrongPred) {
        wrongExperts.push({ key: expert.key, baseWeight });
        this.shoeAdaptation.expertBoost[expert.key] = clamp(
          (this.shoeAdaptation.expertBoost[expert.key] ?? 0) - 0.045,
          -0.35,
          0.35,
        );
      }
    }

    const decayFactor = Math.max(0.4, 1 - this.shoeAdaptation.wrongCount * 0.015);
    const biasStep = 0.045 * decayFactor;

    if (actual === "P") {
      this.shoeAdaptation.playerBias = clamp(
        this.shoeAdaptation.playerBias + biasStep,
        -0.6,
        0.6,
      );
      this.shoeAdaptation.bankerBias = clamp(
        this.shoeAdaptation.bankerBias - biasStep * 0.4,
        -0.6,
        0.6,
      );
    } else {
      this.shoeAdaptation.bankerBias = clamp(
        this.shoeAdaptation.bankerBias + biasStep,
        -0.6,
        0.6,
      );
      this.shoeAdaptation.playerBias = clamp(
        this.shoeAdaptation.playerBias - biasStep * 0.4,
        -0.6,
        0.6,
      );
    }

    const patternStep = 0.03 * decayFactor;
    this.shoeAdaptation.patternBoost[this.lastPatternMode] = clamp(
      this.shoeAdaptation.patternBoost[this.lastPatternMode] - patternStep,
      -0.3,
      0.3,
    );

    const correctNames = correctExperts
      .sort((a, b) => b.baseWeight - a.baseWeight)
      .slice(0, 3)
      .map((e) => EXPERT_LABELS[e.key] ?? e.key)
      .join(", ");
    const wrongNames = wrongExperts
      .sort((a, b) => b.baseWeight - a.baseWeight)
      .slice(0, 2)
      .map((e) => EXPERT_LABELS[e.key] ?? e.key)
      .join(", ");

    const biasStr =
      actual === "P"
        ? `P bias +${biasStep.toFixed(3)}`
        : `B bias +${biasStep.toFixed(3)}`;
    const wrongExpertNote = wrongNames ? `; ${wrongNames} misled` : "";

    this.shoeAdaptation.lastAnalysis =
      `Missed ${sideName(actual)} (called ${sideName(wrongPred)}) after ${contextStr}` +
      (correctNames ? `; ${correctNames} had the edge` : "") +
      wrongExpertNote +
      `; shoe ${biasStr} (correction #${this.shoeAdaptation.wrongCount})`;
  }

  private _scoreRecovery(
    history: string[],
    experts: ExpertShoeData[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
    volatilityIndex: number,
  ): {
    prediction: Side | null;
    confidence: CrisisResult["confidence"];
    reasoning: string;
    mode: PatternMode;
    inContrарianMode: boolean;
    isHighVolatility: boolean;
    isThrashing: boolean;
    shoeSurvivalFailed: boolean;
  } {
    // ── Upgrade 4: adaptive ensemble/shadow reliability ──────────────────────
    const ensembleReliability = this._computeReliability(this.recentEnsembleCorrect);
    const shadowReliability = this._computeReliability(this.recentShadowCorrect);

    // ── Upgrade 3 + 5: volatility and thrash guards ──────────────────────────
    const isHighVolatility = volatilityIndex > VOLATILITY_HIGH_THRESHOLD;
    const isThrashing = this.panelToggleCount >= THRASH_TOGGLE_THRESHOLD;

    // Compound expert scale factor
    let expertScaleFactor = 1.0;
    if (isHighVolatility) expertScaleFactor *= VOLATILITY_EXPERT_SCALE;
    if (isThrashing) expertScaleFactor *= THRASH_EXPERT_SCALE;

    // Max confidence allowed under current conditions
    const confOrder: Array<CrisisResult["confidence"]> = ["LOW", "MED", "HIGH"];
    const maxConfidenceIdx = isHighVolatility || isThrashing ? 1 : 2; // MED or HIGH

    let playerScore = 0;
    let bankerScore = 0;
    const playerExperts: Array<{ label: string; weight: number }> = [];
    const bankerExperts: Array<{ label: string; weight: number }> = [];

    for (const expert of experts) {
      if (!expert.lastPred) continue;
      const total = expert.wins + expert.losses;
      if (total === 0) continue;

      const learning = this.expertLearning[expert.key] ?? freshExpertLearning();
      this.expertLearning[expert.key] = learning;
      const reliability = clamp((expert.wins + 1) / (total + 2), 0.25, 0.75);
      const composite = clamp(expert.compositeScore || reliability, 0.2, 1);

      const shoeBoost = this.shoeAdaptation.expertBoost[expert.key] ?? 0;
      let weight =
        (0.65 + reliability * 0.55 + composite * 0.35) * learning.trust * (1 + shoeBoost);

      if (expert.momentum === "up") weight *= 1.08;
      if (expert.momentum === "down") weight *= 0.9;
      if (expert.currentRunIsWin === true)
        weight *= 1 + Math.min(expert.currentRunLen * 0.025, 0.1);
      if (expert.currentRunIsWin === false)
        weight *= Math.max(0.72, 1 - expert.currentRunLen * 0.06);

      // Upgrade 3/5: apply compound scale factor
      weight *= expertScaleFactor;

      const target = expert.lastPred === "P" ? playerExperts : bankerExperts;
      target.push({ label: EXPERT_LABELS[expert.key] ?? expert.key, weight });
      if (expert.lastPred === "P") playerScore += weight;
      else bankerScore += weight;
    }

    const pattern = scoreRecentPattern(history);
    const modeWeight = this.patternTrust[pattern.mode];
    playerScore += pattern.p * modeWeight;
    bankerScore += pattern.b * modeWeight;

    const patternBoostValue = this.shoeAdaptation.patternBoost[pattern.mode];
    if (patternBoostValue !== 0) {
      if (pattern.p > pattern.b) playerScore += patternBoostValue;
      else if (pattern.b > pattern.p) bankerScore += patternBoostValue;
    }

    // ── Upgrade 4: adaptive ensemble/shadow bonuses ──────────────────────────
    // Scale bonuses by recent accuracy instead of hardcoded 1.25/0.8
    const ensembleBonus = clamp(1.25 * ensembleReliability, 0.35, 1.5);
    const shadowBonus = clamp(0.8 * shadowReliability, 0.2, 1.0);

    if (ensembleVerdict === "P") playerScore += ensembleBonus * clamp(ensemblePercent / 100, 0.5, 1);
    if (ensembleVerdict === "B") bankerScore += ensembleBonus * clamp(ensemblePercent / 100, 0.5, 1);
    if (shadowPred === "P") playerScore += shadowBonus;
    if (shadowPred === "B") bankerScore += shadowBonus;

    // Apply shoe-learned side bias
    playerScore += this.shoeAdaptation.playerBias;
    bankerScore += this.shoeAdaptation.bankerBias;

    const totalScore = playerScore + bankerScore;
    const margin = totalScore > 0 ? Math.abs(playerScore - bankerScore) / totalScore : 0;

    let prediction: Side;
    if (playerScore > bankerScore) prediction = "P";
    else if (bankerScore > playerScore) prediction = "B";
    else if (ensembleVerdict) prediction = ensembleVerdict;
    else if (this.lastMainPred) prediction = opposite(this.lastMainPred);
    else prediction = "B";

    // ── Upgrade 2: shoe-survival contrarian mode (replaces 3-loss flip) ────────
    // If contrarian mode is active (engaged by evaluateOutcome above), flip the
    // prediction. This is a sustained mode, not a one-hand reactive flip.
    const inContrарianMode = this.contrарianMode;
    if (inContrарianMode) {
      prediction = opposite(prediction);
    }

    const winningExperts = prediction === "P" ? playerExperts : bankerExperts;
    const agreeingCount = winningExperts.length;
    const ensembleAgrees = ensembleVerdict === prediction;
    const shadowAgrees = shadowPred === prediction;

    // In contrarian mode cap confidence at MED — we're operating against the model
    const contrарianMaxIdx = inContrарianMode ? 1 : 2;
    const effectiveMaxIdx = Math.min(maxConfidenceIdx, contrарianMaxIdx);

    let rawConfidenceIdx =
      agreeingCount >= 4 && margin >= 0.2 && (ensembleAgrees || shadowAgrees)
        ? 2 // HIGH
        : agreeingCount >= 2 && margin >= 0.08
          ? 1 // MED
          : 0; // LOW

    rawConfidenceIdx = Math.min(rawConfidenceIdx, effectiveMaxIdx);
    const confidence = confOrder[rawConfidenceIdx];

    const strongestExperts = winningExperts
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((expert) => expert.label)
      .join(", ");
    const agreement = strongestExperts
      ? `${strongestExperts} favor ${sideName(prediction)}`
      : `${sideName(prediction)} has the stronger local score`;

    const ensembleReliabilityPct = Math.round(ensembleReliability * 100);
    const confirmations = [
      ensembleAgrees
        ? `ensemble ${ensemblePercent}% agrees (${ensembleReliabilityPct}% recent reliability)`
        : "",
      shadowAgrees && shadowLeader
        ? `shadow ${EXPERT_LABELS[shadowLeader] ?? shadowLeader} agrees`
        : "",
    ].filter(Boolean);
    const confirmationText = confirmations.length > 0 ? `; ${confirmations.join(", ")}` : "";

    const shoeNote =
      Math.abs(this.shoeAdaptation.playerBias) > 0.05 ||
      Math.abs(this.shoeAdaptation.bankerBias) > 0.05
        ? `; shoe-adapted (${this.shoeAdaptation.wrongCount} corrections)`
        : "";

    const contraryNote = inContrарianMode
      ? `; ⟳ contrarian mode (${this.contrарianHandsRemaining} hands remaining)`
      : "";
    const volatileNote = isHighVolatility
      ? `; ⚡ high-vol shoe (VI ${Math.round(volatilityIndex * 100)}%, scale ×${VOLATILITY_EXPERT_SCALE})`
      : "";
    const thrashNote = isThrashing
      ? `; 🔄 thrash guard (${this.panelToggleCount} cycles)`
      : "";

    return {
      prediction,
      confidence,
      mode: pattern.mode,
      inContrарianMode,
      isHighVolatility,
      isThrashing,
      shoeSurvivalFailed: false,
      reasoning:
        `Internal score ${Math.round(playerScore * 10) / 10}/${Math.round(bankerScore * 10) / 10}; ` +
        `${agreement}${confirmationText}; ${pattern.note}${shoeNote}${contraryNote}${volatileNote}${thrashNote}`,
    };
  }

  getResult(): CrisisResult {
    return { ...this._result, consecutiveLosses: this.consecutiveLosses };
  }

  private _save(): void {
    this._undoStack.push({
      consecutiveLosses: this.consecutiveLosses,
      suppressedAtLosses: this.suppressedAtLosses,
      lastMainPred: this.lastMainPred,
      lastPrediction: this.lastPrediction,
      lastPatternMode: this.lastPatternMode,
      panelSuppressed: this.panelSuppressed,
      lastAnalysis: this.lastAnalysis,
      result: { ...this._result },
      expertLearning: Object.fromEntries(
        Object.entries(this.expertLearning).map(([key, value]) => [key, { ...value }]),
      ),
      patternTrust: { ...this.patternTrust },
      shoeAdaptation: cloneShoeAdaptation(this.shoeAdaptation),
      // v2
      ownConsecutiveLosses: this.ownConsecutiveLosses,
      ownConsecutiveLossMax: this.ownConsecutiveLossMax,
      panelToggleCount: this.panelToggleCount,
      lastWasActive: this.lastWasActive,
      recentEnsembleCorrect: [...this.recentEnsembleCorrect],
      recentShadowCorrect: [...this.recentShadowCorrect],
      // v2 shoe-survival
      shoeOwnWins: this.shoeOwnWins,
      shoeOwnLosses: this.shoeOwnLosses,
      contrарianMode: this.contrарianMode,
      contrарianHandsRemaining: this.contrарianHandsRemaining,
      contrарianWins: this.contrарianWins,
      contrарianLosses: this.contrарianLosses,
      shoeSurvivalFailed: this.shoeSurvivalFailed,
      shoeSurvivalFailedHands: this.shoeSurvivalFailedHands,
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  undoLast(): void {
    const prev = this._undoStack.pop();
    if (!prev) return;
    this.consecutiveLosses = prev.consecutiveLosses;
    this.suppressedAtLosses = prev.suppressedAtLosses;
    this.lastMainPred = prev.lastMainPred;
    this.lastPrediction = prev.lastPrediction;
    this.lastPatternMode = prev.lastPatternMode;
    this.panelSuppressed = prev.panelSuppressed;
    this.lastAnalysis = prev.lastAnalysis;
    this._result = prev.result;
    this.expertLearning = Object.fromEntries(
      Object.entries(prev.expertLearning).map(([key, value]) => [key, { ...value }]),
    );
    this.patternTrust = { ...prev.patternTrust };
    this.shoeAdaptation = cloneShoeAdaptation(prev.shoeAdaptation);
    // v2
    this.ownConsecutiveLosses = prev.ownConsecutiveLosses;
    this.ownConsecutiveLossMax = prev.ownConsecutiveLossMax;
    this.panelToggleCount = prev.panelToggleCount;
    this.lastWasActive = prev.lastWasActive;
    this.recentEnsembleCorrect = [...prev.recentEnsembleCorrect];
    this.recentShadowCorrect = [...prev.recentShadowCorrect];
    // v2 shoe-survival
    this.shoeOwnWins = prev.shoeOwnWins;
    this.shoeOwnLosses = prev.shoeOwnLosses;
    this.contrарianMode = prev.contrарianMode;
    this.contrарianHandsRemaining = prev.contrарianHandsRemaining;
    this.contrарianWins = prev.contrарianWins;
    this.contrарianLosses = prev.contrарianLosses;
    this.shoeSurvivalFailed = prev.shoeSurvivalFailed;
    this.shoeSurvivalFailedHands = prev.shoeSurvivalFailedHands;
  }

  reset(): void {
    this.consecutiveLosses = 0;
    this.suppressedAtLosses = 0;
    this.lastMainPred = null;
    this.lastPrediction = null;
    this.lastPatternMode = "balanced";
    this.panelSuppressed = false;
    this.lastAnalysis = "";
    this.expertLearning = createExpertLearning();
    this.patternTrust = { run: 1, alternating: 1, balanced: 1 };
    this.shoeAdaptation = freshShoeAdaptation();
    this._result = {
      active: false,
      prediction: null,
      confidence: "LOW",
      reasoning: "",
      consecutiveLosses: 0,
      backgroundPrediction: null,
      bgLearning: "",
    };
    this._undoStack = [];
    // v2
    this.ownConsecutiveLosses = 0;
    this.ownConsecutiveLossMax = 0;
    this.panelToggleCount = 0;
    this.lastWasActive = false;
    this.recentEnsembleCorrect = [];
    this.recentShadowCorrect = [];
    // v2 shoe-survival
    this.shoeOwnWins = 0;
    this.shoeOwnLosses = 0;
    this.contrарianMode = false;
    this.contrарianHandsRemaining = 0;
    this.contrарianWins = 0;
    this.contrарianLosses = 0;
    this.shoeSurvivalFailed = false;
    this.shoeSurvivalFailedHands = 0;
  }
}
