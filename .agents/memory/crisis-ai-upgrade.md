---
name: Crisis AI & regime upgrades
description: CrisisAI engine using Gemini free API, shadow promotion logic, and hard 3-loss lock break added to the baccarat prediction app.
---

# Crisis AI & Regime Upgrades

## What was added

**CrisisAI engine** (`artifacts/api-server/src/lib/engines/crisis-ai.ts`):
- Tracks consecutive losses of the main regime prediction
- After `CRISIS_THRESHOLD = 2` consecutive losses, calls Google Gemini REST API
- Uses `gemini-3-flash-preview` by default via direct fetch (no SDK, uses `GEMINI_API_KEY` env var); older `gemini-2.5-flash` was rejected for new users
- Returns: `{ active, prediction, confidence, reasoning, consecutiveLosses }`
- Graceful fallback to ensemble verdict on API error/timeout (7s timeout); error text distinguishes timeout from HTTP/API failures
- Full undo stack: `_save()` called on every hand (including T), matching session undo cadence

**Why:** User observed the main prediction staying "sticky" and wrong for 5-7 consecutive hands. CrisisAI provides an independent LLM-based recovery signal. Google model availability can vary by account age, so the default must stay on a currently accepted model.

**How to apply:** `crisisAI.setMainPrediction()` must be called BEFORE `regime.evaluateOutcome()`, then `await crisisAI.evaluateOutcome()` AFTER all engine scoring. This captures the prior prediction correctly.

**Gemini reliability:** Gemini 3 uses thinking by default and may return output across multiple parts, including thought metadata. Crisis classification requests should use minimal thinking, parse non-thought parts together, and retain the ensemble fallback for transient provider failures.

**Why:** The recovery prompt intermittently timed out or parsed only the first word of a multi-part response even while simple Gemini requests succeeded.

**How to apply:** Keep the recovery prompt compact, use `responseSchema` plus `thinkingConfig: { thinkingLevel: "minimal" }`, and enforce a total request budget with limited transient-error retry.

## Regime upgrades (`regime.ts`)

**Shadow promotion** — `_shouldPromoteShadow()`:
- Activates when: dominant has 3+ consecutive losses AND shadow has 2+ consecutive wins AND shadow composite score > dominant
- Sets `_shadowPromoted = true` + breaks lock early
- UI shows green "SHADOW PROMOTED" banner instead of orange "ACCELERATED UNLOCK"

**Hard lock cap**: `_shouldAccelerateUnlock()` now always returns `true` when `currentRunLen >= 3`, regardless of historical loss-run profile.

**New fields in `RegimeVerdict`**: `shadowPromoted: boolean`

## Session changes (`session.ts`)

- `handleInput()` is now `async handleInput(): Promise<GameSnapshot>`
- `crisisAI.undoLast()` added to `undo()`
- `crisisAI: this.crisisAI.getResult()` in `GameSnapshot`

## Route changes (`game.ts`)

- `/game/input` POST handler is now `async` (Express 5 handles async errors natively)

## OpenAPI / codegen

- `CrisisAIResult` schema added
- `GameSnapshot.crisisAI` field added (required)
- `RegimeState.shadowPromoted` field added
- Run codegen after any spec change: `pnpm --filter @workspace/api-spec run codegen`

## Dashboard

- `CrisisAIPanel` component added — shows below hand counter, above Look-Ahead systems
- Panel is hidden when `consecutiveLosses === 0` and `active === false`
- Shadow promotion shows green banner in LockBar replacing the orange accelerated-unlock banner
