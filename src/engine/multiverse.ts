export type Prediction = 'P' | 'B' | 'T' | 'WAIT';

export interface ShoeHand {
  actual: 'P' | 'B' | 'T';
  oraclePrediction: Prediction;
}

export interface MultiverseStats {
  prediction: Prediction;
  accuracy8: number;
  accuracy12: number;
  accuracy16: number;
  totalEvaluated: number;
}

/**
 * Inverts Oracle predictions: P -> B, B -> P, WAIT/T -> WAIT
 */
export function getMultiversePrediction(oraclePred: Prediction): Prediction {
  if (oraclePred === 'P') return 'B';
  if (oraclePred === 'B') return 'P';
  return 'WAIT';
}

/**
 * Calculates rolling accuracy for Multiverse signals across specified window sizes
 */
export function calculateMultiverseStats(
  history: ShoeHand[],
  currentOraclePred: Prediction
): MultiverseStats {
  const nextPred = getMultiversePrediction(currentOraclePred);

  const evaluateWindow = (size: number): number => {
    const window = history.slice(-size);
    if (window.length === 0) return 0;

    let correct = 0;
    let validHands = 0;

    for (const hand of window) {
      const multiPred = getMultiversePrediction(hand.oraclePrediction);
      // Ties are ignored in traditional accuracy checks unless specified
      if (multiPred !== 'WAIT' && hand.actual !== 'T') {
        validHands++;
        if (multiPred === hand.actual) {
          correct++;
        }
      }
    }

    return validHands > 0 ? Math.round((correct / validHands) * 100) : 0;
  };

  return {
    prediction: nextPred,
    accuracy8: evaluateWindow(8),
    accuracy12: evaluateWindow(12),
    accuracy16: evaluateWindow(16),
    totalEvaluated: history.length,
  };
}
