---
name: Look-ahead & MetaAI architecture
description: How the look-ahead, MetaAI perceptron, and ObserverMasterAI are implemented server-side (replacing the browser iframe approach)
---

## Why the browser version was slow (10+ seconds)
- Iframes (`appA.html`, `appB.html`) used as simulation engines
- Each branch simulation: `postMessage` per hand × 45 hands × 15ms delay = 675ms per branch
- Iframe init polling: up to 10 × 500ms = 5 seconds waiting for readiness
- Total: 5-10 seconds per look-ahead run

## Server-side approach (10-17ms total)
- No iframes, no message passing, no delays
- Pure in-process function calls using hypothetical history arrays
- `NexusEngine.computeApexForHistory(history)` — static pure method, O(38 + n)
- `RoadEngine.computeSignalsForHistory(shoe)` — static pure method, O(n²) derived roads only
- Depth=1 → 2 branches ('P', 'B') → 2 × (nexus + road signals) → MetaAI.predictPartial

## Files
- `meta-ai.ts` — MetaAI logistic regression perceptron (18-dim feature vector, lr=0.08, L2=0.001)
- `observer.ts` — ObserverMasterAI (10-hand rolling win-rate tracker for meta/lookAhead/derived)
- `session.ts` — wires everything: MetaAI.onLabeled on each hand, look-ahead synchronous, observer captures/evaluates
- `nexus.ts` — added `NexusEngine.computeApexForHistory()` static method
- `road.ts` — added `RoadEngine.computeSignalsForHistory()` static method

## Feature vector (18 dims)
bias, apexSignal×2, roadFinal, beb×2, sr×2, cp×2, consensus, vol, probDiff, coreTransMean, countBias, l1-l4, markov, apex×road interaction, beb×sr interaction

## Data flow per hand
1. evaluateOutcome → metaAI.onLabeled(pendingFeatureX, actual) → observer.evaluateOutcome
2. Update all engines
3. Build new featureX → metaAI.predict → runLookAhead → observer.getUltimateVerdict
4. Feed lookAhead.verdict + observer.decision + metaAI.decision into supreme.predict
5. observer.capturePredictions for next hand's evaluation

**Why:** pendingFeatureX is the feature vector built BEFORE the hand — used to train MetaAI when the outcome arrives next hand.

## Look-ahead activates at 6+ clean (non-tie) hands
Below 6 hands, road signals (BEB/SR/CP) are unreliable so we return active=false.
