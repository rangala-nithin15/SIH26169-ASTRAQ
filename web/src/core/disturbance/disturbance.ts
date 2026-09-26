/**
 * Disturbance models. Each one acts where it physically belongs:
 *   platform vibration / jitter / platform motion → attitude of the camera platform
 *                                                   (the encoders do NOT see it)
 *   wind                                          → rate disturbance on the gimbal axes
 *   atmosphere                                    → beacon transmission, airlight, gain
 *   turbulence                                    → scintillation + angle-of-arrival wander
 *   sensor noise                                  → per-pixel image noise (sensor.ts)
 *   dropouts                                      → beacon occluded in a frame
 */
import { AtmosphereMode, DisturbanceConfig } from '../config';
import { Rng } from '../math';

export interface AtmosphereEffect {
  transmission: number; // beacon power fraction reaching the sensor
  airlightGrey: number; // additive background, grey levels
  gain: number; // overall scene gain (low light)
  attenuationDb: number; // for the link budget, at zenith
  extraDropout: number;
  streaks: number; // rain streaks per frame
}

export function atmosphereEffect(mode: AtmosphereMode, strength: number): AtmosphereEffect {
  const s = Math.min(1, Math.max(0, strength));
  let transmission = 1;
  let airlight = 0;
  let gain = 1;
  let extraDropout = 0;
  let streaks = 0;
  switch (mode) {
    case 'clear':
      transmission = 1 - 0.12 * s;
      break;
    case 'haze':
      transmission = 1 - 0.6 * s;
      airlight = 38 * s;
      break;
    case 'fog':
      transmission = 1 - 0.93 * s;
      airlight = 85 * s;
      break;
    case 'rain':
      transmission = 1 - 0.5 * s;
      airlight = 18 * s;
      extraDropout = 0.12 * s;
      streaks = Math.round(30 * s);
      break;
    case 'low_light':
      gain = 1 - 0.75 * s;
      transmission = 1;
      break;
  }
  return {
    transmission,
    airlightGrey: airlight,
    gain,
    attenuationDb: -10 * Math.log10(Math.max(1e-4, transmission)),
    extraDropout,
    streaks,
  };
}

export interface DisturbanceState {
  /** Platform attitude offset added to the true optical axis, deg. */
  dPan: number;
  dTilt: number;
  /** Wind rate disturbance on each gimbal axis, deg/s. */
  windPan: number;
  windTilt: number;
  /** Beacon scintillation factor (mean 1). */
  scint: number;
  /** Angle-of-arrival wander of the spot, px. */
  aoaX: number;
  aoaY: number;
  dropout: boolean;
  /** Inside a scheduled outage window. */
  occluded: boolean;
  atm: AtmosphereEffect;
}

export class DisturbanceModel {
  private rng: Rng;
  private t = 0;
  private phases: number[];
  private wind = [0, 0];
  private logScint = 0;
  private aoa = [0, 0];
  private drift = [0, 0];
  private driftVel = [0, 0];
  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0xd157);
    this.phases = [0, 1, 2, 3].map(() => this.rng.uniform(0, Math.PI * 2));
  }

  reset() {
    this.t = 0;
    this.wind = [0, 0];
    this.logScint = 0;
    this.aoa = [0, 0];
    this.drift = [0, 0];
    this.driftVel = [0, 0];
  }

  /**
   * Advance by one camera frame.
   * @param ifovDeg angular size of one pixel at the nominal FOV (px → deg conversion)
   */
  step(dt: number, c: DisturbanceConfig, ifovDeg: number): DisturbanceState {
    this.t += dt;
    const t = this.t;
    const rng = this.rng;

    // Platform vibration: two incommensurate tones (engine + structure) per axis.
    const vib = c.vibrationPx * ifovDeg;
    const w = 2 * Math.PI * c.vibrationHz;
    let dPan = vib * (0.7 * Math.sin(w * t + this.phases[0]) + 0.3 * Math.sin(1.73 * w * t + this.phases[1]));
    let dTilt = vib * (0.7 * Math.sin(1.11 * w * t + this.phases[2]) + 0.3 * Math.sin(2.07 * w * t + this.phases[3]));

    // Camera jitter: uniform ±jitterPx per frame (PS item 23).
    dPan += rng.uniform(-1, 1) * c.jitterPx * ifovDeg;
    dTilt += rng.uniform(-1, 1) * c.jitterPx * ifovDeg;

    // Platform motion (PS item 25): slow attitude motion of the vehicle.
    const A = c.platformMotionPx * ifovDeg;
    if (c.platformMotion === 'linear') {
      const period = 10;
      const tri = 2 * Math.abs(((t / period) % 1) * 2 - 1) - 1; // −1…1 triangle
      dPan += A * tri;
      dTilt += 0.4 * A * tri;
    } else if (c.platformMotion === 'circular') {
      dPan += A * Math.cos((2 * Math.PI * t) / 8);
      dTilt += A * Math.sin((2 * Math.PI * t) / 8);
    } else if (c.platformMotion === 'random') {
      for (let i = 0; i < 2; i++) {
        this.driftVel[i] = 0.97 * this.driftVel[i] + 0.25 * A * rng.gauss() * Math.sqrt(dt);
        this.drift[i] = Math.max(-A, Math.min(A, this.drift[i] + this.driftVel[i]));
      }
      dPan += this.drift[0];
      dTilt += this.drift[1];
    }

    // Wind: low-pass (τ = 1.5 s) Gaussian rate disturbance on both axes.
    const aw = Math.exp(-dt / 1.5);
    const sw = c.windDegS * Math.sqrt(1 - aw * aw);
    this.wind = [aw * this.wind[0] + sw * rng.gauss(), aw * this.wind[1] + sw * rng.gauss()];

    // Turbulence: log-normal scintillation (τ ≈ 50 ms) and AoA wander (τ ≈ 100 ms).
    const sigChi = 0.55 * c.turbulence;
    const as = Math.exp(-dt / 0.05);
    this.logScint = as * this.logScint + sigChi * Math.sqrt(1 - as * as) * rng.gauss();
    const scint = Math.exp(this.logScint - (sigChi * sigChi) / 2);
    const aa = Math.exp(-dt / 0.1);
    const sa = 2.5 * c.turbulence * Math.sqrt(1 - aa * aa);
    this.aoa = [aa * this.aoa[0] + sa * rng.gauss(), aa * this.aoa[1] + sa * rng.gauss()];

    const atm = atmosphereEffect(c.atmosphere, c.atmosphereStrength);
    const period = c.occlusionPeriodS ?? 0;
    // Outage windows end each period, so the first one starts after period − dur seconds.
    const occluded = period > 0 && t % period >= period - Math.min(c.occlusionDurS ?? 1, period * 0.9);
    const randomDrop = rng.next() < Math.min(0.98, c.dropoutProb + atm.extraDropout);
    const dropout = occluded || randomDrop;

    return {
      dPan,
      dTilt,
      windPan: this.wind[0],
      windTilt: this.wind[1],
      scint,
      aoaX: this.aoa[0],
      aoaY: this.aoa[1],
      dropout,
      occluded,
      atm,
    };
  }
}
