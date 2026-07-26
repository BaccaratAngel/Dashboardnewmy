---
name: Crisis AI & regime upgrades
description: Internal Crisis AI scorer, shadow promotion logic, and hard 3-loss lock break for the baccarat prediction app.
---

# Crisis AI & Regime Upgrades

## What was added

**CrisisAI engine** (`artifacts/api-server/src/lib/engines/crisis-ai.ts`):
- Tracks consecutive losses of the main regime prediction
- Activates after `CRISIS_THRESHOLD = 2` consecutive losses
- Runs entirely in-process with no API key, network call, timeout, or external provider
- Scores expert reliability, composite score, momentum, current runs, recent road patterns, ensemble agreement, and shadow leadership
- Returns `{ active, prediction, confidence, reasoning, consecutiveLosses }`
- Uses a full undo stack matching the session's hand cadence

**Why:** The recovery task needs every hand's live state immediately. External AI introduced delays, rate limits, timeouts, and provider-specific parsing failures that were a poor fit for this app.

**How to apply:** Keep CrisisAI synchronous and bounded. Call `setMainPrediction()` BEFORE `regime.evaluateOutcome()`, then call `evaluateOutcome()` AFTER all engine scoring and before generating new predictions. Keep the ensemble as a scoring input and safety tie-breaker, not as an external fallback.

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
