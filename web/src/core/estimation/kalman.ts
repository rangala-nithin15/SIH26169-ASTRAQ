/**
 * Constant-velocity Kalman filter on the target's azimuth / elevation.
 *
 * Why angles and not pixels: pixel positions move whenever the gimbal moves. Each
 * measurement is converted to an absolute direction using the gimbal encoder pose
 * at capture time, so the filter estimates the *target's* own motion. Its velocity
 * estimate drives rate feed-forward, and its prediction bridges missed frames and
 * detection latency.
 *
 * State per axis: [angle (deg), rate (deg/s)]; the two axes are independent, so
 * the 4×4 filter is block-diagonal and is written out in closed form.
 * Process model: continuous white-noise acceleration with spectral density q.
 */
import { wrapDeg } from '../math';

class AxisFilter {
  x = 0;
  v = 0;
  p00 = 1;
  p01 = 0;
  p11 = 1;

  init(x: number, posVar: number, rateVar: number, v = 0) {
    this.x = x;
    this.v = v;
    this.p00 = posVar;
    this.p01 = 0;
    this.p11 = rateVar;
  }

  predict(dt: number, q: number) {
    this.x += this.v * dt;
    // P = F P Fᵀ + Q
    const p00 = this.p00 + dt * (2 * this.p01 + dt * this.p11);
    const p01 = this.p01 + dt * this.p11;
    const p11 = this.p11;
    this.p00 = p00 + (q * dt ** 3) / 3;
    this.p01 = p01 + (q * dt ** 2) / 2;
    this.p11 = p11 + q * dt;
  }

  innovation(z: number): { nu: number; S: (r: number) => number } {
    return { nu: z - this.x, S: (r: number) => this.p00 + r };
  }

  update(nu: number, r: number) {
    const S = this.p00 + r;
    const k0 = this.p00 / S;
    const k1 = this.p01 / S;
    this.x += k0 * nu;
    this.v += k1 * nu;
    const p00 = (1 - k0) * this.p00;
    const p01 = (1 - k0) * this.p01;
    const p11 = this.p11 - k1 * this.p01;
    this.p00 = p00;
    this.p01 = p01;
    this.p11 = p11;
  }
}

export interface KalmanEstimate {
  az: number;
  el: number;
  azRate: number;
  elRate: number;
  sigmaAz: number; // deg, 1σ position
  sigmaEl: number;
}

export class AngularKalman {
  private az = new AxisFilter();
  private el = new AxisFilter();
  initialized = false;
  /** Time the state refers to (capture time of the last processed frame). */
  t = 0;
  lastInnovationDeg = 0;
  lastNis = 0;
  updates = 0;
  adaptive = true;
  /** Measurement-noise inflation from innovation statistics (1 = as configured). */
  rScale = 1;
  private nisAvg = 1;

  reset() {
    this.initialized = false;
    this.updates = 0;
    this.rScale = 1;
    this.nisAvg = 1;
  }

  /** (Re)initialise on a measurement. keepRate carries the previous rate estimate over (re-acquisition). */
  init(az: number, el: number, t: number, sigmaDeg: number, keepRate = false) {
    const va = keepRate && this.initialized ? this.az.v : 0;
    const ve = keepRate && this.initialized ? this.el.v : 0;
    this.az.init(az, sigmaDeg ** 2, keepRate ? 1 : 4, va);
    this.el.init(el, sigmaDeg ** 2, keepRate ? 1 : 4, ve);
    this.t = t;
    this.initialized = true;
    this.updates = 1;
  }

  /** Advance the state to time t. */
  predictTo(t: number, q: number, el: number) {
    if (!this.initialized) return;
    const dt = t - this.t;
    if (dt <= 0) return;
    const c = Math.max(0.2, Math.cos((el * Math.PI) / 180));
    this.az.predict(dt, q / (c * c));
    this.el.predict(dt, q);
    this.t = t;
  }

  /**
   * Measurement update. `rDeg` is the 1σ measurement noise in degrees on the sky.
   * Returns false (and leaves the state untouched) if the innovation fails the gate.
   */
  update(azMeas: number, elMeas: number, rDeg: number, gate: number): boolean {
    const c = Math.max(0.2, Math.cos((this.el.x * Math.PI) / 180));
    const rs = this.adaptive ? this.rScale : 1;
    const rAz = (rDeg / c) ** 2 * rs;
    const rEl = rDeg ** 2 * rs;
    const zAz = this.az.x + wrapDeg(azMeas - this.az.x); // unwrap
    const nuAz = zAz - this.az.x;
    const nuEl = elMeas - this.el.x;
    const sAz = this.az.p00 + rAz;
    const sEl = this.el.p00 + rEl;
    const nis = (nuAz * nuAz) / sAz + (nuEl * nuEl) / sEl;
    this.lastNis = nis;
    this.lastInnovationDeg = Math.hypot(nuAz * c, nuEl);
    // Innovation-based adaptive measurement noise: the normalised innovation squared
    // should average 2 (two measurement dimensions). A persistent excess means the
    // measurements are noisier than assumed (jitter, vibration, turbulence).
    if (this.adaptive) {
      const ratio = Math.min(nis, 4 * gate) / 2;
      this.nisAvg += 0.08 * (ratio - this.nisAvg);
      this.rScale = Math.min(900, Math.max(1, this.rScale * Math.pow(this.nisAvg, 0.08)));
    }
    if (nis > gate * Math.max(1, this.nisAvg) && this.updates > 2) return false;
    this.az.update(nuAz, rAz);
    this.el.update(nuEl, rEl);
    this.updates++;
    return true;
  }

  /** State extrapolated to time t (does not modify the filter). */
  estimateAt(t: number): KalmanEstimate {
    const dt = Math.max(0, t - this.t);
    const c = Math.max(0.2, Math.cos((this.el.x * Math.PI) / 180));
    return {
      az: this.az.x + this.az.v * dt,
      el: this.el.x + this.el.v * dt,
      azRate: this.az.v,
      elRate: this.el.v,
      sigmaAz: Math.sqrt(Math.max(0, this.az.p00 + dt * dt * this.az.p11)) * c,
      sigmaEl: Math.sqrt(Math.max(0, this.el.p00 + dt * dt * this.el.p11)),
    };
  }
}
