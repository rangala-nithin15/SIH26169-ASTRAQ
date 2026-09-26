/**
 * Learned beacon verifier — the AI component of the detection chain.
 *
 * The classical detector proposes candidate blobs; this small multilayer perceptron
 * (11 → 16 → 8 → 1, tanh, sigmoid output) scores each one with the probability that it
 * is the beacon rather than a star, sensor noise, rain streak, fog halo or decoy glint.
 * Inputs are 11 scale-aware blob features (size vs expected footprint, SNR, fill,
 * aspect, flatness, saturation, ring contrast, noise level, brightness, spread).
 *
 * It was trained offline on labelled candidates harvested from simulated frames that
 * span every disturbance in the problem statement (web/scripts/verifier/). Weights and
 * the feature normalisation live in verifier_weights.json; the Python engine loads the
 * same file, so both engines make identical decisions.
 */
import weights from './verifier_weights.json';

export interface VerifierWeights {
  version: number;
  trained: boolean;
  features: string[];
  mean: number[];
  std: number[];
  layers: { w: number[][]; b: number[] }[];
  /** Operating point on the output probability. */
  threshold: number;
  /** Segmentation threshold (k·σ) used when the verifier is active. */
  segmentSigma: number;
  metrics?: Record<string, number | string>;
}

export const VERIFIER: VerifierWeights = weights as VerifierWeights;

export function verifierProbability(f: number[], W: VerifierWeights = VERIFIER): number {
  let h = f.map((v, i) => (v - W.mean[i]) / (W.std[i] || 1));
  W.layers.forEach((L, li) => {
    const out = new Array<number>(L.b.length);
    for (let j = 0; j < L.b.length; j++) {
      let s = L.b[j];
      const row = L.w[j];
      for (let i = 0; i < h.length; i++) s += row[i] * h[i];
      out[j] = li === W.layers.length - 1 ? s : Math.tanh(s);
    }
    h = out;
  });
  return 1 / (1 + Math.exp(-h[0]));
}
