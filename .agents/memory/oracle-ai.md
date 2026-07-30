---
name: OracleAI engine
description: Architecture and key decisions for the Oracle Final Prediction AI — synthesizes exactly 4 signals.
---

# OracleAI Engine

## What it is
A pure-compute synthesizer (`artifacts/api-server/src/lib/engines/oracle.ts`) that reads the 4 signals the user sees and trusts, and produces a single BET PLAYER / BET BANKER / WAIT verdict.

## The 4 signals (and only these 4)
1. **Main Prediction** — `regime.decision` (null = WAIT/abstain) — the main bottom call
2. **Ensemble Vote** — `regime.ensembleVerdict` + `ensemblePercent` (how lopsided the vote is)
3. **Crisis AI** — active prediction when triggered (weight 2.5×conf), background otherwise (weight 1.2)
4. **Meta Combiner** — `mcPrediction` + `mcConfidence` + `mcRecentAccuracy` (highest base weight 3.0)

**Why only 4:** The user specifically named these 4 when requesting Oracle. MetaAI, Observer, LookAhead, Race Tracker are all sub-engines that already feed INTO Meta Combiner — including them again would double-count signals.

## Algorithm: Directional vote scoring
- Each signal votes P (+1), B (-1), or abstains (0)
- MetaCombiner weight: 3.0 × confMult × accBoost (confMult: HIGH=1.3, MED=1.0, LOW=0.65; accBoost: 0.8+acc×0.5)
- Crisis active weight: 2.5 × confMult; background weight: 1.2 (flat)
- Ensemble weight: 2.0 + (ensemblePercent/100)×0.8 (2.0–2.8)
- Regime decision weight: 1.5 (flat)
- Consensus bonus: ±1.2 when all active signals agree on one side

## WAIT conditions (in priority order)
1. handCount < 10 → cold start
2. consecutiveLosses ≥ 3 → bankroll protection (hard override)
3. totalSignals === 0 → all abstaining
4. signals split AND |netScore| < 1.2 → split, no edge
5. totalSignals ≥ 2 AND |netScore| < 1.0 → too weak

## Confidence tiers
- HIGH: |netScore| ≥ 5.0 AND agreementCount ≥ 3
- MED: |netScore| ≥ 2.8
- LOW: otherwise

## OracleResult fields (unchanged schema)
- `verdict`: "P" | "B" | "WAIT"
- `championAligned`: MetaCombiner aligns with verdict (most reliable signal)
- `consensusPulse`: 3+ signals agree on same side
- `topReasons`: which signals voted which direction

## Wiring
- OracleInput has only 12 fields (vs prior 40+)
- Built at end of `_captureNewPredictions()` after MetaCombiner and CrisisAI are ready
- Panel placed inside the DECISION PANEL, right below EnsembleVoteBlock

**Why simplified:** The user's original request was "I observed actual next hand outcome moving between main prediction, meta combiner, crisis ai and ensemble vote — I need add new ai to choose me what should i select". The first implementation read all engines which contradicted the stated scope.
