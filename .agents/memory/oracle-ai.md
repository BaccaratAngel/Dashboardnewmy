---
name: OracleAI engine
description: Architecture and key decisions for the Oracle Final Prediction AI added to the baccarat system.
---

# OracleAI Engine

## What it is
A pure-compute synthesizer (`artifacts/api-server/src/lib/engines/oracle.ts`) that reads every sub-system signal and produces a single BET PLAYER / BET BANKER / WAIT verdict.

## Algorithm: Reliability-Weighted Directional Scoring
1. Convert each sub-system output → direction (+1 P, -1 B, 0 skip)
2. Weight each signal by the engine's live rolling accuracy
3. Sum → netScore (positive = Player, negative = Banker)
4. Apply WAIT override rules
5. Threshold for final call

## Signal weights (base × reliability)
- MetaCombiner: 3.2 × recentAccuracy
- Race champion's pick: 2.5 × champion's rollingAccuracy
- Regime ensemble: 2.2 × ensemblePercent/100
- CrisisAI active: 2.2 × confMult(confidence)
- CrisisAI background: 1.3 × 0.60
- MetaAI (if seen ≥ 8): 1.6 × accuracy
- Observer: 1.5 × wr (0.8/0.38 if fallback)
- LookAhead v1: 1.1 × strength × recentAcc
- LookAhead v2: 0.8 × strength × 0.55

## Consensus amplifiers (additive)
- Race allAgree + agreeSide → ±1.6
- Regime bothAgree → ±1.6
- Majority (≥60% experts) → ±0.8
- Champion streak ≥ 3 → ±0.2×min(streak,6)

## WAIT override conditions (in priority order)
1. handCount < 10 → cold-start
2. consecutiveLosses ≥ 3 AND !isLocked → emergency bankroll protection (hard WAIT, HIGH confidence)
3. |netScore| < 1.4 → signals diverge (MED confidence)
4. mcPrediction=WAIT AND no ensembleVerdict → both abstaining
5. volatilityIndex > 0.75 AND convergenceCount < 3 → chaotic shoe

## Confidence tiers
- LOW: |netScore| < 3.0
- MED: |netScore| 3.0–5.5
- HIGH: |netScore| ≥ 5.5

## Wiring
- Computed at end of `_captureNewPredictions()` in session.ts after all other engines run
- Stored as `_pendingOracle`, included in `getSnapshot()` as `oracleAI`
- OracleInput takes all live engine outputs directly (no extra state)
- OracleAIPanel placed as first panel in DashboardPage (above regime tracker)

**Why:** Pure-compute means no learning state to corrupt/undo; each hand gets a fresh synthesis of whatever the live engines say. Adding learning on top of already-learned engines would double-count the signal history.
