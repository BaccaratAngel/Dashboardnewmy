/**
 * Supreme Bayesian AI + Short Markov
 * Ported faithfully from app.html SupremeBayesianAI & ShortMarkov.
 */

type Side = "B" | "P";

// ── Short Markov (15-hand rolling window) ────────────────────────────────────

export class ShortMarkov {
  private windowSize = 15;
  private history: Side[] = [];

  record(outcome: Side): void {
    this.history.push(outcome);
    if (this.history.length > this.windowSize + 1) this.history.shift();
  }

  predict(): Side | "WAIT" {
    if (this.history.length < 3) return "WAIT";
    let pp = 0, pb = 0, bp = 0, bb = 0;
    for (let i = 0; i < this.history.length - 1; i++) {
      const from = this.history[i];
      const to = this.history[i + 1];
      if (from === "P" && to === "P") pp++;
      if (from === "P" && to === "B") pb++;
      if (from === "B" && to === "P") bp++;
      if (from === "B" && to === "B") bb++;
    }
    const last = this.history[this.history.length - 1];
    if (last === "P") {
      if (pp === pb) return "WAIT";
      return pp > pb ? "P" : "B";
    } else {
      if (bb === bp) return "WAIT";
      return bb > bp ? "B" : "P";
    }
  }

  undoLast(): void {
    this.history.pop();
  }

  reset(): void {
    this.history = [];
  }
}

// ── Supreme Bayesian AI ──────────────────────────────────────────────────────

export interface SupremePredInput {
  appA: Side | "WAIT";
  appB: Side | "WAIT";
  lookAhead: Side | "WAIT";
  observer: Side | "WAIT";
  metaAI: Side | "WAIT";
  beb: Side | "NEUTRAL" | "WAIT";
  sr: Side | "NEUTRAL" | "WAIT";
  cp: Side | "NEUTRAL" | "WAIT";
  markov: Side | "WAIT";
}

export interface SupremeResult {
  decision: Side | "WAIT";
  confidence: number;
}

type WeightKey = "appA" | "appB" | "lookAhead" | "observer" | "metaAI" | "beb" | "sr" | "cp";

interface ContextWeights {
  STREAK: Record<WeightKey, number>;
  CHOP: Record<WeightKey, number>;
  NEUTRAL: Record<WeightKey, number>;
}

function freshCtxWeights(): ContextWeights {
  const unit = (): Record<WeightKey, number> => ({
    appA: 1, appB: 1, lookAhead: 1, observer: 1, metaAI: 1, beb: 1, sr: 1, cp: 1,
  });
  return { STREAK: unit(), CHOP: unit(), NEUTRAL: unit() };
}

interface StateSnap {
  history: Side[];
  contextWeights: ContextWeights;
  rollingVariance: Record<WeightKey, number>;
  markovOrder2: Record<string, { P: number; B: number }>;
  markovOrder3: Record<string, { P: number; B: number }>;
  emaFast: number;
  emaSlow: number;
  lastContextType: string;
  lastPredictions: SupremePredInput | null;
}

export class SupremeBayesianAI {
  private history: Side[] = [];
  private contextWeights: ContextWeights = freshCtxWeights();
  private rollingVariance: Record<WeightKey, number> = {
    appA: 0.5, appB: 0.5, lookAhead: 0.5, observer: 0.5,
    metaAI: 0.5, beb: 0.5, sr: 0.5, cp: 0.5,
  };
  private markovOrder2: Record<string, { P: number; B: number }> = {};
  private markovOrder3: Record<string, { P: number; B: number }> = {};
  private emaFast = 0.5;
  private emaSlow = 0.5;
  private lastContextType = "NEUTRAL";
  private lastPredictions: SupremePredInput | null = null;
  private baseLearningRate = 0.25;
  private _undoStack: StateSnap[] = [];

  private _save(): void {
    this._undoStack.push({
      history: [...this.history],
      contextWeights: JSON.parse(JSON.stringify(this.contextWeights)) as ContextWeights,
      rollingVariance: { ...this.rollingVariance },
      markovOrder2: JSON.parse(JSON.stringify(this.markovOrder2)) as Record<string, { P: number; B: number }>,
      markovOrder3: JSON.parse(JSON.stringify(this.markovOrder3)) as Record<string, { P: number; B: number }>,
      emaFast: this.emaFast,
      emaSlow: this.emaSlow,
      lastContextType: this.lastContextType,
      lastPredictions: this.lastPredictions ? { ...this.lastPredictions } : null,
    });
    if (this._undoStack.length > 200) this._undoStack.shift();
  }

  private getContextMetrics(isSwitch: boolean | null = null) {
    if (isSwitch !== null) {
      const sv = isSwitch ? 1.0 : 0.0;
      this.emaFast = this.emaFast * 0.6 + sv * 0.4;
      this.emaSlow = this.emaSlow * 0.85 + sv * 0.15;
    }
    const si = this.emaFast * 0.65 + this.emaSlow * 0.35;
    let streakW = 0, chopW = 0, neutralW = 0;
    if (si > 0.55) {
      chopW = Math.min(1.0, (si - 0.5) * 2.5);
      neutralW = 1.0 - chopW;
    } else if (si < 0.45) {
      streakW = Math.min(1.0, (0.5 - si) * 2.5);
      neutralW = 1.0 - streakW;
    } else {
      neutralW = 1.0;
    }
    let dominant = "NEUTRAL";
    if (streakW > chopW && streakW > neutralW) dominant = "STREAK";
    if (chopW > streakW && chopW > neutralW) dominant = "CHOP";
    return { streakW, chopW, neutralW, dominant, structuralIndex: si };
  }

  evaluateOutcome(actualOutcome: Side): void {
    this._save();
    const len = this.history.length;
    const isSwitch = len >= 1 ? this.history[len - 1] !== actualOutcome : null;
    const ctx = this.getContextMetrics(isSwitch);
    this.lastContextType = ctx.dominant;

    if (this.lastPredictions) {
      const engines: WeightKey[] = ["appA", "appB", "lookAhead", "observer", "metaAI", "beb", "sr", "cp"];
      engines.forEach((eng) => {
        const pred = this.lastPredictions![eng];
        if (pred === "P" || pred === "B") {
          const isCorrect = pred === actualOutcome ? 1.0 : 0.0;
          const errGrad = isCorrect - 0.5;
          this.rollingVariance[eng] = this.rollingVariance[eng] * 0.8 + Math.abs(errGrad) * 0.2;
          const lr = this.baseLearningRate * (1.0 - this.rollingVariance[eng]);
          (["STREAK", "CHOP", "NEUTRAL"] as const).forEach((mk) => {
            const inf = mk === "STREAK" ? ctx.streakW : mk === "CHOP" ? ctx.chopW : ctx.neutralW;
            if (inf > 0.02) {
              this.contextWeights[mk][eng] += lr * errGrad * inf;
              this.contextWeights[mk][eng] = Math.max(0.15, Math.min(this.contextWeights[mk][eng], 2.75));
            }
          });
        }
      });
    }

    this.history.push(actualOutcome);
    const newLen = this.history.length;
    if (newLen >= 3) {
      const s2 = this.history.slice(-3, -1).join("");
      if (!this.markovOrder2[s2]) this.markovOrder2[s2] = { P: 0, B: 0 };
      this.markovOrder2[s2][actualOutcome]++;
    }
    if (newLen >= 4) {
      const s3 = this.history.slice(-4, -1).join("");
      if (!this.markovOrder3[s3]) this.markovOrder3[s3] = { P: 0, B: 0 };
      this.markovOrder3[s3][actualOutcome]++;
    }
  }

  predict(currentPreds: SupremePredInput, bVol = 0.3): SupremeResult {
    this.lastPredictions = currentPreds;
    const ctx = this.getContextMetrics();
    this.lastContextType = ctx.dominant;

    const engines: WeightKey[] = ["appA", "appB", "lookAhead", "observer", "metaAI", "beb", "sr", "cp"];
    const activeWeights: Record<WeightKey, number> = {} as Record<WeightKey, number>;
    engines.forEach((eng) => {
      activeWeights[eng] =
        this.contextWeights.STREAK[eng] * ctx.streakW +
        this.contextWeights.CHOP[eng] * ctx.chopW +
        this.contextWeights.NEUTRAL[eng] * ctx.neutralW;
    });

    let scoreP = 0, scoreB = 0;
    engines.forEach((eng) => {
      const vote = currentPreds[eng];
      if (vote === "P") scoreP += activeWeights[eng];
      if (vote === "B") scoreB += activeWeights[eng];
    });

    // Markov overlays
    const len = this.history.length;
    let totalMarkovWeight = 0;
    if (len >= 3) {
      const s3 = this.history.slice(-3).join("");
      const m3 = this.markovOrder3[s3];
      if (m3) {
        const tot = m3.P + m3.B;
        if (tot >= 1) {
          scoreP += (m3.P / tot) * 1.8;
          scoreB += (m3.B / tot) * 1.8;
          totalMarkovWeight += 1.8;
        }
      }
    }
    if (len >= 2) {
      const s2 = this.history.slice(-2).join("");
      const m2 = this.markovOrder2[s2];
      if (m2) {
        const tot = m2.P + m2.B;
        if (tot >= 1) {
          const w = totalMarkovWeight > 0 ? 0.7 : 1.4;
          scoreP += (m2.P / tot) * w;
          scoreB += (m2.B / tot) * w;
        }
      }
    }

    // Softmax
    const maxScore = Math.max(scoreP, scoreB);
    const expP = Math.exp(scoreP - maxScore);
    const expB = Math.exp(scoreB - maxScore);
    const softmaxP = expP / (expP + expB);
    const softmaxB = expB / (expP + expB);

    let entropy = 0;
    if (softmaxP > 0 && softmaxB > 0) {
      entropy = -(softmaxP * Math.log2(softmaxP) + softmaxB * Math.log2(softmaxB));
    }

    const adaptiveThreshold = Math.max(0.65, Math.min(0.77, 0.69 + bVol * 0.1));

    if (scoreP === 0 && scoreB === 0) return { decision: "WAIT", confidence: 0 };
    if (entropy > 0.88) return { decision: "WAIT", confidence: 0 };
    if (softmaxP > adaptiveThreshold) return { decision: "P", confidence: softmaxP * 100 };
    if (softmaxB > adaptiveThreshold) return { decision: "B", confidence: softmaxB * 100 };
    return { decision: "WAIT", confidence: 0 };
  }

  undoLast(): void {
    if (this._undoStack.length === 0) return;
    const prev = this._undoStack.pop()!;
    this.history = prev.history;
    this.contextWeights = prev.contextWeights;
    this.rollingVariance = prev.rollingVariance;
    this.markovOrder2 = prev.markovOrder2;
    this.markovOrder3 = prev.markovOrder3;
    this.emaFast = prev.emaFast;
    this.emaSlow = prev.emaSlow;
    this.lastContextType = prev.lastContextType;
    this.lastPredictions = prev.lastPredictions;
  }

  reset(): void {
    this.history = [];
    this.contextWeights = freshCtxWeights();
    this.rollingVariance = { appA: 0.5, appB: 0.5, lookAhead: 0.5, observer: 0.5, metaAI: 0.5, beb: 0.5, sr: 0.5, cp: 0.5 };
    this.markovOrder2 = {};
    this.markovOrder3 = {};
    this.emaFast = 0.5;
    this.emaSlow = 0.5;
    this.lastContextType = "NEUTRAL";
    this.lastPredictions = null;
    this._undoStack = [];
  }
}
