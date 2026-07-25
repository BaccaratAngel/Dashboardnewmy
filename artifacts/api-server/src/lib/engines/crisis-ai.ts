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

const CRISIS_THRESHOLD = 3;   // consecutive losses before crisis activates
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

    // ── Build expert table ────────────────────────────────────────────────
    // Sort by win % descending so Gemini sees best performers first
    const sorted = [...experts]
      .filter((e) => e.wins + e.losses > 0)
      .sort((a, b) => {
        const pctA = a.wins / (a.wins + a.losses);
        const pctB = b.wins / (b.wins + b.losses);
        return pctB - pctA;
      });

    const expertLines = sorted.map((e) => {
      const total = e.wins + e.losses;
      const pct = total > 0 ? Math.round((e.wins / total) * 100) : 0;
      const run = e.currentRunLen > 0 && e.currentRunIsWin !== null
        ? ` ${e.currentRunIsWin ? "▲" : "▼"}${e.currentRunLen}`
        : "";
      const pred = e.lastPred ?? "—";
      const trend = e.momentum === "up" ? "↑" : e.momentum === "down" ? "↓" : "→";
      const label = (EXPERT_LABELS[e.key] ?? e.key).padEnd(18);
      return `  ${label} ${String(e.wins).padStart(2)}W ${String(e.losses).padStart(2)}L (${String(pct).padStart(3)}%) ${trend}  last:${pred}${run}`;
    }).join("\n");

    // Find the top 3 hot experts (≥60% and at least 5 predictions)
    const hotExperts = sorted
      .filter((e) => e.wins + e.losses >= 5 && e.wins / (e.wins + e.losses) >= 0.60)
      .slice(0, 3)
      .map((e) => `${EXPERT_LABELS[e.key] ?? e.key} (${Math.round(e.wins / (e.wins + e.losses) * 100)}%, last:${e.lastPred ?? "—"})`)
      .join(", ") || "none above 60%";

    // Find cold experts (≤40%)
    const coldExperts = sorted
      .filter((e) => e.wins + e.losses >= 5 && e.wins / (e.wins + e.losses) <= 0.40)
      .map((e) => EXPERT_LABELS[e.key] ?? e.key)
      .join(", ") || "none";

    const prompt = `You are a baccarat crisis recovery expert. The main system has lost ${n} consecutive hands.

Recent hands (B=Banker P=Player, oldest→newest, last 25 non-tie):
${histStr}

ALL 10 EXPERT SHOE RECORDS (current shoe win/loss, sorted best→worst):
${expertLines}

Hot experts this shoe (≥60% WR): ${hotExperts}
Cold experts this shoe (≤40% WR): ${coldExperts}

Ensemble vote: ${ensembleVerdict ?? "none"} at ${ensemblePercent}% weight
Shadow leader (${shadowLeader ?? "none"}) predicts: ${shadowPred ?? "none"}

TASK: Based on the shoe performance data above and the recent hand sequence, identify which experts are reliable THIS shoe and what they agree on. Then predict the next hand.

Key analysis points:
1. What do the hot experts predict?
2. Is there a streak or alternating pattern in the recent hands?
3. Do hot experts agree on a side?

Respond ONLY with valid JSON, no markdown:
{"prediction":"P or B","confidence":"LOW or MED or HIGH","reasoning":"max 90 char explanation referencing shoe leaders"}`;

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
