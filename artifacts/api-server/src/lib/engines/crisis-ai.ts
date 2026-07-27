/**
 * Internal Crisis AI — a bounded, self-learning recovery engine.
 *
 * It runs entirely in-process. There are no API calls, credentials, model
 * timeouts, or external responses to wait for. Every hand:
 *   1. scores the previous Crisis AI prediction against the actual outcome,
 *   2. updates shoe-pattern and per-expert trust (base learning),
 *   3. runs deep wrong-prediction analysis when prediction missed — examining
 *      the last two hands, which experts were correct, and what score path
 *      would have led to the right answer — and adjusts shoe-specific biases,
 *   4. generates the next prediction from the newly learned state.
 *
 * The background process always runs regardless of panel visibility.
 * Panel activation: two consecutive main-prediction losses.
 * Panel close: when Crisis AI's own prediction wins.
 * Panel re-arm: if main prediction loses 2 consecutive times again after close.
 */

type Side = "P" | "B";
type PatternMode = "run" | "alternating" | "balanced";

const CRISIS_THRESHOLD = 2;

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
 * Detect the current shoe mode. The signal is deliberately capped: it can
 * tune expert scores but cannot overpower broad expert agreement by itself.
 */
function scoreRecentPattern(history: string[]): LocalSignal {
  const clean = cleanHistory(history);
  if (clean.length === 0) {
    return { p: 0, b: 0, mode: "balanced", note: "waiting for road data" };
  }

  const last = clean[clean.length - 1];
  let runLength = 1;
  for (let i = clean.length - 2; i >= 0 && clean[i] === last; i--) runLength++;

  let p = 0;
  let b = 0;
  const notes: string[] = [];
  const tail = clean.slice(-7);
  let transitions = 0;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] !== tail[i - 1]) transitions++;
  }

  if (runLength >= 2) {
    const amount = Math.min(0.08 + (runLength - 2) * 0.025, 0.16);
    if (last === "P") p += amount;
    else b += amount;
    notes.push(`${runLength}-hand ${sideName(last)} run`);
    return { p, b, mode: "run", note: notes.join(", ") };
  }

  if (tail.length >= 5 && transitions / (tail.length - 1) >= 0.8) {
    const reversal = opposite(last);
    if (reversal === "P") p += 0.1;
    else b += 0.1;
    notes.push("alternating road");
    return { p, b, mode: "alternating", note: notes.join(", ") };
  }

  const balanceTail = clean.slice(-8);
  const playerCount = balanceTail.filter((hand) => hand === "P").length;
  const bankerCount = balanceTail.length - playerCount;
  if (Math.abs(playerCount - bankerCount) >= 4) {
    const lessFrequent: Side = playerCount < bankerCount ? "P" : "B";
    if (lessFrequent === "P") p += 0.05;
    else b += 0.05;
    notes.push(`${sideName(lessFrequent)} underrepresented recently`);
  }

  return { p, b, mode: "balanced", note: notes.join(", ") || "mixed recent road" };
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

  setMainPrediction(pred: Side | null): void {
    this.lastMainPred = pred;
  }

  /**
   * Score the previous local prediction, learn from the current shoe, and
   * produce the next prediction. Background process always runs — panel
   * visibility is controlled separately by the active/suppressed flags.
   */
  evaluateOutcome(
    actual: Side | null,
    history: string[],
    experts: ExpertShoeData[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
  ): void {
    this._save();

    const wasActive = this._result.active;
    const previousPrediction = this.lastPrediction;
    let crisisPredictionCorrect: boolean | null = null;

    if (actual !== null) {
      // ── Background self-learning: always runs ────────────────────────────
      this.shoeAdaptation.handsAnalyzed++;

      if (previousPrediction !== null) {
        crisisPredictionCorrect = previousPrediction === actual;

        // Base learning (existing logic — preserved)
        this._learnFromOutcome(actual, history, experts, crisisPredictionCorrect);

        // Deep wrong-prediction analysis (new)
        if (!crisisPredictionCorrect) {
          this._analyzeWrongPrediction(previousPrediction, actual, history, experts);
        } else {
          this.shoeAdaptation.correctCount++;
          this.shoeAdaptation.lastAnalysis = `Correct: predicted ${sideName(previousPrediction)} — confirmed. Shoe model reinforced.`;
        }
      }

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
      if (wasActive && crisisPredictionCorrect === true && this.consecutiveLosses > 0) {
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

    // Generate next prediction (always runs in background)
    const next = this._scoreRecovery(
      history,
      experts,
      shadowLeader,
      shadowPred,
      ensembleVerdict,
      ensemblePercent,
    );
    this.lastPrediction = next.prediction;
    this.lastPatternMode = next.mode;

    const active = this.consecutiveLosses >= CRISIS_THRESHOLD && !this.panelSuppressed;

    const bgLearning = this.shoeAdaptation.lastAnalysis
      ? this.shoeAdaptation.lastAnalysis
      : this.shoeAdaptation.handsAnalyzed > 0
        ? `Background learning: ${this.shoeAdaptation.handsAnalyzed} hands, ${this.shoeAdaptation.wrongCount} corrections applied`
        : "Background process active — warming up";

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
   * Deep wrong-prediction analysis (new learning layer).
   *
   * When Crisis AI's prediction was wrong, this method:
   *   1. Examines the last two hands for context
   *   2. Identifies which experts correctly pointed to the actual outcome
   *   3. Identifies which experts were misleading (agreed with wrong prediction)
   *   4. Adjusts shoe-specific expert boosts and side bias
   *   5. Produces a human-readable analysis of what went wrong
   *
   * This is additive to the base learning layer above — it creates a
   * shoe-specific correction model that tunes the scoring formula for the
   * current shoe's behavior patterns.
   */
  private _analyzeWrongPrediction(
    wrongPred: Side,
    actual: Side,
    history: string[],
    experts: ExpertShoeData[],
  ): void {
    this.shoeAdaptation.wrongCount++;

    // Context: last 2 hands before the current one
    const clean = cleanHistory(history);
    const last2 = clean.slice(-3, -1);
    const contextStr = last2.length >= 2 ? last2.join("→") : last2.join("") || "early shoe";

    // Categorize experts by whether they aligned with actual or wrong prediction
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
        // Boost this expert's shoe-specific weight
        this.shoeAdaptation.expertBoost[expert.key] = clamp(
          (this.shoeAdaptation.expertBoost[expert.key] ?? 0) + 0.035,
          -0.35,
          0.35,
        );
      } else if (expert.lastPred === wrongPred) {
        wrongExperts.push({ key: expert.key, baseWeight });
        // Dampen this expert for this shoe
        this.shoeAdaptation.expertBoost[expert.key] = clamp(
          (this.shoeAdaptation.expertBoost[expert.key] ?? 0) - 0.045,
          -0.35,
          0.35,
        );
      }
    }

    // Adjust shoe-side bias toward the actual outcome
    // Step size decays slightly as more corrections accumulate (more stable over time)
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

    // Also adjust the pattern boost for the mode that was active when wrong
    const patternStep = 0.03 * decayFactor;
    // The wrong-prediction pattern mode gets a small negative correction
    this.shoeAdaptation.patternBoost[this.lastPatternMode] = clamp(
      this.shoeAdaptation.patternBoost[this.lastPatternMode] - patternStep,
      -0.3,
      0.3,
    );

    // Build analysis message
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
  ): {
    prediction: Side;
    confidence: CrisisResult["confidence"];
    reasoning: string;
    mode: PatternMode;
  } {
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

      // Apply shoe-specific expert boost on top of base trust (new)
      const shoeBoost = this.shoeAdaptation.expertBoost[expert.key] ?? 0;
      let weight =
        (0.65 + reliability * 0.55 + composite * 0.35) * learning.trust * (1 + shoeBoost);

      if (expert.momentum === "up") weight *= 1.08;
      if (expert.momentum === "down") weight *= 0.9;
      if (expert.currentRunIsWin === true)
        weight *= 1 + Math.min(expert.currentRunLen * 0.025, 0.1);
      if (expert.currentRunIsWin === false)
        weight *= Math.max(0.72, 1 - expert.currentRunLen * 0.06);

      const target = expert.lastPred === "P" ? playerExperts : bankerExperts;
      target.push({ label: EXPERT_LABELS[expert.key] ?? expert.key, weight });
      if (expert.lastPred === "P") playerScore += weight;
      else bankerScore += weight;
    }

    const pattern = scoreRecentPattern(history);
    const modeWeight = this.patternTrust[pattern.mode];
    playerScore += pattern.p * modeWeight;
    bankerScore += pattern.b * modeWeight;

    // Apply shoe-specific pattern boost (new)
    const patternBoostValue = this.shoeAdaptation.patternBoost[pattern.mode];
    if (patternBoostValue !== 0) {
      // Boost whichever side the pattern was favoring
      if (pattern.p > pattern.b) playerScore += patternBoostValue;
      else if (pattern.b > pattern.p) bankerScore += patternBoostValue;
    }

    if (ensembleVerdict === "P") playerScore += 1.25 * clamp(ensemblePercent / 100, 0.5, 1);
    if (ensembleVerdict === "B") bankerScore += 1.25 * clamp(ensemblePercent / 100, 0.5, 1);
    if (shadowPred === "P") playerScore += 0.8;
    if (shadowPred === "B") bankerScore += 0.8;

    // Apply shoe-learned side bias (new — additive after all other scoring)
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

    const winningExperts = prediction === "P" ? playerExperts : bankerExperts;
    const agreeingCount = winningExperts.length;
    const ensembleAgrees = ensembleVerdict === prediction;
    const shadowAgrees = shadowPred === prediction;
    const confidence: CrisisResult["confidence"] =
      agreeingCount >= 4 && margin >= 0.2 && (ensembleAgrees || shadowAgrees)
        ? "HIGH"
        : agreeingCount >= 2 && margin >= 0.08
          ? "MED"
          : "LOW";

    const strongestExperts = winningExperts
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((expert) => expert.label)
      .join(", ");
    const agreement = strongestExperts
      ? `${strongestExperts} favor ${sideName(prediction)}`
      : `${sideName(prediction)} has the stronger local score`;
    const confirmations = [
      ensembleAgrees ? `ensemble ${ensemblePercent}% agrees` : "",
      shadowAgrees && shadowLeader
        ? `shadow ${EXPERT_LABELS[shadowLeader] ?? shadowLeader} agrees`
        : "",
    ].filter(Boolean);
    const confirmationText = confirmations.length > 0 ? `; ${confirmations.join(", ")}` : "";

    // Note shoe adaptation in reasoning when meaningful
    const shoeNote =
      Math.abs(this.shoeAdaptation.playerBias) > 0.05 ||
      Math.abs(this.shoeAdaptation.bankerBias) > 0.05
        ? `; shoe-adapted (${this.shoeAdaptation.wrongCount} corrections)`
        : "";

    return {
      prediction,
      confidence,
      mode: pattern.mode,
      reasoning:
        `Internal score ${Math.round(playerScore * 10) / 10}/${Math.round(bankerScore * 10) / 10}; ` +
        `${agreement}${confirmationText}; ${pattern.note}${shoeNote}`,
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
  }
}
