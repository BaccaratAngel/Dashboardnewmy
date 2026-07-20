/**
 * GameSession — per-user orchestration of all prediction engines.
 * Instantiated once per user, lives in memory for the process lifetime.
 *
 * Data flow on each input(value):
 *   1. If B/P: score syndicate + supreme + regime against previous predictions
 *   2. Record the outcome in all engines
 *   3. Generate new predictions from all engines
 *   4. Capture predictions in regime tracker
 */

import { SyndicateEngine } from "./syndicate.js";
import { RoadEngine } from "./road.js";
import { NexusEngine } from "./nexus.js";
import { ShortMarkov, SupremeBayesianAI, type SupremePredInput } from "./supreme.js";
import { RegimeSwitchTracker, type RegimeVerdict } from "./regime.js";

type Side = "B" | "P";
type HandValue = "B" | "P" | "T";

export interface GameSnapshot {
  handCount: number;
  history: string[];
  regime: RegimeVerdict;
}

export class GameSession {
  private syndicate = new SyndicateEngine();
  private road = new RoadEngine();
  private nexus = new NexusEngine();
  private markov = new ShortMarkov();
  private supreme = new SupremeBayesianAI();
  private regime = new RegimeSwitchTracker();
  private history: HandValue[] = [];

  /** Process a new hand result */
  handleInput(value: string): GameSnapshot {
    const v = value.toUpperCase() as HandValue;
    if (v !== "B" && v !== "P" && v !== "T") {
      throw new Error(`Invalid value: ${value}`);
    }

    const actual = v === "T" ? null : v;

    // 1. Score all engines against this actual outcome (uses predictions from BEFORE this hand)
    if (actual) {
      this.supreme.evaluateOutcome(actual);
      this.regime.evaluateOutcome(actual);
    }

    // 2. Record the outcome in all engines
    this.syndicate.calculateSyndicate(actual ?? "B"); // T is treated as neutral for syndicate
    if (actual) {
      this.road.handleInput(actual);
      this.nexus.handleInput(actual);
      this.markov.record(actual);
    }
    this.history.push(v);

    // 3. Generate new predictions
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
    return this.getSnapshot();
  }

  /** Set the regime rolling window size */
  setWindow(n: number): GameSnapshot {
    this.regime.setWindow(n);
    return this.getSnapshot();
  }

  /** Read-only snapshot */
  getSnapshot(): GameSnapshot {
    return {
      handCount: this.history.length,
      history: [...this.history],
      regime: this.regime.getVerdict(),
    };
  }

  // ── Internal: generate and capture new predictions ──────────────────────

  private _captureNewPredictions(): void {
    // Get sub-engine predictions
    const roadSnap = this.road.getSnapshot();
    const nexusSnap = this.nexus.getSnapshot();
    const markovPred = this.markov.predict();
    const b2bAlert = this.syndicate.getB2BAlert();

    // Normalize road predictions
    const normRoad = (v: string): Side | "WAIT" =>
      v === "B" ? "B" : v === "P" ? "P" : "WAIT";

    const qPreds: SupremePredInput = {
      appA: nexusSnap.apexSignal,
      appB: normRoad(roadSnap.nextPrediction),
      lookAhead: "WAIT",   // LookAhead not ported (complex simulation)
      observer: "WAIT",    // ObserverMasterAI depends on MetaAI which is not ported
      metaAI: "WAIT",      // MetaAI (perceptron) not ported — will be added later
      beb: normRoad(roadSnap.beb),
      sr: normRoad(roadSnap.sr),
      cp: normRoad(roadSnap.cp),
      markov: markovPred,
    };

    // Run Supreme Bayesian prediction
    const supremeResult = this.supreme.predict(qPreds, nexusSnap.vol);

    // Capture in regime tracker
    this.regime.captureSupreme(supremeResult.decision);
    this.regime.captureSyndicate(b2bAlert);
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
