---
name: Crisis AI & regime upgrades
description: Internal Crisis AI scorer, shadow promotion logic, hard 3-loss lock break, and deep self-learning with shoe adaptation.
---

# Crisis AI & Regime Upgrades

## What was added (original)

**CrisisAI engine** (`artifacts/api-server/src/lib/engines/crisis-ai.ts`):
- Tracks consecutive losses of the main regime prediction
- Activates after `CRISIS_THRESHOLD = 2` consecutive losses
- Runs entirely in-process with no API key, network call, timeout, or external provider
- Returns `{ active, prediction, confidence, reasoning, consecutiveLosses, backgroundPrediction, bgLearning }`
- Uses a full undo stack matching the session's hand cadence

**Why:** The recovery task needs every hand's live state immediately. External AI introduced delays, rate limits, timeouts, and provider-specific parsing failures.

**How to apply:** Keep CrisisAI synchronous and bounded. Call `setMainPrediction()` BEFORE `regime.evaluateOutcome()`, then call `evaluateOutcome()` AFTER all engine scoring.

## Deep self-learning upgrade (v2)

**Two-layer learning model:**

1. **Base layer** (original, preserved): Per-expert `trust` (±0.06/0.08) and `patternTrust` (±0.05/0.07). Bounded 0.55–1.45. Applied as a multiplier in scoring.

2. **Shoe adaptation layer** (new): `ShoeAdaptation` struct with:
   - `playerBias` / `bankerBias` — additive side-score corrections learned from wrong predictions
   - `expertBoost` per key — shoe-specific multiplier (±0.035/0.045, bounded ±0.35), separate from `trust`
   - `patternBoost` per mode — additive pattern correction
   - `handsAnalyzed`, `wrongCount`, `correctCount`, `lastAnalysis`

**Wrong-prediction analysis** (`_analyzeWrongPrediction`):
- Examines last 2 hands for context
- Identifies experts that correctly predicted actual outcome vs those that misled
- Boosts correct experts' `expertBoost` +0.035, dampens misleading experts -0.045
- Adjusts `playerBias`/`bankerBias` toward actual side (step = 0.045 × decay factor)
- Adjusts `patternBoost` for the active pattern mode
- Generates human-readable analysis: "Missed BANKER (called PLAYER) after P→B; Supreme Bayesian had the edge; shoe B+0.043 (correction #3)"

**Decay factor**: `max(0.4, 1 - wrongCount * 0.015)` — step size reduces slightly as corrections accumulate for stability.

**How to apply:** `ShoeAdaptation` is applied in `_scoreRecovery()` as additive terms AFTER all weighted expert scoring. `expertBoost` is applied as `weight *= (1 + shoeBoost)` per expert. Keep bias bounds at ±0.6.

## Background process behavior

- `evaluateOutcome()` always runs and always generates a prediction regardless of panel state
- `backgroundPrediction` field always contains the latest computed prediction (even when `active = false`)
- `bgLearning` field contains the last self-learning status message
- Wrong-prediction analysis runs every missed hand regardless of active state

## Panel suppression logic

- Panel shows when: `consecutiveLosses >= 2 && !panelSuppressed`
- Panel suppresses (`panelSuppressed = true`) when: crisis prediction wins while active
- Panel re-arms when: (a) main prediction wins (resets everything), OR (b) `consecutiveLosses - suppressedAtLosses >= 2` — i.e., 2 more main losses after suppression
- `suppressedAtLosses` tracks the `consecutiveLosses` count at time of suppression

## Regime upgrades (same file)

**Shadow promotion** — activates when dominant has 3+ consecutive losses AND shadow has 2+ consecutive wins AND shadow composite > dominant.

**Hard lock cap**: `_shouldAccelerateUnlock()` always returns `true` when `currentRunLen >= 3`.

## Dashboard panel (`CrisisAIPanel`)

- Hidden when: `consecutiveLosses === 0` OR (`consecutiveLosses >= 2 && !active`) — i.e., suppressed state
- Shows "1 loss" monitoring bar (with `backgroundPrediction` pill) when exactly 1 consecutive loss
- Shows full recovery override when active, including `bgLearning` self-analysis row
- Footer note: "closes on correct prediction · re-opens on 2 more losses"

## OpenAPI / codegen

- `CrisisAIResult` now requires `backgroundPrediction` (string|null) and `bgLearning` (string)
- Run codegen after any spec change: `pnpm --filter @workspace/api-spec run codegen`
