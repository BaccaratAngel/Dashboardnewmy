/**
 * GameSession — per-user orchestration of all prediction engines.
 * Instantiated once per user, lives in memory for the process lifetime.
 *
 * Data flow on each input(value):
 *   1. Capture prior main prediction for CrisisAI tracking
 *   2. Score all engines against this actual outcome (prior predictions)
 *   3. Record the outcome in all engines
 *   4. Evaluate the internal CrisisAI scorer synchronously (bounded in-process)
 *   5. Generate new predictions from all engines
 *   6. Run look-ahead v1 (depth=1, in-process branch simulation)
 *   7. Run look-ahead v2 / legacy (depth=2, two-step simulation)
 *   8. Capture all predictions in regime tracker + observer
 */

import { SyndicateEngine } from "./syndicate.js";
import { RoadEngine } from "./road.js";
import { NexusEngine } from "./nexus.js";
import { ShortMarkov, SupremeBayesianAI, type SupremePredInput } from "./supreme.js";
import { RegimeSwitchTracker, type RegimeVerdict } from "./regime.js";
import { MetaAI, buildMetaFeatures } from "./meta-ai.js";
import { ObserverMasterAI } from "./observer.js";
import { CrisisAI, type CrisisResult, type ExpertShoeData } from "./crisis-ai.js";
import { MetaCombiner, type MetaCombinerInput, type MetaCombinerResult } from "./meta-combiner.js";
import { RaceTracker, type RaceState } from "./race.js";
import { computeOracle, type OracleResult, type OracleInput } from "./oracle.js";

type Side = "B" | "P";
type HandValue = "B" | "P" | "T";

// ── Look-ahead types ─────────────────────────────────────────────────────────

export interface LookAheadResult {
  active: boolean;
  verdict: Side | null;
  bias: number;
  strength: number;
  recentAcc: number | null;
  avgP: number;
  avgB: number;
}

// ── Snapshot type ─────────────────────────────────────────────────────────────

export interface GameSnapshot {
  handCount: number;
  history: string[];
  regime: RegimeVerdict;
  lookAhead: LookAheadResult;
  legacyLookAhead: LookAheadResult;
  metaAI: {
    decision: Side | "WAIT";
    pPlayer: number;
    accuracy: number | null;
    seen: number;
  };
  observer: {
    decision: Side | "WAIT";
    wr: number | null;
    reasoning: string;
    isFallback: boolean;
  };
  observerMemory: {
    meta: { winRate: number; total: number; lastPred: Side | null };
    lookAhead: { winRate: number; total: number; lastPred: Side | null };
    derived: { winRate: number; total: number; lastPred: Side | null };
  };
  crisisAI: CrisisResult;
  metaCombiner: MetaCombinerResult;
  race: RaceState;
  oracleAI: OracleResult;
}

// ── Look-ahead v1 (depth=1) — in-process branch simulation ──────────────────
// Simulates "what if next hand is P?" vs "what if next hand is B?" using
// RoadEngine + NexusEngine signals + MetaAI predictPartial.

const LOOK_AHEAD_TAIL = 45;

function runLookAhead(
  cleanHistory: Side[],
  metaAI: MetaAI,
  markovPred: string
): LookAheadResult {
  if (cleanHistory.length < 6) {
    return { active: false, verdict: null, bias: 0, strength: 0, recentAcc: metaAI.getRecentAccuracy(), avgP: 0, avgB: 0 };
  }

  const tail = cleanHistory.slice(-LOOK_AHEAD_TAIL);

  const scores: { branch: Side; score: number }[] = [];
  for (const branch of ["P", "B"] as Side[]) {
    const hypothetical = [...tail, branch];
    const roadSnap = RoadEngine.computeSignalsForHistory(hypothetical);
    const nexusSnap = NexusEngine.computeApexForHistory(hypothetical);
    const feat = buildMetaFeatures(roadSnap, nexusSnap, hypothetical, markovPred);
    const pred = metaAI.predictPartial(feat.x);
    const conf = Math.max(pred.pPlayer, 1 - pred.pPlayer);
    const score = conf
      + Math.abs(feat.meta.coreTransMean) * 0.08
      + Math.abs(feat.meta.apexSignal) * 0.04;
    scores.push({ branch, score });
  }

  const pScore = scores.find((s) => s.branch === "P")!.score;
  const bScore = scores.find((s) => s.branch === "B")!.score;
  const bias = pScore - bScore;
  const strength = Math.max(pScore, bScore);
  const verdict: Side | null = bias === 0 ? null : bias > 0 ? "P" : "B";

  return { active: true, verdict, bias, strength, recentAcc: metaAI.getRecentAccuracy(), avgP: pScore, avgB: bScore };
}

// ── Look-ahead v2 / Legacy (depth=2) ─────────────────────────────────────────
// Simulates two steps ahead: PP / PB / BP / BB.
// Scores each 2-step branch, then averages by first step to pick best entry.
// Uses a complementary weighting formula (heavier on apex + road final signal)
// vs the v1 formula — the two systems are designed to be orthogonal.

function runLegacyLookAhead(
  cleanHistory: Side[],
  metaAI: MetaAI,
  markovPred: string
): LookAheadResult {
  if (cleanHistory.length < 8) {
    return { active: false, verdict: null, bias: 0, strength: 0, recentAcc: metaAI.getRecentAccuracy(), avgP: 0, avgB: 0 };
  }

  const tail = cleanHistory.slice(-LOOK_AHEAD_TAIL);

  // Generate all 4 depth-2 branches: [P,P] [P,B] [B,P] [B,B]
  const branches: [Side, Side][] = [["P", "P"], ["P", "B"], ["B", "P"], ["B", "B"]];
  const branchScores: Map<Side, number[]> = new Map([["P", []], ["B", []]]);

  for (const [first, second] of branches) {
    const hypothetical = [...tail, first, second];
    const roadSnap = RoadEngine.computeSignalsForHistory(hypothetical);
    const nexusSnap = NexusEngine.computeApexForHistory(hypothetical);
    const feat = buildMetaFeatures(roadSnap, nexusSnap, hypothetical, markovPred);
    const pred = metaAI.predictPartial(feat.x);
    const conf = Math.max(pred.pPlayer, 1 - pred.pPlayer);
    // Legacy weighting: heavier on apex + road final signal (complementary to v1)
    const score = conf
      + Math.abs(feat.meta.apexSignal) * 0.12
      + Math.abs(feat.meta.roadFinalSignal) * 0.08
      + Math.abs(feat.meta.coreTransMean) * 0.04;
    branchScores.get(first)!.push(score);
  }

  const pBranches = branchScores.get("P")!;
  const bBranches = branchScores.get("B")!;
  const avgP = pBranches.reduce((s, v) => s + v, 0) / pBranches.length;
  const avgB = bBranches.reduce((s, v) => s + v, 0) / bBranches.length;
  const bias = avgP - avgB;
  const strength = Math.max(avgP, avgB);
  const verdict: Side | null = bias === 0 ? null : bias > 0 ? "P" : "B";

  return { active: true, verdict, bias, strength, recentAcc: metaAI.getRecentAccuracy(), avgP, avgB };
}

// ── GameSession ───────────────────────────────────────────────────────────────

const _DEFAULT_META_COMBINER_RESULT: MetaCombinerResult = {
  prediction: "WAIT",
  pPlayer: 0.5,
  confidence: "LOW",
  recentAccuracy: null,
  seen: 0,
  topFactors: [],
  convergenceCount: 0,
  convergenceTotal: 0,
};

export class GameSession {
  private syndicate = new SyndicateEngine();
  private road = new RoadEngine();
  private nexus = new NexusEngine();
  private markov = new ShortMarkov();
  private supreme = new SupremeBayesianAI();
  private regime = new RegimeSwitchTracker();
  private metaAI = new MetaAI();
  private observer = new ObserverMasterAI();
  private crisisAI = new CrisisAI();
  private metaCombiner = new MetaCombiner();
  private race = new RaceTracker();
  private history: HandValue[] = [];

  private _pendingFeatureX: number[] | null = null;
  private _pendingLookAhead: LookAheadResult = { active: false, verdict: null, bias: 0, strength: 0, recentAcc: null, avgP: 0, avgB: 0 };
  private _pendingLegacyLookAhead: LookAheadResult = { active: false, verdict: null, bias: 0, strength: 0, recentAcc: null, avgP: 0, avgB: 0 };
  private _pendingMetaDecision: { decision: Side | "WAIT"; pPlayer: number } = { decision: "WAIT", pPlayer: 0.5 };
  private _pendingObserver: { decision: Side | "WAIT"; wr: number | null; reasoning: string; isFallback: boolean } = {
    decision: "WAIT", wr: null, reasoning: "Insufficient Data", isFallback: true
  };
  private _pendingMetaCombiner: MetaCombinerResult = { ..._DEFAULT_META_COMBINER_RESULT };
  private _pendingOracle: OracleResult = {
    verdict: "WAIT", confidence: "LOW", netScore: 0,
    agreementCount: 0, totalSignals: 0,
    championAligned: false, consensusPulse: false,
    waitReason: "Collecting data", topReasons: [],
  };

  /** Process a new hand result and update all local engines immediately */
  handleInput(value: string): GameSnapshot {
    const v = value.toUpperCase() as HandValue;
    if (v !== "B" && v !== "P" && v !== "T") throw new Error(`Invalid value: ${value}`);

    const actual = v === "T" ? null : (v as Side);

    // 0. Save undo state before mutating anything
    this.metaCombiner.saveState();
    this.race.saveState();

    // 1. Capture what the regime currently predicts (before scoring)
    //    — this is the "main prediction" for the hand being entered
    const priorMainDecision = this.regime.getVerdict().decision;
    this.crisisAI.setMainPrediction(priorMainDecision);

    // 2. Score all engines against this actual outcome
    if (actual) {
      this.supreme.evaluateOutcome(actual);
      this.regime.evaluateOutcome(actual);
      this.observer.evaluateOutcome(actual);
      if (this._pendingFeatureX) this.metaAI.onLabeled(this._pendingFeatureX, actual);
      // Update MetaCombiner weights with the resolved outcome
      this.metaCombiner.onLabeled(actual);
    }

    // 3. Record the outcome in all engines
    this.syndicate.calculateSyndicate(actual ?? "B");
    if (actual) {
      this.road.handleInput(actual);
      this.nexus.handleInput(actual);
      this.markov.record(actual);
    }
    this.history.push(v);

    // 4. Prepare the current context for the local CrisisAI scorer.
    const regimeNow = this.regime.getVerdict();

    // Build per-expert shoe data for the internal recovery scorer.
    const ALL_EXPERT_KEYS = [
      "supreme", "syndicate", "lookAhead", "legacyLookAhead", "metaAI", "observer",
      "bebRoad", "smallRoad", "cockroachRoad", "dualAuth",
      "bot1", "bot2", "bot3", "bot4", "bot5", "bot6",
      "bot7", "bot8", "bot9", "bot10", "bot11",
    ] as const;
    const expertShoeData: ExpertShoeData[] = ALL_EXPERT_KEYS.map((key) => {
      const s = regimeNow[key];
      const wins = s.predCount > 0 ? Math.round(s.rawWr * s.predCount) : 0;
      return {
        key,
        wins,
        losses: s.predCount - wins,
        lastPred: s.lastPred,
        currentRunIsWin: s.currentRunIsWin,
        currentRunLen: s.currentRunLen,
        momentum: s.momentum,
        compositeScore: s.compositeScore,
      };
    });

    this.crisisAI.evaluateOutcome(
      actual,
      [...this.history],
      expertShoeData,
      regimeNow.shadowLeader,
      regimeNow.shadowLeaderPred,
      regimeNow.ensembleVerdict,
      regimeNow.ensemblePercent,
      regimeNow.volatilityIndex,  // v2: volatility-aware scoring
    );

    // 5. Score the race tracker against the resolved outcome (uses predictions captured last hand)
    this.race.scoreHand(actual);

    // 6. Generate new predictions
    this._captureNewPredictions();
    return this.getSnapshot();
  }

  undo(): GameSnapshot {
    if (this.history.length === 0) return this.getSnapshot();
    this.history.pop();
    this.syndicate.undoLast();
    this.road.undoLast();
    this.nexus.undoLast();
    this.markov.undoLast();
    this.supreme.undoLast();
    this.regime.undoLast();
    this.metaAI.undoLast();
    this.observer.undoLast();
    this.crisisAI.undoLast();
    this.metaCombiner.undoLast();
    this.race.undoLast();
    this._captureNewPredictions();
    return this.getSnapshot();
  }

  reset(): GameSnapshot {
    this.history = [];
    this.syndicate.reset();
    this.road.reset();
    this.nexus.reset();
    this.markov.reset();
    this.supreme.reset();
    this.regime.reset();
    this.metaAI.reset();
    this.observer.reset();
    this.crisisAI.reset();
    this.metaCombiner.reset();
    this.race.reset();
    this._pendingFeatureX = null;
    this._pendingLookAhead = { active: false, verdict: null, bias: 0, strength: 0, recentAcc: null, avgP: 0, avgB: 0 };
    this._pendingLegacyLookAhead = { active: false, verdict: null, bias: 0, strength: 0, recentAcc: null, avgP: 0, avgB: 0 };
    this._pendingMetaDecision = { decision: "WAIT", pPlayer: 0.5 };
    this._pendingObserver = { decision: "WAIT", wr: null, reasoning: "Insufficient Data", isFallback: true };
    this._pendingMetaCombiner = { ..._DEFAULT_META_COMBINER_RESULT };
    return this.getSnapshot();
  }

  setWindow(n: number): GameSnapshot {
    this.regime.setWindow(n);
    return this.getSnapshot();
  }

  getSnapshot(): GameSnapshot {
    const metaStats = this.metaAI.getStats();
    const obsMem = this.observer.getMemorySnapshot();
    return {
      handCount: this.history.length,
      history: [...this.history],
      regime: this.regime.getVerdict(),
      lookAhead: { ...this._pendingLookAhead },
      legacyLookAhead: { ...this._pendingLegacyLookAhead },
      metaAI: {
        decision: this._pendingMetaDecision.decision,
        pPlayer: this._pendingMetaDecision.pPlayer,
        accuracy: this.metaAI.getRecentAccuracy(),
        seen: metaStats.seen,
      },
      observer: { ...this._pendingObserver },
      observerMemory: {
        meta: { winRate: obsMem.meta.winRate, total: obsMem.meta.total, lastPred: obsMem.meta.lastPred },
        lookAhead: { winRate: obsMem.lookAhead.winRate, total: obsMem.lookAhead.total, lastPred: obsMem.lookAhead.lastPred },
        derived: { winRate: obsMem.derived.winRate, total: obsMem.derived.total, lastPred: obsMem.derived.lastPred },
      },
      crisisAI: this.crisisAI.getResult(),
      metaCombiner: { ...this._pendingMetaCombiner },
      race: this.race.getState(),
      oracleAI: { ...this._pendingOracle },
    };
  }

  private _captureNewPredictions(): void {
    const roadSnap = this.road.getSnapshot();
    const nexusSnap = this.nexus.getSnapshot();
    const markovPred = this.markov.predict();
    const b2bAlert = this.syndicate.getB2BAlert();

    const normRoad = (v: string): Side | "WAIT" =>
      v === "B" ? "B" : v === "P" ? "P" : "WAIT";

    const cleanHistory = this.history.filter((h) => h !== "T") as Side[];

    // Build MetaAI feature vector
    const feat = buildMetaFeatures(roadSnap, nexusSnap, cleanHistory, markovPred);
    this._pendingFeatureX = feat.x;

    // MetaAI prediction
    const metaPred = this.metaAI.predict(feat.x);
    this._pendingMetaDecision = metaPred;
    const metaDecision: Side | "WAIT" = metaPred.pPlayer >= 0.55 ? "P"
      : metaPred.pPlayer <= 0.45 ? "B"
      : "WAIT";

    // Look-ahead v1: depth=1 (fast, ~1ms)
    const laResult = runLookAhead(cleanHistory, this.metaAI, markovPred);
    this._pendingLookAhead = laResult;

    // Look-ahead v2 / legacy: depth=2 (4 branches, ~2ms)
    const legacyResult = runLegacyLookAhead(cleanHistory, this.metaAI, markovPred);
    this._pendingLegacyLookAhead = legacyResult;

    // Observer verdict (uses last-captured predictions)
    const observerVerdict = this.observer.getUltimateVerdict();
    this._pendingObserver = observerVerdict;
    const observerDecision: Side | "WAIT" = observerVerdict.decision;

    // Feed all sub-system signals into Supreme Bayesian
    const qPreds: SupremePredInput = {
      appA: nexusSnap.apexSignal,
      appB: normRoad(roadSnap.nextPrediction),
      lookAhead: laResult.verdict ?? "WAIT",
      observer: observerDecision,
      metaAI: metaDecision,
      beb: normRoad(roadSnap.beb),
      sr: normRoad(roadSnap.sr),
      cp: normRoad(roadSnap.cp),
      markov: markovPred,
    };

    const supremeResult = this.supreme.predict(qPreds, nexusSnap.vol);

    // ── Capture all 10 experts in regime tracker ─────────────────────

    // Core 6
    this.regime.captureSupreme(supremeResult.decision);
    this.regime.captureSyndicate(b2bAlert);
    this.regime.captureLookAhead(laResult.verdict);
    this.regime.captureLegacyLookAhead(legacyResult.verdict);
    this.regime.captureMetaAI(metaDecision);
    this.regime.captureObserver(observerDecision);

    // Road 4 — BEB, Small Road, Cockroach (from road engine)
    const toSide = (v: string): "B" | "P" | null =>
      v === "B" ? "B" : v === "P" ? "P" : null;

    this.regime.captureBebRoad(toSide(roadSnap.beb));
    this.regime.captureSmallRoad(toSide(roadSnap.sr));
    this.regime.captureCockroachRoad(toSide(roadSnap.cp));

    // Dual-Auth Engine: nexus apex signal AND road final prediction must agree.
    // When they conflict the engine abstains (null = not counted this hand).
    const nexusSide = toSide(nexusSnap.apexSignal);
    const roadSide  = toSide(roadSnap.nextPrediction);
    const dualAuthSide: "B" | "P" | null =
      nexusSide && roadSide && nexusSide === roadSide ? nexusSide : null;
    this.regime.captureDualAuth(dualAuthSide);

    // Syndicate 11 — individual bot predictions tracked as separate regime experts
    const botPreds = this.syndicate.getBotPredictions();
    for (const { id, pred } of botPreds) {
      this.regime.captureBot(id, pred);
    }

    // Observer tracks predictions for next hand's scoring
    this.observer.capturePredictions(
      metaDecision,
      laResult.verdict,
      roadSnap.consensus
    );

    // ── MetaCombiner — capture all sub-system signals and generate final prediction ──
    const regimeVerdict = this.regime.getVerdict();
    const crisisResult = this.crisisAI.getResult();

    const metaCombinerInput: MetaCombinerInput = {
      metaAIPPlayer: metaPred.pPlayer,
      observerDecision: observerVerdict.decision,
      observerWR: observerVerdict.wr,
      lookAhead1Verdict: laResult.verdict,
      lookAhead1Bias: laResult.bias,
      lookAhead2Verdict: legacyResult.verdict,
      lookAhead2Bias: legacyResult.bias,
      crisisPrediction: crisisResult.prediction as Side | null,
      crisisActive: crisisResult.active,
      crisisConfidence: crisisResult.confidence as "LOW" | "MED" | "HIGH",
      ensembleVerdict: regimeVerdict.ensembleVerdict as Side | null,
      ensemblePercent: regimeVerdict.ensemblePercent,
      regimeDecision: regimeVerdict.decision as Side | null,
      shadowLeaderPred: regimeVerdict.shadowLeaderPred as Side | null,
      volatilityIndex: regimeVerdict.volatilityIndex,
    };
    this._pendingMetaCombiner = this.metaCombiner.captureFeatures(metaCombinerInput);

    // ── Race tracker — capture this hand's predictions for all 3 contestants ──
    const mcRacePred = this._pendingMetaCombiner.prediction === "WAIT"
      ? null
      : (this._pendingMetaCombiner.prediction as Side);
    const crisisRacePred = crisisResult.backgroundPrediction as Side | null;
    const ensembleRacePred = regimeVerdict.ensembleVerdict as Side | null;
    this.race.capturePredictions(mcRacePred, crisisRacePred, ensembleRacePred);

    // ── Oracle AI — synthesize all signals into a single final verdict ────────
    const raceState = this.race.getState();
    const totalExperts = 21; // 10 core + 11 bots tracked by regime

    const oracleInput: OracleInput = {
      handCount: this.history.length,

      mcPrediction: this._pendingMetaCombiner.prediction,
      mcPPlayer: this._pendingMetaCombiner.pPlayer,
      mcConfidence: this._pendingMetaCombiner.confidence,
      mcRecentAccuracy: this._pendingMetaCombiner.recentAccuracy,
      mcConvergenceCount: this._pendingMetaCombiner.convergenceCount,
      mcConvergenceTotal: this._pendingMetaCombiner.convergenceTotal,

      crisisActive: crisisResult.active,
      crisisPrediction: crisisResult.prediction,
      crisisBackgroundPrediction: crisisResult.backgroundPrediction,
      crisisConfidence: crisisResult.confidence,
      crisisConsecutiveLosses: crisisResult.consecutiveLosses,

      ensembleVerdict: regimeVerdict.ensembleVerdict,
      ensemblePercent: regimeVerdict.ensemblePercent,
      regimeDecision: regimeVerdict.decision,
      bothAgree: regimeVerdict.bothAgree,
      bothAgreeSide: regimeVerdict.bothAgreeSide,
      agreeCount: regimeVerdict.agreeCount,
      totalExperts,
      isLocked: regimeVerdict.isLocked,
      isSplit: regimeVerdict.isSplit,
      volatilityIndex: regimeVerdict.volatilityIndex,
      shadowLeaderPred: regimeVerdict.shadowLeaderPred,

      metaAIDecision: metaPred.pPlayer >= 0.55 ? "P" : metaPred.pPlayer <= 0.45 ? "B" : "WAIT",
      metaAIPPlayer: metaPred.pPlayer,
      metaAIAccuracy: this.metaAI.getRecentAccuracy(),
      metaAISeen: this.metaAI.getStats().seen,

      observerDecision: observerVerdict.decision,
      observerWR: observerVerdict.wr,
      observerIsFallback: observerVerdict.isFallback,

      laVerdict: laResult.verdict,
      laBias: laResult.bias,
      laStrength: laResult.strength,
      laRecentAcc: laResult.recentAcc,

      la2Verdict: legacyResult.verdict,
      la2Bias: legacyResult.bias,
      la2Strength: legacyResult.strength,

      raceActive: raceState.active,
      raceChampion: raceState.champion,
      raceChampionStreak: raceState.championStreak,
      raceAllAgree: raceState.allAgree,
      raceAgreeSide: raceState.agreeSide,
      raceMCAccuracy: raceState.metaCombiner.rollingAccuracy,
      raceCrisisAccuracy: raceState.crisisAI.rollingAccuracy,
      raceEnsembleAccuracy: raceState.ensemble.rollingAccuracy,
      raceMCPrediction: raceState.metaCombiner.prediction,
      raceCrisisPrediction: raceState.crisisAI.prediction,
      raceEnsemblePrediction: raceState.ensemble.prediction,
    };

    this._pendingOracle = computeOracle(oracleInput);
  }
}

// ── Per-user session store ───────────────────────────────────────────────────

const sessionStore = new Map<number, GameSession>();

export function getOrCreateSession(userId: number): GameSession {
  if (!sessionStore.has(userId)) {
    sessionStore.set(userId, new GameSession());
  }
  return sessionStore.get(userId)!;
}

export function clearSession(userId: number): void {
  sessionStore.delete(userId);
}
