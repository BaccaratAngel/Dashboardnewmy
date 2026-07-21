---
name: 6-Expert Regime Tracker Upgrade
description: Architecture and frontend decisions for the upgraded 6-expert meta regime tracker with Option C composite scoring and new UI panels.
---

## What was built

**Backend (regime.ts):** Tracks 6 experts — supreme, syndicate, lookAhead, legacyLookAhead, metaAI, observer. Each ExpertState has: streak, hotStreak, wwrHistory[4], momentum ("up"|"down"|"flat"), sparkline[8], wwrDelta, compositeScore. Option C composite = Bayesian WWR 50% + momentum 25% + streak/8 capped 25% + hotStreak flat +5%. `getVerdict()` returns all 6 ExpertStats + ensemble (ensembleVerdict, ensemblePercent, agreeCount) + switchTimeline[].

**Backend (session.ts):** `runLegacyLookAhead()` uses depth=2 (4 branches PP/PB/BP/BB), heavier on apexDelta vs v1's coreTransMean. `getSnapshot()` includes `observerMemory` from `observer.getMemorySnapshot()` (3 sub-systems: meta, lookAhead, derived).

**OpenAPI spec:** ExpertStats, TimelineEntry schemas added; RegimeState expanded to 6 expert fields + ensemble + timeline + lockMax + volatilityIndex + agreeCount; GameSnapshot includes legacyLookAhead + observerMemory.

## UI panels in DashboardPage.tsx

1. Meta Regime Tracker: 6 ExpertRow components (label, momentum arrow, P/B pill, WWR delta, composite bar, sparkline dots)
2. Ensemble voting block (P vs B blend bar, agreeCount/6)
3. Regime switch timeline strip (expert + hands, →, current ★)
4. Lock countdown bar (LockBar component) replacing plain 🔒 badge
5. Both/all agree banner (uses agreeCount)
6. Look-Ahead Systems panel: v1 (depth-1) + v2/Legacy (depth-2) rows with agreement indicator
7. Meta AI panel
8. Observer Master AI panel + sub-system trackers (meta/lookAhead/derived winRate from observerMemory)

## Key design decisions

- **Why two look-aheads are orthogonal:** v1 weights coreTransMean, v2 weights apexDelta + road final signal — different scoring, different prediction signal.
- **Split tiebreaker:** observer.lastPred used to resolve SPLIT rather than freezing.
- **Dynamic window:** volatilityIndex drives shrink (8) / expand (16); shown in UI as VOL % bar.
- **Snapshot refresh pattern:** DashboardPage uses `useEffect(() => { if (initialSnapshot.data) setSnapshot(initialSnapshot.data); }, [initialSnapshot.data])` (no `!snapshot` guard) so React Query refetches after API restart update the displayed state. Mutations still set snapshot in `onSuccess`.
- **Defensive rendering:** All new regime/expert fields use optional chaining (`?.`) and default values (`?? 0`) since old cached snapshots may lack them.

**Why:**  Prior session had `!snapshot` guard causing stale state after API restarts; removed in this session.
