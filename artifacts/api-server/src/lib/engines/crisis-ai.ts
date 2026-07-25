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

    const expertLines = withRate.map((e) => {
      const runDir = e.currentRunIsWin === true ? "WIN" : e.currentRunIsWin === false ? "LOSS" : "—";
      const runStr = e.currentRunLen > 0 && e.currentRunIsWin !== null
        ? `${runDir}×${e.currentRunLen}`
        : "—";
      const pred = e.lastPred ?? "—";
      const label = (EXPERT_LABELS[e.key] ?? e.key).padEnd(18);
      const barTier = e.tier === "GREEN" ? "🟢" : e.tier === "YELLOW" ? "🟡" : "🔴";
      return `  ${barTier} ${label}  shoe:${String(e.wins).padStart(2)}W/${String(e.losses).padStart(2)}L(${String(e.winPct).padStart(3)}%)  run:${runStr.padEnd(8)}  next:${pred}`;
    }).join("\n");

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
      .map((e) => `${EXPERT_LABELS[e.key] ?? e.key}(${e.winPct}%→${e.lastPred ?? "—"})`)
      .join(", ") || "none";

    const prompt = `You are a baccarat crisis recovery AI. The main system has lost ${n} consecutive hands.

Recent hands (B=Banker P=Player, oldest→newest, last 25 non-tie):
${histStr}

ALL EXPERTS — sorted by shoe split bar colour (🟢 GREEN ≥60% = most reliable THIS shoe):
${expertLines}

GREEN experts (≥60% shoe win rate) and their next prediction:
  ${greenNames}

Weighted GREEN vote: ${greenVoteStr}

Ensemble vote: ${ensembleVerdict ?? "none"} at ${ensemblePercent}%
Shadow leader (${shadowLeader ?? "none"}) predicts: ${shadowPred ?? "none"}

DECISION RULES (follow in order):
1. If ≥3 GREEN experts agree on one side → call that side, HIGH confidence.
2. If ≥2 GREEN experts agree on one side → call that side, MED confidence.
3. If GREEN experts are split or there is only 1 → check recent hand sequence for a streak or alternating pattern, then use ensemble vote as tiebreaker.
4. Ignore RED experts (≤50% shoe win rate) entirely.

Respond ONLY with valid JSON, no markdown:
{"prediction":"P or B","confidence":"LOW or MED or HIGH","reasoning":"max 90 char — name which GREEN experts agree and their shoe win rates"}`;

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
