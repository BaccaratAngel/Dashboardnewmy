/**
 * Crisis Recovery AI — activates after N consecutive main prediction losses.
 * Uses Google Gemini (free tier) to analyse the recent pattern and suggest
 * a recovery prediction.
 *
 * Integration contract:
 *   1. Before regime.evaluateOutcome():  crisisAI.setMainPrediction(verdict.decision)
 *   2. After  regime.evaluateOutcome():  await crisisAI.evaluateOutcome(actual, ...)
 *   3. On undo:                          crisisAI.undoLast()
 *   4. On reset:                         crisisAI.reset()
 */

import { logger } from "../logger.js";

type Side = "P" | "B";

const CRISIS_THRESHOLD = 3;   // consecutive losses before crisis activates
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// ── Public result type ────────────────────────────────────────────────────────

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
   */
  async evaluateOutcome(
    actual: Side | null,
    history: string[],            // raw history including T entries
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
  ): Promise<void> {
    this._save();

    // Tie hand — preserve existing streak, no evaluation
    if (actual === null) return;

    // No prior prediction — skip loss counting
    if (this.lastMainPred === null) return;

    const correct = this.lastMainPred === actual;

    if (correct) {
      // Reset crisis
      this.consecutiveLosses = 0;
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
        await this._callGemini(history, shadowLeader, shadowPred, ensembleVerdict, ensemblePercent);
      }
    }
  }

  // ── Gemini call ──────────────────────────────────────────────────────────

  private async _callGemini(
    history: string[],
    shadowLeader: string | null,
    shadowPred: Side | null,
    ensembleVerdict: Side | null,
    ensemblePercent: number,
  ): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      this._result = {
        active: true,
        prediction: ensembleVerdict,
        confidence: "LOW",
        reasoning: "GEMINI_API_KEY missing — using ensemble fallback",
        consecutiveLosses: this.consecutiveLosses,
      };
      return;
    }

    const recentClean = history.filter((h) => h !== "T").slice(-20);
    const histStr = recentClean.join(" ");
    const n = this.consecutiveLosses;

    const prompt = `You are a baccarat prediction expert. The main AI has been wrong ${n} consecutive hands.

Recent hands (B=Banker P=Player, oldest→newest): ${histStr}

Other signals:
- Shadow expert (${shadowLeader ?? "none"}) predicts: ${shadowPred ?? "none"}
- Ensemble vote: ${ensembleVerdict ?? "none"} at ${ensemblePercent}% lean

Look for streak reversals, alternating patterns, or dominant runs. Predict the next hand.

Respond ONLY with valid JSON, no markdown:
{"prediction":"P or B","confidence":"LOW or MED or HIGH","reasoning":"max 80 char explanation"}`;

    try {
      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 150,
            temperature: 0.3,
          },
        }),
        signal: AbortSignal.timeout(9000),
      });

      if (!response.ok) {
        throw new Error(`Gemini HTTP ${response.status}`);
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as {
        prediction?: string;
        confidence?: string;
        reasoning?: string;
      };

      const prediction: Side | null =
        parsed.prediction === "P" ? "P" : parsed.prediction === "B" ? "B" : null;
      const confidence = (["LOW", "MED", "HIGH"].includes(parsed.confidence ?? "")
        ? parsed.confidence
        : "LOW") as "LOW" | "MED" | "HIGH";
      const reasoning = String(parsed.reasoning ?? "").slice(0, 100);

      this._result = {
        active: true,
        prediction,
        confidence,
        reasoning,
        consecutiveLosses: this.consecutiveLosses,
      };
    } catch (err) {
      logger.warn({ err }, "CrisisAI: Gemini call failed — using ensemble fallback");
      this._result = {
        active: true,
        prediction: ensembleVerdict,
        confidence: "LOW",
        reasoning: "AI timeout — using ensemble fallback",
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
