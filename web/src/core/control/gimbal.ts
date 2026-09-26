/**
 * Two-axis pan/tilt gimbal (azimuth over elevation).
 *
 * Each axis is a rate-commanded servo: the achieved rate follows the command through
 * a first-order lag, limited in rate (PS: 5–10 °/s) and acceleration. External rate
 * disturbances (wind torque) add to the achieved rate. Angles are limited; pan wraps
 * when its range covers the full circle.
 */
import { GimbalConfig } from '../config';
import { clamp, wrapDeg } from '../math';

export class Gimbal {
  pan = 0;
  tilt = 0;
  panRate = 0;
  tiltRate = 0;
  panCmd = 0;
  tiltCmd = 0;
  atLimit = false;

  constructor(public cfg: GimbalConfig) {}

  reset(pan: number, tilt: number) {
    this.pan = wrapDeg(pan);
    this.tilt = clamp(tilt, this.cfg.tiltMinDeg, this.cfg.tiltMaxDeg);
    this.panRate = this.tiltRate = this.panCmd = this.tiltCmd = 0;
  }

  step(dt: number, panCmd: number, tiltCmd: number, windPan = 0, windTilt = 0) {
    const c = this.cfg;
    this.panCmd = clamp(panCmd, -c.maxRateDegS, c.maxRateDegS);
    this.tiltCmd = clamp(tiltCmd, -c.maxRateDegS, c.maxRateDegS);
    const lag = Math.max(1e-3, c.rateLagS);
    const maxDv = c.maxAccelDegS2 * dt;
    const dvp = clamp(((this.panCmd - this.panRate) * dt) / lag, -maxDv, maxDv);
    const dvt = clamp(((this.tiltCmd - this.tiltRate) * dt) / lag, -maxDv, maxDv);
    this.panRate = clamp(this.panRate + dvp, -c.maxRateDegS, c.maxRateDegS);
    this.tiltRate = clamp(this.tiltRate + dvt, -c.maxRateDegS, c.maxRateDegS);

    const fullCircle = c.panMaxDeg - c.panMinDeg >= 360;
    let pan = this.pan + (this.panRate + windPan) * dt;
    let tilt = this.tilt + (this.tiltRate + windTilt) * dt;
    this.atLimit = false;
    if (fullCircle) pan = wrapDeg(pan);
    else if (pan < c.panMinDeg || pan > c.panMaxDeg) {
      pan = clamp(pan, c.panMinDeg, c.panMaxDeg);
      this.panRate = 0;
      this.atLimit = true;
    }
    if (tilt < c.tiltMinDeg || tilt > c.tiltMaxDeg) {
      tilt = clamp(tilt, c.tiltMinDeg, c.tiltMaxDeg);
      this.tiltRate = 0;
      this.atLimit = true;
    }
    this.pan = pan;
    this.tilt = tilt;
  }

  /**
   * Rate command that drives the gimbal to a pointing (pan, tilt) with a
   * decelerating profile (used by search, reacquisition and manual mode).
   */
  rateToward(panGoal: number, tiltGoal: number, gain = 3): [number, number] {
    const c = this.cfg;
    const profile = (e: number) => {
      const a = Math.abs(e);
      const v = Math.min(c.maxRateDegS, gain * a, Math.sqrt(2 * c.maxAccelDegS2 * 0.6 * a));
      return Math.sign(e) * v;
    };
    return [profile(wrapDeg(panGoal - this.pan)), profile(tiltGoal - this.tilt)];
  }
}
