/**
 * Detection provider registry. To add a detector (e.g. a YOLO model served by the
 * FastAPI engine, or a hardware camera pipeline), implement `DetectionProvider` and
 * register it here — the engine picks it via `config.detection.provider`.
 */
import { DetectionConfig } from '../config';
import { CentroidDetector } from './centroid';
import { SyntheticDetector } from './synthetic';
import { DetectionProvider } from './types';

export interface ProviderInfo {
  id: string;
  label: string;
  status: 'available' | 'planned';
  note: string;
}

export const DETECTION_PROVIDERS: ProviderInfo[] = [
  { id: 'centroid', label: 'Image centroid + AI verifier', status: 'available', note: 'Classical CV on the rendered frame; candidates scored by a trained neural network' },
  { id: 'synthetic', label: 'Synthetic model', status: 'available', note: 'Truth + configurable noise, misses, latency' },
  { id: 'yolo', label: 'YOLO detector', status: 'planned', note: 'Not implemented — interface ready (see README §20)' },
];

export function createDetector(cfg: DetectionConfig): DetectionProvider {
  if (cfg.provider === 'synthetic') return new SyntheticDetector(cfg.syntheticNoisePx, cfg.syntheticMissProb);
  return new CentroidDetector();
}
