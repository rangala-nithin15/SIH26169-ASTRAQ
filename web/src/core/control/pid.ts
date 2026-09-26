/**
 * Single-axis PID with the practical details a real servo loop needs:
 *   - derivative on a first-order-filtered error (noise immunity)
 *   - integral clamp, conditional integration when the rate saturates, and integral
 *     separation (integrate only near the setpoint) — together they prevent windup
 *   - output clamp to the gimbal rate limit
 * Input: angular error (deg). Output: rate command (deg/s).
 */
export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
  integralLimit: number;
  derivativeFilterS: number;
  /** |error| below which the integrator runs, deg. */
  integralZone?: number;
}

export class PidAxis {
  integral = 0;
  private dFilt = 0;
  private prevErr: number | null = null;
  lastP = 0;
  lastI = 0;
  lastD = 0;

  reset() {
    this.integral = 0;
    this.dFilt = 0;
    this.prevErr = null;
  }

  update(err: number, dt: number, g: PidGains, outLimit: number, feedForward = 0): number {
    if (dt <= 0) return 0;
    const rawD = this.prevErr === null ? 0 : (err - this.prevErr) / dt;
    this.prevErr = err;
    const a = g.derivativeFilterS > 0 ? dt / (g.derivativeFilterS + dt) : 1;
    this.dFilt += a * (rawD - this.dFilt);
    const p = g.kp * err;
    const d = g.kd * this.dFilt;
    const unsat = p + g.ki * this.integral + d + feedForward;
    const saturated = Math.abs(unsat) >= outLimit && Math.sign(unsat) === Math.sign(err);
    // Integral separation: only integrate near the setpoint, so large acquisition
    // transients cannot wind the integrator up.
    const near = g.integralZone === undefined || Math.abs(err) <= g.integralZone;
    if (!saturated && near) {
      this.integral = Math.max(-g.integralLimit, Math.min(g.integralLimit, this.integral + err * dt));
    }
    const i = g.ki * this.integral;
    this.lastP = p;
    this.lastI = i;
    this.lastD = d;
    return Math.max(-outLimit, Math.min(outLimit, p + i + d + feedForward));
  }
}
