/**
 * Crisis Recovery AI — activates after N consecutive main prediction losses.
 * Uses the configured AI provider to analyse the recent pattern and expert
 * shoe records, then suggests a recovery prediction in the background.
 *
 * Integration contract:
 *   1. Before regime.evaluateOutcome():  crisisAI.setMainPrediction(verdict.decision)
 *   2. After  regime.evaluateOutcome():  void crisisAI.evaluateOutcome(actual, ...)
 *   3. On undo:                          crisisAI.undoLast()
 *   4. On reset:                         crisisAI.reset()
 */

import { logger } from "../logger.js";

type Side = "P" | "B";

const CRISIS_THRESHOLD = 2;   // consecutive losses before crisis activates
// Keep the model configurable for provider-side model changes, while using a
// currently supported fast model by default.
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Recovery must never make recording a hand feel stuck. The ensemble fallback
// is intentionally returned after this total budget, including one retry.
const GEMINI_TIMEOUT_MS = 3_500;
const GEMINI_RETRY_DELAY_MS = 350;

// ── Expert label map ──────────────────────────────────────────────────────────

const EXPERT_LABELS: Record<string, string> = {
  supreme:         "Supreme Bayesian",
  syndicate:       "Syndicate",
  lookAhead:       "Look-Ahead v1",
  legacyLookAhead: "Look-Ahead v2",
  metaAI:          "Meta AI",
  observer:        "Observer",
  bebRoad:         "BEB Road",
  smallRoad:       "Small Road",
  cockroachRoad:   "Cockroach Road",
  dualAuth:        "Dual-Auth",
};

// ── Public types ──────────────────────────────────────────────────────────────

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

// ── Undo snapshot ─────────────────────────────────────────────────────────────

interface CrisisSnap {
  consecutiveLosses: number;
  lastMainPred: Side | null;
  result: CrisisResult;
}

// ── Engine ────────────────────────────────────────────────────────────────────

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

  // Rate-limit guard: do not call Gemini more than once per 60s during a crisis.
  private _lastGeminiCallAt = 0;
  private _geminiRateLimitedUntil = 0;
  // Invalidates an in-flight provider response after a newer hand, undo, or
  // reset changes the session state.
  private _generation = 0;
  private static readonly GEMINI_COOLDOWN_MS = 60_000;

  /**
   * Call BEFORE regime.evaluateOutcome() — captures what the main regime
   * predicted for the hand that is about to be scored.
   */
  setMainPrediction(pred: Side | null): void {
    this.lastMainPred = pred;
  }

  /**
   * Call AFTER all engine evaluateOutcome() calls, for every hand (B, P, T).
   * `actual` is null for Tie hands — state is saved but no loss is counted.
   * `experts` contains all 10 expert shoe stats for Gemini context.
   */
  async evaluateOutcome(
    actual: Side | null,
    history: string[],
    experts: ExpertShoeData[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
  ): Promise<void> {
    const generation = ++this._generation;
    this._save();

    // Tie hand — preserve existing streak, no evaluation
    if (actual === null) return;

    // No prior prediction — skip loss counting
    if (this.lastMainPred === null) return;

    const correct = this.lastMainPred === actual;

    if (correct) {
      // Reset crisis
      this.consecutiveLosses = 0;
      this._lastGeminiCallAt = 0;
      this._geminiRateLimitedUntil = 0;
      this._result = {
        active: false,
        prediction: null,
        confidence: "LOW",
        reasoning: "",
        consecutiveLosses: 0,
      };
    } else {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= CRISIS_THRESHOLD) {
        // Return a useful fallback immediately. The provider call continues
        // after the hand response has already been returned.
        this._result = {
          active: true,
          prediction: ensembleVerdict,
          confidence: "LOW",
          reasoning: "Crisis AI analyzing — ensemble fallback",
          consecutiveLosses: this.consecutiveLosses,
        };
        await this._callGemini(
          history,
          experts,
          shadowLeader,
          shadowPred,
          ensembleVerdict,
          ensemblePercent,
          generation,
        );
      }
    }
  }

  // ── Gemini call ──────────────────────────────────────────────────────────

  private async _callGemini(
    history: string[],
    experts: ExpertShoeData[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
    generation: number,
  ): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();

    if (!apiKey) {
      if (generation !== this._generation) return;
      this._result = {
        active: true,
        prediction: ensembleVerdict,
        confidence: "LOW",
        reasoning: "Ensemble fallback active",
        consecutiveLosses: this.consecutiveLosses,
      };
      return;
    }

    // Do not make a new request on every hand while the crisis stays active.
    // This cooldown applies even when the loss count increases.
    const now = Date.now();
    if (now < this._geminiRateLimitedUntil) {
      if (generation !== this._generation) return;
      this._result = {
        ...this._result,
        active: true,
        prediction: ensembleVerdict,
        confidence: "LOW",
        reasoning: "Ensemble fallback active",
        consecutiveLosses: this.consecutiveLosses,
      };
      return;
    }
    if (now - this._lastGeminiCallAt < CrisisAI.GEMINI_COOLDOWN_MS) {
      if (generation !== this._generation) return;
      this._result = {
        ...this._result,
        active: true,
        prediction: ensembleVerdict,
        confidence: "LOW",
        reasoning: "Ensemble fallback active",
        consecutiveLosses: this.consecutiveLosses,
      };
      return;
    }
    this._lastGeminiCallAt = now;

    const recentClean = history.filter((h) => h !== "T").slice(-25);
    const histStr = recentClean.join(" ");
    const n = this.consecutiveLosses;

    // ── Classify experts by shoe win rate (mirrors the dashboard split bar) ──
    // GREEN  = ≥60% shoe win rate  →  HIGH WEIGHT
    // YELLOW = 50-59%              →  NORMAL WEIGHT
    // RED    = <50%                →  LOW WEIGHT (discard)
    const withRate = experts
      .filter((e) => e.wins + e.losses > 0)
      .map((e) => {
        const total = e.wins + e.losses;
        const winPct = Math.round((e.wins / total) * 100);
        const tier: "GREEN" | "YELLOW" | "RED" =
          winPct >= 60 ? "GREEN" : winPct >= 50 ? "YELLOW" : "RED";
        return { ...e, total, winPct, tier };
      })
      // Sort: GREEN first, then YELLOW, then RED; within tier by winPct desc
      .sort((a, b) => {
        const tierOrder = { GREEN: 0, YELLOW: 1, RED: 2 };
        if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
        return b.winPct - a.winPct;
      });

    // Keep the recovery request small. Sending all ten full run records made
    // the free endpoint slow and increased the chance of non-JSON replies.
    const expertLines = withRate
      .filter((e) => e.tier !== "RED")
      .slice(0, 6)
      .map((e) => `${EXPERT_LABELS[e.key] ?? e.key}: ${e.winPct}% -> ${e.lastPred ?? "WAIT"}`)
      .join("\n") || "No reliable expert data yet";

    // ── Weighted vote from GREEN experts only ─────────────────────────────
    const greenExperts = withRate.filter((e) => e.tier === "GREEN");
    const greenP = greenExperts.filter((e) => e.lastPred === "P");
    const greenB = greenExperts.filter((e) => e.lastPred === "B");

    // Sum winPct as vote weight for each side
    const weightP = greenP.reduce((s, e) => s + e.winPct, 0);
    const weightB = greenB.reduce((s, e) => s + e.winPct, 0);
    const greenVote: Side | null = weightP > weightB ? "P" : weightB > weightP ? "B" : null;
    const greenVoteStr = greenVote
      ? `${greenVote} (P-weight:${weightP} vs B-weight:${weightB})`
      : `SPLIT (P-weight:${weightP} vs B-weight:${weightB})`;

    const greenNames = greenExperts
      .slice(0, 6)
      .map((e) => `${EXPERT_LABELS[e.key] ?? e.key}(${e.winPct}%→${e.lastPred ?? "—"})`)
      .join(", ") || "none";

    const prompt = `Act as a baccarat recovery signal. The main prediction lost ${n} hands in a row.

Recent hands, oldest to newest (B=Banker, P=Player):
${recentClean.slice(-12).join(" ")}

Most reliable experts this shoe (60%+):
${expertLines}

Green expert vote: ${greenNames}

Weighted green vote: ${greenVoteStr}

Ensemble: ${ensembleVerdict ?? "none"} (${ensemblePercent}%)
Shadow: ${shadowPred ?? "none"}

Choose P or B. Prefer 3+ green experts = HIGH, 2 = MED, otherwise LOW and use the ensemble as tiebreaker.

Respond ONLY with valid JSON, no markdown:
{"prediction":"P or B","confidence":"LOW or MED or HIGH","reasoning":"max 90 char — name which GREEN experts agree and their shoe win rates"}`;

    try {
      const requestBody = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              prediction: { type: "STRING", enum: ["P", "B"] },
              confidence: { type: "STRING", enum: ["LOW", "MED", "HIGH"] },
              reasoning: { type: "STRING" },
            },
            required: ["prediction", "confidence", "reasoning"],
          },
          // This is a small classification task; default Gemini 3 thinking
          // adds latency without improving the recovery signal.
          thinkingConfig: { thinkingLevel: "minimal" },
          maxOutputTokens: 128,
          temperature: 0.1,
        },
      });

      let response: Response | undefined;
      const deadline = Date.now() + GEMINI_TIMEOUT_MS;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          const remaining = deadline - Date.now();
          if (remaining <= GEMINI_RETRY_DELAY_MS) break;
          await new Promise((resolve) => setTimeout(resolve, GEMINI_RETRY_DELAY_MS));
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal: AbortSignal.timeout(remaining),
        });
        if (response.ok || ![500, 502, 503, 504].includes(response.status)) break;
      }
      if (!response) throw new Error("Gemini request did not return a response");
      if (!response.ok) {
        if (response.status === 429 && generation === this._generation) {
          this._geminiRateLimitedUntil = Date.now() + CrisisAI.GEMINI_COOLDOWN_MS;
        }
        throw new Error(`Gemini HTTP ${response.status}`);
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        }>;
      };

      const text = data.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("") ?? "";
      // Accept strict JSON, fenced JSON, or a JSON object embedded in a
      // short explanation. The provider occasionally ignores the MIME hint.
      const cleanedText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const objectStart = cleanedText.indexOf("{");
      const objectEnd = cleanedText.lastIndexOf("}");
      const jsonText = objectStart >= 0 && objectEnd > objectStart
        ? cleanedText.slice(objectStart, objectEnd + 1)
        : cleanedText;
      const parsed = JSON.parse(jsonText) as {
        prediction?: string;
        confidence?: string;
        reasoning?: string;
      };

      const prediction: Side | null =
        parsed.prediction === "P" ? "P" : parsed.prediction === "B" ? "B" : null;
      const confidence = (["LOW", "MED", "HIGH"].includes(parsed.confidence ?? "")
        ? parsed.confidence
        : "LOW") as "LOW" | "MED" | "HIGH";
      const reasoning = String(parsed.reasoning ?? "").slice(0, 110);

      if (generation !== this._generation) return;
      this._result = {
        active: true,
        prediction,
        confidence,
        reasoning,
        consecutiveLosses: this.consecutiveLosses,
      };
    } catch (err) {
      logger.warn(
        { err, model: GEMINI_MODEL, timeoutMs: GEMINI_TIMEOUT_MS },
        "CrisisAI: Gemini call failed — using ensemble fallback",
      );
      if (generation !== this._generation) return;
      this._result = {
        active: true,
        prediction: ensembleVerdict,
        confidence: "LOW",
        reasoning: "Ensemble fallback active",
        consecutiveLosses: this.consecutiveLosses,
      };
    }
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  getResult(): CrisisResult {
    return { ...this._result, consecutiveLosses: this.consecutiveLosses };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private _save(): void {
    this._undoStack.push({
      consecutiveLosses: this.consecutiveLosses,
      lastMainPred: this.lastMainPred,
      result: { ...this._result },
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  undoLast(): void {
    this._generation++;
    const prev = this._undoStack.pop();
    if (!prev) return;
    this.consecutiveLosses = prev.consecutiveLosses;
    this.lastMainPred = prev.lastMainPred;
    this._result = prev.result;
  }

  reset(): void {
    this._generation++;
    this.consecutiveLosses = 0;
    this.lastMainPred = null;
    this._result = {
      active: false,
      prediction: null,
      confidence: "LOW",
      reasoning: "",
      consecutiveLosses: 0,
    };
    this._lastGeminiCallAt = 0;
    this._geminiRateLimitedUntil = 0;
    this._undoStack = [];
  }
}
