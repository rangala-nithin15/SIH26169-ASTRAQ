/**
 * Run metrics, defined so they can be checked against the SIH26169 / PS169 limits:
 *   acquisition time ≤ 2 s    start → first LOCKED
 *   tracking error  ≤ 10 px   RMS true pointing error over TRACKING + LOCKED frames after first lock
 *   target loss     < 5 %     frames after first lock without an active track (beacon-visible frames)
 *   reacquisition   ≤ 1 s     LOST → next TRACKING/LOCKED, worst case. The clock starts when the beacon
 *                             is visible again (a scheduled outage is not counted against the tracker).
 *   processing      ≥ 20 FPS  engine frames per wall-clock second (host-measured)
 */
import { TrackState, MetricsSummary } from '../telemetry/types';
import { percentile } from '../math';

export interface FrameSample {
  t: number;
  state: TrackState;
  pointErrPx: number | null;
  centroidErrPx: number | null;
  confidence: number;
  procMs: number;
  falseDetection?: boolean;
  /** False while the beacon is inside a scheduled outage. */
  beaconVisible?: boolean;
}

export class RunMetrics {
  private t0 = 0;
  frames = 0;
  tDetect: number | null = null;
  tTrack: number | null = null;
  tLock: number | null = null;
  private errs: number[] = [];
  private cErrs: number[] = [];
  private afterLock = 0;
  private lossAfterLock = 0;
  private lockedAfterLock = 0;
  lossEvents = 0;
  falseDetections = 0;
  private reacq: number[] = [];
  private lostAt: number | null = null;
  private procSum = 0;
  private procMax = 0;
  private recent: FrameSample[] = [];
  fps = 0;

  reset(t0 = 0) {
    this.t0 = t0;
    this.frames = 0;
    this.tDetect = this.tTrack = this.tLock = null;
    this.errs = [];
    this.cErrs = [];
    this.afterLock = this.lossAfterLock = this.lockedAfterLock = 0;
    this.lossEvents = 0;
    this.falseDetections = 0;
    this.reacq = [];
    this.lostAt = null;
    this.procSum = 0;
    this.procMax = 0;
    this.recent = [];
  }

  update(s: FrameSample) {
    this.frames++;
    const rel = s.t - this.t0;
    if (s.state === 'DETECTED' && this.tDetect === null) this.tDetect = rel;
    if ((s.state === 'TRACKING' || s.state === 'LOCKED') && this.tTrack === null) this.tTrack = rel;
    if (s.state === 'LOCKED' && this.tLock === null) this.tLock = rel;
    const active = s.state === 'TRACKING' || s.state === 'LOCKED';
    // Steady-state tracking error: only after the first lock (acquisition transients excluded).
    if (active && s.pointErrPx !== null && (this.tLock !== null || s.state === 'LOCKED')) this.errs.push(s.pointErrPx);
    if (s.centroidErrPx !== null) this.cErrs.push(s.centroidErrPx);
    if (s.falseDetection) this.falseDetections++;
    // Loss and retention are counted over frames in which the beacon could be seen:
    // a scheduled outage (cloud) hides it physically and is not a tracker failure.
    if (this.tLock !== null && s.beaconVisible !== false) {
      this.afterLock++;
      if (!active) this.lossAfterLock++;
      if (s.state === 'LOCKED') this.lockedAfterLock++;
    }
    if (s.state === 'LOST' && this.lostAt === null) {
      this.lostAt = s.t;
      this.lossEvents++;
    }
    if (this.lostAt !== null && s.beaconVisible === false) this.lostAt = s.t;
    if (active && this.lostAt !== null) {
      this.reacq.push(s.t - this.lostAt);
      this.lostAt = null;
    }
    if (s.state === 'SEARCHING') this.lostAt = null; // escalated to global search: not a reacquisition
    this.procSum += s.procMs;
    this.procMax = Math.max(this.procMax, s.procMs);
    this.recent.push(s);
    while (this.recent.length && s.t - this.recent[0].t > 10) this.recent.shift();
  }

  /**
   * Alignment Quality Score, 0–100, over the last 10 s (not AI — a weighted sum):
   *   AQS = 100 × (0.45·S_err + 0.25·S_conf + 0.30·S_lock)
   *   S_err  = max(0, 1 − RMS pointing error / (2 × lock threshold))
   *   S_conf = mean detection confidence
   *   S_lock = fraction of frames LOCKED
   */
  aqs(lockPx: number): number {
    const r = this.recent;
    if (!r.length) return 0;
    let e2 = 0;
    let ne = 0;
    let conf = 0;
    let locked = 0;
    for (const s of r) {
      if (s.pointErrPx !== null && (s.state === 'TRACKING' || s.state === 'LOCKED')) {
        e2 += s.pointErrPx ** 2;
        ne++;
      }
      conf += s.confidence;
      if (s.state === 'LOCKED') locked++;
    }
    const rms = ne ? Math.sqrt(e2 / ne) : Infinity;
    const sErr = Number.isFinite(rms) ? Math.max(0, 1 - rms / (2 * lockPx)) : 0;
    return 100 * (0.45 * sErr + 0.25 * (conf / r.length) + 0.3 * (locked / r.length));
  }

  summary(elapsedS: number, lockPx: number): MetricsSummary {
    const e = this.errs;
    const rms = e.length ? Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length) : null;
    const mean = e.length ? e.reduce((a, b) => a + b, 0) / e.length : null;
    const cr = this.cErrs.length ? Math.sqrt(this.cErrs.reduce((a, b) => a + b * b, 0) / this.cErrs.length) : null;
    const lossPct = this.afterLock ? (100 * this.lossAfterLock) / this.afterLock : null;
    const reacqMax = this.reacq.length ? Math.max(...this.reacq) : null;
    const s: MetricsSummary = {
      elapsedS,
      frames: this.frames,
      tDetect: this.tDetect,
      tTrack: this.tTrack,
      acquisitionS: this.tLock,
      errMeanPx: mean,
      errRmsPx: rms,
      errMaxPx: e.length ? Math.max(...e) : null,
      errP95Px: e.length ? percentile(e.length > 4000 ? e.slice(-4000) : e, 95) : null,
      centroidRmsPx: cr,
      falseDetections: this.falseDetections,
      lossPct,
      lossEvents: this.lossEvents,
      reacqMeanS: this.reacq.length ? this.reacq.reduce((a, b) => a + b, 0) / this.reacq.length : null,
      reacqMaxS: reacqMax,
      lockRetentionPct: this.afterLock ? (100 * this.lockedAfterLock) / this.afterLock : null,
      procMeanMs: this.frames ? this.procSum / this.frames : 0,
      procMaxMs: this.procMax,
      fps: this.fps,
      aqs: this.aqs(lockPx),
      acceptance: {
        acquisition: this.tLock === null ? null : this.tLock <= 2,
        error: rms === null ? null : rms <= 10,
        loss: lossPct === null ? null : lossPct < 5,
        reacq: reacqMax === null ? null : reacqMax <= 1,
        fps: this.fps > 0 ? this.fps >= 20 : null,
      },
    };
    return s;
  }
}
