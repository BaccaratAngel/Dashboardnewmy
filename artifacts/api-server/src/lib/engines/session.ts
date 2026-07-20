/**
 * GameSession — per-user orchestration of all prediction engines.
 * Instantiated once per user, lives in memory for the process lifetime.
 *
 * Data flow on each input(value):
 *   1. Score all engines against this actual outcome (prior predictions)
 *   2. Record the outcome in all engines
 *   3. Generate new predictions from all engines
 *   4. Run look-ahead (pure in-process branch simulation — no iframes, no delays)
 *   5. Capture predictions in regime tracker + observer
 */

import { SyndicateEngine } from "./syndicate.js";
import { RoadEngine } from "./road.js";
import { NexusEngine } from "./nexus.js";
import { ShortMarkov, SupremeBayesianAI, type SupremePredInput } from "./supreme.js";
import { RegimeSwitchTracker, type RegimeVerdict } from "./regime.js";
import { MetaAI, buildMetaFeatures } from "./meta-ai.js";
import { ObserverMasterAI } from "./observer.js";

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
}

// ── Pure in-process look-ahead (replaces iframe simulation) ─────────────────
// Browser original: 10s because of iframe message-passing + init polling.
// Here: pure in-memory function calls. Expected: <50ms at depth=1.

const LOOK_AHEAD_DEPTH = 1;
const LOOK_AHEAD_TAIL = 45; // max history handed to simulation

function runLookAhead(
  cleanHistory: Side[],
  metaAI: MetaAI,
  markovPred: string
): LookAheadResult {
  if (cleanHistory.length < 6) {
    // Not enough history for meaningful road signals
    return { active: false, verdict: null, bias: 0, strength: 0, recentAcc: metaAI.getRecentAccuracy(), avgP: 0, avgB: 0 };
  }

  const tail = cleanHistory.slice(-LOOK_AHEAD_TAIL);
  const branches: Side[] = ["P", "B"]; // depth=1: 2 branches

  const scores: { branch: Side; score: number; pPlayer: number }[] = [];

  for (const branch of branches) {
    const hypothetical = [...tail, branch];

    // Pure-function snapshots — no engine state mutation, no delays
    const roadSnap = RoadEngine.computeSignalsForHistory(hypothetical);
    const nexusSnap = NexusEngine.computeApexForHistory(hypothetical);

    const feat = buildMetaFeatures(roadSnap, nexusSnap, hypothetical, markovPred);
    const pred = metaAI.predictPartial(feat.x);
    const conf = Math.max(pred.pPlayer, 1 - pred.pPlayer);

    // Score mirrors original: conf + composite quality signals
    const score = conf
      + Math.abs(feat.meta.coreTransMean) * 0.08
      + Math.abs(feat.meta.apexSignal) * 0.04;

    scores.push({ branch, score, pPlayer: pred.pPlayer });
  }

  const pEntry = scores.find((s) => s.branch === "P")!;
  const bEntry = scores.find((s) => s.branch === "B")!;
  const avgP = pEntry.score;
  const avgB = bEntry.score;
  const bias = avgP - avgB;
  const strength = Math.max(avgP, avgB);
  const verdict: Side | null = bias === 0 ? null : bias > 0 ? "P" : "B";

  return {
    active: true,
    verdict,
    bias,
    strength,
    recentAcc: metaAI.getRecentAccuracy(),
    avgP,
    avgB,
  };
}

// ── GameSession ───────────────────────────────────────────────────────────────

export class GameSession {
  private syndicate = new SyndicateEngine();
  private road = new RoadEngine();
  private nexus = new NexusEngine();
  private markov = new ShortMarkov();
  private supreme = new SupremeBayesianAI();
  private regime = new RegimeSwitchTracker();
  private metaAI = new MetaAI();
  private observer = new ObserverMasterAI();
  private history: HandValue[] = [];

  // Pending state: feature vector built for the NEXT hand (used to learn after outcome arrives)
  private _pendingFeatureX: number[] | null = null;
  private _pendingLookAhead: LookAheadResult = { active: false, verdict: null, bias: 0, strength: 0, recentAcc: null, avgP: 0, avgB: 0 };
  private _pendingMetaDecision: { decision: Side | "WAIT"; pPlayer: number } = { decision: "WAIT", pPlayer: 0.5 };
  private _pendingObserver: { decision: Side | "WAIT"; wr: number | null; reasoning: string; isFallback: boolean } = {
    decision: "WAIT", wr: null, reasoning: "Insufficient Data", isFallback: true
  };

  /** Process a new hand result */
  handleInput(value: string): GameSnapshot {
    const v = value.toUpperCase() as HandValue;
    if (v !== "B" && v !== "P" && v !== "T") {
      throw new Error(`Invalid value: ${value}`);
    }

    const actual = v === "T" ? null : (v as Side);

    // 1. Score all engines against this actual outcome (uses predictions from BEFORE this hand)
    if (actual) {
      this.supreme.evaluateOutcome(actual);
      this.regime.evaluateOutcome(actual);
      this.observer.evaluateOutcome(actual);

      // Teach MetaAI from the feature vector that was pending before this hand
      if (this._pendingFeatureX) {
        this.metaAI.onLabeled(this._pendingFeatureX, actual);
      }
    }

    // 2. Record the outcome in all engines
    this.syndicate.calculateSyndicate(actual ?? "B");
    if (actual) {
      this.road.handleInput(actual);
      this.nexus.handleInput(actual);
      this.markov.record(actual);
    }
    this.history.push(v);

    // 3. Generate new predictions + run look-ahead
    this._captureNewPredictions();

    return this.getSnapshot();
  }

  /** Undo the last hand */
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

    // Re-capture predictions after undo
    this._captureNewPredictions();
    return this.getSnapshot();
  }

  /** Reset the entire shoe */
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
    this._pendingFeatureX = null;
    this._pendingLookAhead = { active: false, verdict: null, bias: 0, strength: 0, recentAcc: null, avgP: 0, avgB: 0 };
    this._pendingMetaDecision = { decision: "WAIT", pPlayer: 0.5 };
    this._pendingObserver = { decision: "WAIT", wr: null, reasoning: "Insufficient Data", isFallback: true };
    return this.getSnapshot();
  }

  /** Set the regime rolling window size */
  setWindow(n: number): GameSnapshot {
    this.regime.setWindow(n);
    return this.getSnapshot();
  }

  /** Read-only snapshot */
  getSnapshot(): GameSnapshot {
    const metaStats = this.metaAI.getStats();
    return {
      handCount: this.history.length,
      history: [...this.history],
      regime: this.regime.getVerdict(),
      lookAhead: { ...this._pendingLookAhead },
      metaAI: {
        decision: this._pendingMetaDecision.decision,
        pPlayer: this._pendingMetaDecision.pPlayer,
        accuracy: this.metaAI.getRecentAccuracy(),
        seen: metaStats.seen,
      },
      observer: { ...this._pendingObserver },
    };
  }

  // ── Internal: generate and capture new predictions ──────────────────────

  private _captureNewPredictions(): void {
    const roadSnap = this.road.getSnapshot();
    const nexusSnap = this.nexus.getSnapshot();
    const markovPred = this.markov.predict();
    const b2bAlert = this.syndicate.getB2BAlert();

    const normRoad = (v: string): Side | "WAIT" =>
      v === "B" ? "B" : v === "P" ? "P" : "WAIT";

    // Build MetaAI feature vector from current engine state
    const cleanHistory = this.history.filter((h) => h !== "T") as Side[];
    const feat = buildMetaFeatures(roadSnap, nexusSnap, cleanHistory, markovPred);
    this._pendingFeatureX = feat.x;

    // MetaAI prediction for this hand
    const metaPred = this.metaAI.predict(feat.x);
    this._pendingMetaDecision = metaPred;
    const metaDecision: Side | "WAIT" = metaPred.pPlayer >= 0.55 ? "P"
      : metaPred.pPlayer <= 0.45 ? "B"
      : "WAIT";

    // Look-ahead: fast in-process branch simulation
    const laResult = runLookAhead(cleanHistory, this.metaAI, markovPred);
    this._pendingLookAhead = laResult;

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

    // Capture in regime tracker
    this.regime.captureSupreme(supremeResult.decision);
    this.regime.captureSyndicate(b2bAlert);

    // Observer captures current predictions (evaluated against next hand's actual outcome)
    this.observer.capturePredictions(
      metaDecision,
      laResult.verdict,
      roadSnap.consensus
    );
  }
}

// ── Per-user session store (in-memory, by userId) ───────────────────────────

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
