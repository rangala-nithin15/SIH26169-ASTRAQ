/**
 * Synthetic detection provider — a *statistical model* of a detector, not a detector.
 *
 * It takes the true projected beacon position and returns it with Gaussian centroid
 * noise, a miss probability and a confidence that depend on the simulated
 * atmosphere and sensor noise. Useful for control-loop studies where you want to
 * set detector performance directly. The UI labels it "Synthetic (model)".
 */
import { DetectionContext, DetectionProvider, DetectionResult } from './types';
import { SensorFrame } from '../optics/sensor';

export class SyntheticDetector implements DetectionProvider {
  readonly id = 'synthetic';
  readonly label = 'Synthetic measurement model (truth + noise + misses)';
  readonly needsImage = false;
  constructor(
    private noisePx: number,
    private missProb: number,
  ) {}

  configure(noisePx: number, missProb: number) {
    this.noisePx = noisePx;
    this.missProb = missProb;
  }

  reset() {}

  detect(_frame: SensorFrame | null, ctx: DetectionContext): DetectionResult {
    const truth = ctx.truth;
    const empty: DetectionResult = { detection: null, candidates: [], procMs: 0.01, roi: null, threshold: 0 };
    if (!truth || !truth.px || !truth.visible) return empty;
    const T = truth.transmission;
    const noiseFactor = 1 + truth.noiseSigma / 10;
    const pMiss = Math.min(0.99, this.missProb + 0.5 * (1 - T) ** 2 + 0.002 * truth.noiseSigma);
    if (ctx.rng.next() < pMiss) return empty;
    const sigma = this.noisePx * noiseFactor;
    const x = truth.px[0] + sigma * ctx.rng.gauss();
    const y = truth.px[1] + sigma * ctx.rng.gauss();
    const confidence = Math.max(0.05, Math.min(0.99, 0.97 * Math.sqrt(T) - truth.noiseSigma / 150 + 0.02 * ctx.rng.gauss()));
    if (confidence < ctx.minConfidence) return empty;
    const half = ctx.expectedSizePx / 2;
    const cand = {
      x,
      y,
      bbox: [x - half, y - half, x + half, y + half] as [number, number, number, number],
      area: ctx.expectedSizePx ** 2,
      peak: 0,
      snr: 0,
      sizeScore: 1,
      confidence,
    };
    return { detection: { ...cand, candidates: 1 }, candidates: [cand], procMs: 0.01, roi: null, threshold: 0 };
  }
}
