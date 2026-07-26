/**
 * Internal Crisis AI — activates after N consecutive main prediction losses.
 *
 * This is deliberately an in-process decision engine. It does not call a
 * hosted model, use an API key, wait on a network request, or parse external
 * text. Every hand is scored immediately from the app's live expert state.
 *
 * Integration contract:
 *   1. Before regime.evaluateOutcome(): crisisAI.setMainPrediction(...)
 *   2. After regime.evaluateOutcome(): crisisAI.evaluateOutcome(...)
 *   3. On undo: crisisAI.undoLast()
 *   4. On reset: crisisAI.reset()
 */

type Side = "P" | "B";

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
}

interface CrisisSnap {
  consecutiveLosses: number;
  lastMainPred: Side | null;
  result: CrisisResult;
}

interface LocalSignal {
  p: number;
  b: number;
  note: string;
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

/**
 * Extract small, intentionally conservative signals from the recent shoe.
 * These are supporting signals only; expert agreement remains the main input.
 */
function scoreRecentPattern(history: string[]): LocalSignal {
  const clean = history.filter((hand): hand is Side => hand === "P" || hand === "B");
  if (clean.length === 0) return { p: 0, b: 0, note: "waiting for road data" };

  const last = clean[clean.length - 1];
  let runLength = 1;
  for (let i = clean.length - 2; i >= 0 && clean[i] === last; i--) runLength++;

  let p = 0;
  let b = 0;
  const notes: string[] = [];

  if (runLength >= 2) {
    // A run is a useful descriptive signal, but it is capped so it cannot
    // dominate the independently measured expert scores.
    const amount = Math.min(0.08 + (runLength - 2) * 0.025, 0.16);
    if (last === "P") p += amount;
    else b += amount;
    notes.push(`${runLength}-hand ${sideName(last)} run`);
  }

  const tail = clean.slice(-7);
  let transitions = 0;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] !== tail[i - 1]) transitions++;
  }
  if (tail.length >= 5 && transitions / (tail.length - 1) >= 0.8) {
    const reversal = opposite(last);
    if (reversal === "P") p += 0.1;
    else b += 0.1;
    notes.push("alternating road");
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

  return { p, b, note: notes.join(", ") || "mixed recent road" };
}

export class CrisisAI {
  private consecutiveLosses = 0;
  private lastMainPred: Side | null = null;
  private _result: CrisisResult = {
    active: false,
    prediction: null,
    confidence: "LOW",
    reasoning: "",
    consecutiveLosses: 0,
  };
  private _undoStack: CrisisSnap[] = [];

  setMainPrediction(pred: Side | null): void {
    this.lastMainPred = pred;
  }

  /**
   * Update the internal recovery model after every non-tie hand. This is
   * synchronous by design: the calculation is local and bounded.
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

    if (actual === null || this.lastMainPred === null) return;

    if (this.lastMainPred === actual) {
      this.consecutiveLosses = 0;
      this._result = {
        active: false,
        prediction: null,
        confidence: "LOW",
        reasoning: "",
        consecutiveLosses: 0,
      };
      return;
    }

    this.consecutiveLosses++;
    if (this.consecutiveLosses < CRISIS_THRESHOLD) return;

    this._result = this._scoreRecovery(
      history,
      experts,
      shadowLeader,
      shadowPred,
      ensembleVerdict,
      ensemblePercent,
    );
  }

  private _scoreRecovery(
    history: string[],
    experts: ExpertShoeData[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
  ): CrisisResult {
    let playerScore = 0;
    let bankerScore = 0;
    const playerExperts: Array<{ label: string; weight: number }> = [];
    const bankerExperts: Array<{ label: string; weight: number }> = [];

    for (const expert of experts) {
      if (!expert.lastPred) continue;
      const total = expert.wins + expert.losses;
      if (total === 0) continue;

      // Laplace smoothing avoids letting a tiny sample size look certain.
      const reliability = clamp((expert.wins + 1) / (total + 2), 0.25, 0.75);
      const composite = clamp(expert.compositeScore || reliability, 0.2, 1);
      let weight = 0.65 + reliability * 0.55 + composite * 0.35;

      if (expert.momentum === "up") weight *= 1.08;
      if (expert.momentum === "down") weight *= 0.9;
      if (expert.currentRunIsWin === true) weight *= 1 + Math.min(expert.currentRunLen * 0.025, 0.1);
      if (expert.currentRunIsWin === false) weight *= Math.max(0.72, 1 - expert.currentRunLen * 0.06);

      if (expert.lastPred === "P") {
        playerScore += weight;
        playerExperts.push({ label: EXPERT_LABELS[expert.key] ?? expert.key, weight });
      } else {
        bankerScore += weight;
        bankerExperts.push({ label: EXPERT_LABELS[expert.key] ?? expert.key, weight });
      }
    }

    const pattern = scoreRecentPattern(history);
    playerScore += pattern.p;
    bankerScore += pattern.b;

    if (ensembleVerdict === "P") playerScore += 1.25 * clamp(ensemblePercent / 100, 0.5, 1);
    if (ensembleVerdict === "B") bankerScore += 1.25 * clamp(ensemblePercent / 100, 0.5, 1);

    if (shadowPred === "P") playerScore += 0.8;
    if (shadowPred === "B") bankerScore += 0.8;

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
      shadowAgrees && shadowLeader ? `shadow ${EXPERT_LABELS[shadowLeader] ?? shadowLeader} agrees` : "",
    ].filter(Boolean);
    const confirmationText = confirmations.length > 0 ? `; ${confirmations.join(", ")}` : "";

    return {
      active: true,
      prediction,
      confidence,
      reasoning: `Internal score ${Math.round(playerScore * 10) / 10}/${Math.round(bankerScore * 10) / 10}; ${agreement}${confirmationText}; ${pattern.note}`,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  getResult(): CrisisResult {
    return { ...this._result, consecutiveLosses: this.consecutiveLosses };
  }

  private _save(): void {
    this._undoStack.push({
      consecutiveLosses: this.consecutiveLosses,
      lastMainPred: this.lastMainPred,
      result: { ...this._result },
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  undoLast(): void {
    const prev = this._undoStack.pop();
    if (!prev) return;
    this.consecutiveLosses = prev.consecutiveLosses;
    this.lastMainPred = prev.lastMainPred;
    this._result = prev.result;
  }

  reset(): void {
    this.consecutiveLosses = 0;
    this.lastMainPred = null;
    this._result = {
      active: false,
      prediction: null,
      confidence: "LOW",
      reasoning: "",
      consecutiveLosses: 0,
    };
    this._undoStack = [];
  }
}