/**
 * Scenario presets. Each is a patch on top of DEFAULT_CONFIG; selecting one restarts
 * the run. The same list is served by the FastAPI engine at GET /api/presets.
 */
import { DEFAULT_CONFIG, DeepPartial, SimConfig, cloneConfig, mergeConfig } from './config';

export interface ScenarioPreset {
  id: string;
  name: string;
  summary: string;
  patch: DeepPartial<SimConfig>;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'open-sky',
    name: 'Open Sky',
    summary: 'Clear night sky, LEO remote terminal on a circular residual motion. The reference case.',
    patch: {},
  },
  {
    id: 'ps-baseline',
    name: 'PS169 Baseline',
    summary: 'Problem-statement defaults: 4°×3° FOV only (no wide-field), square 10 px beacon, random start, 5 °/s gimbal.',
    patch: { camera: { wideAcquisition: false }, target: { trajectory: 'linear', speedDegS: 0.5 } },
  },
  {
    id: 'moving-platform',
    name: 'Moving Platform',
    summary: 'Terminal on a vehicle: platform motion, 8 Hz vibration and wind torque on the gimbal.',
    patch: {
      target: { trajectory: 'figure8', amplitudeDeg: 1.5, periodS: 14 },
      disturbance: { platformMotion: 'circular', platformMotionPx: 12, vibrationPx: 4, vibrationHz: 8, windDegS: 0.25, jitterPx: 3 },
    },
  },
  {
    id: 'high-jitter',
    name: 'High Jitter',
    summary: 'Camera jitter at the PS maximum (±20 px/frame). Shows the physical error floor of a coarse stage.',
    patch: { disturbance: { jitterPx: 20, vibrationPx: 6, vibrationHz: 12 } },
  },
  {
    id: 'weak-beacon',
    name: 'Weak Beacon',
    summary: 'Haze, dim 6 px beacon, strong turbulence and Gaussian σ = 18 noise with 3 % salt & pepper.',
    patch: {
      target: { spotSizePx: 6, beaconIntensity: 120, trajectory: 'sinusoidal' },
      disturbance: { atmosphere: 'haze', atmosphereStrength: 0.7, turbulence: 0.6, gaussianNoise: 18, saltPepper: 0.03 },
    },
  },
  {
    id: 'fast-target',
    name: 'Fast Target',
    summary: 'Random manoeuvring target at 1.5 °/s with a 10 °/s gimbal — tests rate feed-forward.',
    patch: { target: { trajectory: 'random', speedDegS: 1.5 }, gimbal: { maxRateDegS: 10, maxAccelDegS2: 60 } },
  },
  {
    id: 'acquisition-challenge',
    name: 'Acquisition Challenge',
    summary: 'Beacon starts in a field corner, rain and 30 % dropouts, decoy glint present.',
    patch: {
      target: { startMode: 'fixed', startUDeg: 5.6, startVDeg: -5.4, trajectory: 'stationary' },
      disturbance: { atmosphere: 'rain', atmosphereStrength: 0.6, dropoutProb: 0.3, decoy: true },
    },
  },
  {
    id: 'occlusion',
    name: 'Occlusion & Reacquisition',
    summary: 'A passing cloud hides the beacon for 1 s every 6 s on a circular path. Measures re-acquisition time (PS ≤ 1 s).',
    patch: { target: { trajectory: 'circular', amplitudeDeg: 1.4, periodS: 14 }, disturbance: { occlusionPeriodS: 6, occlusionDurS: 1 } },
  },
  {
    id: 'leo-pass',
    name: 'LEO Pass',
    summary: 'Real circular-orbit pass (550 km, 62° max elevation) with 2.5 s ephemeris timing error.',
    patch: { target: { trajectory: 'orbital' } },
  },
];

export function presetConfig(id: string, seed?: number): SimConfig {
  const p = SCENARIO_PRESETS.find((x) => x.id === id) ?? SCENARIO_PRESETS[0];
  const cfg = mergeConfig(cloneConfig(DEFAULT_CONFIG), p.patch);
  cfg.scenarioId = p.id;
  if (seed !== undefined) cfg.seed = seed;
  return cfg;
}
