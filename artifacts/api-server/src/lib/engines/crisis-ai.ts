/**
 * Crisis Recovery AI — activates after N consecutive main prediction losses.
 * Uses Google Gemini (free tier) to analyse the recent pattern and ALL 10
 * expert shoe records, then suggests a recovery prediction.
 *
 * Integration contract:
 *   1. Before regime.evaluateOutcome():  crisisAI.setMainPrediction(verdict.decision)
 *   2. After  regime.evaluateOutcome():  await crisisAI.evaluateOutcome(actual, ...)
 *   3. On undo:                          crisisAI.undoLast()
 *   4. On reset:                         crisisAI.reset()
 */

import { logger } from "../logger.js";

type Side = "P" | "B";

const CRISIS_THRESHOLD = 2;   // consecutive losses before crisis activates
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

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
        await this._callGemini(history, experts, shadowLeader, shadowPred, ensembleVerdict, ensemblePercent);
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

    const recentClean = history.filter((h) => h !== "T").slice(-25);
    const histStr = recentClean.join(" ");
    const n = this.consecutiveLosses;

    // ── Build expert table sorted by current run momentum ────────────────
    // Primary: experts currently on a win streak first; secondary: streak length
    const sorted = [...experts]
      .filter((e) => e.wins + e.losses > 0)
      .sort((a, b) => {
        // Win-streak experts first, then by streak length desc
        const aHot = a.currentRunIsWin === true ? 1 : 0;
        const bHot = b.currentRunIsWin === true ? 1 : 0;
        if (bHot !== aHot) return bHot - aHot;
        return b.currentRunLen - a.currentRunLen;
      });

    const expertLines = sorted.map((e) => {
      // Current run strip — what the expert is doing RIGHT NOW this shoe
      const runDir = e.currentRunIsWin === true ? "WIN" : e.currentRunIsWin === false ? "LOSS" : "none";
      const runStr = e.currentRunLen > 0 && e.currentRunIsWin !== null
        ? `${runDir}×${e.currentRunLen}`
        : "—";
      const pred = e.lastPred ?? "—";
      const trend = e.momentum === "up" ? "↑HOT" : e.momentum === "down" ? "↓COLD" : "→";
      const label = (EXPERT_LABELS[e.key] ?? e.key).padEnd(18);
      return `  ${label}  run:${runStr.padEnd(8)}  ${trend}  next:${pred}`;
    }).join("\n");

    // Experts currently on active win streaks ≥2
    const onWinRun = sorted
      .filter((e) => e.currentRunIsWin === true && e.currentRunLen >= 2)
      .map((e) => `${EXPERT_LABELS[e.key] ?? e.key} (WIN×${e.currentRunLen}, next:${e.lastPred ?? "—"})`)
      .join(", ") || "none";

    // Experts currently on active loss streaks ≥2
    const onLossRun = sorted
      .filter((e) => e.currentRunIsWin === false && e.currentRunLen >= 2)
      .map((e) => EXPERT_LABELS[e.key] ?? e.key)
      .join(", ") || "none";

    const prompt = `You are a baccarat crisis recovery AI. The main system has lost ${n} consecutive hands.

Recent hands (B=Banker P=Player, oldest→newest, last 25 non-tie):
${histStr}

ALL 10 EXPERTS — CURRENT SHOE RUN STATUS (sorted: active win streaks first):
${expertLines}

Experts on active win streak ≥2 hands: ${onWinRun}
Experts on active loss streak ≥2 hands: ${onLossRun}

Ensemble vote: ${ensembleVerdict ?? "none"} at ${ensemblePercent}% weight
Shadow leader (${shadowLeader ?? "none"}) predicts: ${shadowPred ?? "none"}

TASK: Analyse the CURRENT SHOE RUN STATUS above — not historical win rates. Experts on active win streaks are the most reliable signal right now. Look at what those hot-streak experts predict next, then check the recent hand sequence for a pattern.

Key analysis:
1. Which experts are on active win streaks and what do they predict?
2. Do the win-streak experts agree on a side?
3. Does the recent hand sequence support that side (streak, alternating pattern)?

Respond ONLY with valid JSON, no markdown:
{"prediction":"P or B","confidence":"LOW or MED or HIGH","reasoning":"max 90 char — cite which experts are on win streaks and what they predict"}`;

    try {
      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 200,
            temperature: 0.2,
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
      const reasoning = String(parsed.reasoning ?? "").slice(0, 110);

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
