/**
 * Detection layer contract. Any detector — the built-in image centroid detector,
 * the synthetic measurement model, or a future YOLO / external detector — only has
 * to implement `DetectionProvider`. The engine, tracker and UI never change.
 */
import { Rng } from '../math';
import { SensorFrame } from '../optics/sensor';

export interface Candidate {
  x: number;
  y: number;
  bbox: [number, number, number, number]; // x0, y0, x1, y1 (inclusive)
  area: number;
  peak: number;
  snr: number;
  sizeScore: number;
  confidence: number;
  /** Feature vector for the learned verifier (see verifier.ts). */
  features?: number[];
  /** Learned verifier output: probability that this blob is the beacon. */
  pBeacon?: number;
}

export interface Detection extends Candidate {
  /** Number of candidates considered in the frame. */
  candidates: number;
}

export interface DetectionContext {
  frameIndex: number;
  t: number;
  /** Predicted beacon pixel position (from the Kalman filter) when a track exists. */
  predicted: [number, number] | null;
  tracking: boolean;
  gatePx: number;
  expectedSizePx: number;
  thresholdSigma: number;
  minConfidence: number;
  rng: Rng;
  /** Rescore candidates with the learned verifier (MLP). */
  verifier?: boolean;
  /** Return every candidate (training-data export). */
  collectAll?: boolean;
  /** Internal: disable the coarse-to-fine search for large frames. */
  noPyramid?: boolean;
  /**
   * Ground truth — ONLY for the synthetic provider, which by definition models a
   * detector's output statistically. Image-based providers must ignore it.
   */
  truth?: { px: [number, number] | null; visible: boolean; transmission: number; noiseSigma: number };
}

export interface DetectionResult {
  detection: Detection | null;
  /** Top candidates (for the Sensor view overlay). */
  candidates: Candidate[];
  procMs: number;
  roi: [number, number, number, number] | null;
  threshold: number;
}

export interface DetectionProvider {
  readonly id: string;
  readonly label: string;
  /** True if the provider consumes the rendered image. */
  readonly needsImage: boolean;
  detect(frame: SensorFrame | null, ctx: DetectionContext): DetectionResult;
  reset(): void;
}
