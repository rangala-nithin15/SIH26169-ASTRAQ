/**
 * One-click demonstration: a 90 s scripted sequence of scenario changes. Each phase
 * only patches the configuration — the tracking behaviour that follows is the real
 * closed-loop response, nothing is scripted on the tracker side.
 */
import { DeepPartial, SimConfig } from '../config';

export interface DemoPhase {
  start: number;
  end: number;
  title: string;
  caption: string;
  patch: DeepPartial<SimConfig>;
}

const CLEAR: DeepPartial<SimConfig> = {
  disturbance: { atmosphere: 'clear', atmosphereStrength: 0.2, gaussianNoise: 6, saltPepper: 0.002, dropoutProb: 0, turbulence: 0.2 },
};

export const DEMO_PHASES: DemoPhase[] = [
  {
    start: 0,
    end: 10,
    title: 'Acquisition · stationary beacon',
    caption: 'Beacon starts at a random point of the 12.5° search field. Wide-field camera scans, detects, zooms to 4° and locks.',
    patch: { ...CLEAR, target: { trajectory: 'stationary' } },
  },
  {
    start: 10,
    end: 25,
    title: 'Linear target motion',
    caption: 'Beacon drifts in a straight line at 0.8 °/s. Kalman velocity estimate feeds the PID as rate feed-forward.',
    patch: { target: { trajectory: 'linear', speedDegS: 0.8, headingDeg: 25 } },
  },
  {
    start: 25,
    end: 45,
    title: 'Circular target motion',
    caption: 'Continuous turning motion: the gimbal keeps the beacon inside the 10 px lock circle.',
    patch: { target: { trajectory: 'circular', amplitudeDeg: 1.8, periodS: 12, headingDeg: 0 } },
  },
  {
    start: 45,
    end: 60,
    title: 'Sinusoidal target motion',
    caption: 'Higher-frequency cross-track component tests the loop bandwidth.',
    patch: { target: { trajectory: 'sinusoidal', amplitudeDeg: 2.0, periodS: 14, headingDeg: 10 } },
  },
  {
    start: 60,
    end: 70,
    title: 'Detection degradation',
    caption: 'Fog, heavy sensor noise and 60 % beacon dropouts. The tracker coasts on prediction, declares LOST, then searches locally.',
    patch: {
      disturbance: { atmosphere: 'fog', atmosphereStrength: 0.8, gaussianNoise: 14, saltPepper: 0.04, dropoutProb: 0.6, turbulence: 0.5 },
    },
  },
  {
    start: 70,
    end: 90,
    title: 'Recovery & reacquisition',
    caption: 'Conditions clear. The beacon is reacquired from the predicted position and the link returns to LOCKED on a figure-8 path.',
    patch: { ...CLEAR, target: { trajectory: 'figure8', amplitudeDeg: 1.6, periodS: 16, headingDeg: 0 } },
  },
];

export const DEMO_DURATION = DEMO_PHASES[DEMO_PHASES.length - 1].end;

export function demoPhaseAt(t: number): number {
  for (let i = DEMO_PHASES.length - 1; i >= 0; i--) if (t >= DEMO_PHASES[i].start) return i;
  return 0;
}
