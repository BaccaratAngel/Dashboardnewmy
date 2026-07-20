---
name: Engine Data Flow
description: Per-hand processing order for the five prediction engines inside GameSession.
---

## Processing order on handleInput(value)

1. **Score** — if value is B or P: call `supreme.evaluateOutcome(actual)` and `regime.evaluateOutcome(actual)` (uses predictions captured from the *previous* hand).
2. **Record** — call `syndicate.calculateSyndicate(actual)`, `road.handleInput(actual)`, `nexus.handleInput(actual)`, `markov.record(actual)`.
3. **Predict** — call `_captureNewPredictions()`:
   - Get road snapshot (beb/sr/cp/nextPrediction), nexus snapshot (apexSignal/vol), markov.predict(), syndicate.getB2BAlert().
   - Build SupremePredInput from these sub-signals.
   - Call `supreme.predict(qPreds, vol)` → supremeResult.
   - Call `regime.captureSupreme(supremeResult.decision)` and `regime.captureSyndicate(b2bAlert)`.
4. **Snapshot** — call `regime.getVerdict()` for the final output.

## Tie handling
- Syndicate: treated as neutral (passed "B" as placeholder — doesn't affect B2B logic).
- Road/Nexus/Markov: ties skipped entirely (no-op for scoring).
- Supreme/Regime: ties skip evaluateOutcome (no scoring).

## Undo
All engines have `undoLast()` that pops from their own internal undo stack. Call in same order as handleInput in reverse.

**Why:** Supreme and Regime score *before* recording so predictions from the previous round are evaluated against the current outcome — matching the original HTML app's logic.
