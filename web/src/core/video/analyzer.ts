/**
 * Video benchmark path (PS "Benchmark-2"): the simulated pan/tilt camera is bypassed
 * and recorded frames go straight into the coarse-pointing pipeline:
 *
 *   frame → grey → CentroidDetector (+ learned verifier) → pixel-space Kalman
 *         → track state → per-frame centroid log + summary + performance report
 *
 * Mirror of server/astraq_engine/video.py. Works on any frame size (e.g. a full
 * 2000×2000 "screen" video). If the spot size is not given (0), it is estimated from
 * the first confident detections.
 */
import { CentroidDetector } from '../detection/centroid';
import { Rng } from '../math';
import type { SensorFrame } from '../optics/sensor';
import type { VideoReportSummary } from '../analysis/report';

class Axis {
  x = 0;
  v = 0;
  p00 = 1;
  p01 = 0;
  p11 = 1;
  init(x: number, pv: number, rv: number) {
    this.x = x;
    this.v = 0;
    this.p00 = pv;
    this.p01 = 0;
    this.p11 = rv;
  }
  predict(dt: number, q: number) {
    this.x += this.v * dt;
    const p00 = this.p00 + dt * (2 * this.p01 + dt * this.p11);
    const p01 = this.p01 + dt * this.p11;
    this.p00 = p00 + (q * dt ** 3) / 3;
    this.p01 = p01 + (q * dt ** 2) / 2;
    this.p11 = this.p11 + q * dt;
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

/** Constant-velocity Kalman filter in image pixels (there is no gimbal in this path). */
export class PixelKalman {
  x = new Axis();
  y = new Axis();
  ok = false;
  constructor(
    private q = 400,
    private r = 1.5,
    private gatePx = 40,
  ) {}
  step(dt: number, meas: [number, number] | null, gate = 25, gapFrames = 1): boolean {
    if (!this.ok) {
      if (!meas) return false;
      this.x.init(meas[0], 25, this.q);
      this.y.init(meas[1], 25, this.q);
      this.ok = true;
      return true;
    }
    this.x.predict(dt, this.q);
    this.y.predict(dt, this.q);
    if (!meas) return false;
    const nx = meas[0] - this.x.x;
    const ny = meas[1] - this.y.x;
    const nis = (nx * nx) / (this.x.p00 + this.r ** 2) + (ny * ny) / (this.y.p00 + this.r ** 2);
    if (nis > gate && Math.hypot(nx, ny) > this.gatePx * gapFrames) return false;
    this.x.update(nx, this.r ** 2);
    this.y.update(ny, this.r ** 2);
    return true;
  }
}

export interface VideoParams {
  /** Horizontal FOV of the video, deg (for angular error). PS default 4° at 640 px. */
  hfovDeg: number;
  /** Beacon size, px. 0 = estimate from the first detections. */
  spotSizePx: number;
  thresholdSigma: number;
  minConfidence: number;
  coastFrames: number;
  confirmFrames: number;
  verifier: boolean;
}

export const DEFAULT_VIDEO_PARAMS: VideoParams = {
  hfovDeg: 4,
  spotSizePx: 0,
  thresholdSigma: 5,
  minConfidence: 0.35,
  coastFrames: 5,
  confirmFrames: 2,
  verifier: true,
};

export const VIDEO_LOG_COLUMNS = [
  'frame',
  't_s',
  'state',
  'detected',
  'x_px',
  'y_px',
  'confidence',
  'kf_x_px',
  'kf_y_px',
  'err_x_px',
  'err_y_px',
  'err_px',
  'err_deg',
  'proc_ms',
  'truth_x_px',
  'truth_y_px',
  'centroid_err_px',
];

export interface VideoRow {
  frame: number;
  t: number;
  state: 'SEARCHING' | 'TRACKING';
  detected: boolean;
  x: number | null;
  y: number | null;
  confidence: number | null;
  kfX: number | null;
  kfY: number | null;
  errX: number | null;
  errY: number | null;
  err: number | null;
  errDeg: number | null;
  procMs: number;
  truthX: number | null;
  truthY: number | null;
  centroidErr: number | null;
}

export class VideoAnalyzer {
  private det = new CentroidDetector();
  private kf = new PixelKalman();
  private gateRoi = 60;
  private rng = new Rng(1);
  rows: VideoRow[] = [];
  private state: 'SEARCHING' | 'TRACKING' = 'SEARCHING';
  private misses = 0;
  private hits = 0;
  private tAcq: number | null = null;
  private lostAt: number | null = null;
  private reacq: number[] = [];
  private losses = 0;
  private cerrs: number[] = [];
  private sizeSamples: number[] = [];
  spotSizePx: number;
  width = 0;
  height = 0;

  constructor(
    public params: VideoParams = DEFAULT_VIDEO_PARAMS,
    public fps = 30,
  ) {
    this.spotSizePx = params.spotSizePx > 0 ? params.spotSizePx : 10;
  }

  /** Estimated or given spot size and whether it is still being estimated. */
  get estimating() {
    return this.params.spotSizePx <= 0 && this.sizeSamples.length < 5;
  }

  /** Frames the decoder skipped (only when explicit frame indices are given). */
  skipped = 0;
  private lastIndex = -1;

  /**
   * Analyse one frame. `frameIndex` (optional) is the frame's index in the video; when
   * the decoder skips frames, the filter then predicts over the real time gap.
   */
  process(data: Uint8Array | Uint8ClampedArray, width: number, height: number, truth?: [number, number] | null, frameIndex?: number): VideoRow {
    const i = frameIndex ?? this.rows.length;
    const gap = this.lastIndex >= 0 ? Math.max(1, i - this.lastIndex) : 1;
    if (frameIndex !== undefined && this.lastIndex >= 0) this.skipped += gap - 1;
    this.lastIndex = i;
    const dt = gap / this.fps;
    const t = i / this.fps;
    if (this.rows.length === 0) {
      // Motion model scaled to the frame: a full-screen video moves more pixels per second.
      const sc = Math.max(1, width / 640);
      this.kf = new PixelKalman(400 * sc * sc, 1.5, 40 * sc);
      this.gateRoi = 60 * sc;
    }
    this.width = width;
    this.height = height;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const kf = this.kf;
    const pred: [number, number] | null = kf.ok ? [kf.x.x + kf.x.v * dt, kf.y.x + kf.y.v * dt] : null;
    const rowIndex = this.rows.length;
    const frame: SensorFrame = {
      width,
      height,
      data: data as Uint8ClampedArray,
      truthPx: null,
      spotPx: null,
      spotVisible: false,
      spotSizePx: this.spotSizePx,
      spotPeak: 0,
      decoyPx: null,
      background: 0,
    };
    const estimating = this.estimating;
    const r = this.det.detect(frame, {
      frameIndex: rowIndex,
      t,
      predicted: pred,
      tracking: kf.ok && this.state !== 'SEARCHING',
      gatePx: this.gateRoi * Math.min(4, gap),
      expectedSizePx: this.spotSizePx,
      thresholdSigma: this.params.thresholdSigma,
      minConfidence: estimating ? 0 : this.params.minConfidence,
      rng: this.rng,
      verifier: this.params.verifier && !estimating,
      collectAll: estimating,
    });
    let d = r.detection;
    if (estimating) {
      // Size estimation: the strongest blobs (by SNR) over the first frames.
      // Strongest compact blob by integrated signal (impulse noise is 1–2 px and is skipped).
      const best = r.candidates.filter((c) => c.area >= 9).sort((a, b) => b.snr * Math.sqrt(b.area) - a.snr * Math.sqrt(a.area))[0];
      if (best && best.snr > 12) {
        this.sizeSamples.push(Math.sqrt(best.area));
        const s = [...this.sizeSamples].sort((a, b) => a - b);
        this.spotSizePx = Math.max(3, Math.min(40, s[Math.floor(s.length / 2)] - 1));
      }
      d = null;
    }
    const accepted = kf.step(dt, d ? [d.x, d.y] : null, 25, gap);
    if (accepted) {
      this.misses = 0;
      this.hits++;
    } else this.misses++;
    if (this.state === 'SEARCHING' && this.hits >= this.params.confirmFrames) {
      this.state = 'TRACKING';
      if (this.tAcq === null) this.tAcq = t;
      if (this.lostAt !== null) {
        this.reacq.push(t - this.lostAt);
        this.lostAt = null;
      }
    } else if (this.state === 'TRACKING' && this.misses > this.params.coastFrames) {
      this.state = 'SEARCHING';
      this.hits = 0;
      this.losses++;
      this.lostAt = t;
      kf.ok = false;
    } else if (this.state === 'SEARCHING' && this.misses > 0) this.hits = 0;
    const procMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const ifov = this.params.hfovDeg / width;
    const kx = kf.ok ? kf.x.x : null;
    const ky = kf.ok ? kf.y.x : null;
    const ex = kx !== null ? kx - width / 2 : null;
    const ey = ky !== null ? ky - height / 2 : null;
    const e = ex !== null && ey !== null ? Math.hypot(ex, ey) : null;
    let ce: number | null = null;
    if (truth && d) {
      ce = Math.hypot(d.x - truth[0], d.y - truth[1]);
      this.cerrs.push(ce);
    }
    const row: VideoRow = {
      frame: i,
      t,
      state: this.state,
      detected: !!d,
      x: d?.x ?? null,
      y: d?.y ?? null,
      confidence: d?.confidence ?? null,
      kfX: kx,
      kfY: ky,
      errX: ex,
      errY: ey,
      err: e,
      errDeg: e !== null ? e * ifov : null,
      procMs,
      truthX: truth?.[0] ?? null,
      truthY: truth?.[1] ?? null,
      centroidErr: ce,
    };
    this.rows.push(row);
    return row;
  }

  summary(fileName = 'video', truthProvided = false): VideoReportSummary {
    const n = this.rows.length;
    const proc = this.rows.reduce((a, r) => a + r.procMs, 0);
    const detected = this.rows.filter((r) => r.detected).length;
    const after = this.tAcq === null ? [] : this.rows.filter((r) => r.t >= (this.tAcq as number));
    const tracked = after.filter((r) => r.state === 'TRACKING').length;
    const ce = this.cerrs;
    return {
      fileName,
      width: this.width,
      height: this.height,
      fps: this.fps,
      frames: n,
      detectionRate: n ? detected / n : 0,
      acquisitionS: this.tAcq,
      lossPct: after.length ? (100 * (after.length - tracked)) / after.length : null,
      reacqMaxS: this.reacq.length ? Math.max(...this.reacq) : null,
      centroidRmsePx: ce.length ? Math.sqrt(ce.reduce((a, b) => a + b * b, 0) / ce.length) : null,
      centroidMaxPx: ce.length ? Math.max(...ce) : null,
      procMeanMs: n ? proc / n : 0,
      processingFps: n && proc > 0 ? (1000 * n) / proc : 0,
      lockRetentionPct: after.length ? (100 * tracked) / after.length : null,
      truthProvided,
    };
  }

  csv(): string {
    const f = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? '' : v.toFixed(d));
    const lines = [VIDEO_LOG_COLUMNS.join(',')];
    for (const r of this.rows)
      lines.push(
        [
          r.frame,
          r.t.toFixed(4),
          r.state,
          r.detected ? 1 : 0,
          f(r.x),
          f(r.y),
          f(r.confidence, 3),
          f(r.kfX),
          f(r.kfY),
          f(r.errX),
          f(r.errY),
          f(r.err),
          f(r.errDeg, 5),
          r.procMs.toFixed(3),
          f(r.truthX),
          f(r.truthY),
          f(r.centroidErr, 3),
        ].join(','),
      );
    return lines.join('\n') + '\n';
  }
}

/** Ground truth CSV: header with frame,x,y (extra columns ignored). */
export function parseTruthCsv(text: string): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return out;
  const head = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const fi = head.indexOf('frame');
  const xi = head.indexOf('x');
  const yi = head.indexOf('y');
  if (fi < 0 || xi < 0 || yi < 0) return out;
  for (const l of lines.slice(1)) {
    const p = l.split(',');
    const fr = Number(p[fi]);
    const x = Number(p[xi]);
    const y = Number(p[yi]);
    if (Number.isFinite(fr) && Number.isFinite(x) && Number.isFinite(y)) out.set(fr, [x, y]);
  }
  return out;
}

/** RGBA → grey (BT.601 luma), in place into `out`. */
export function rgbaToGray(rgba: Uint8ClampedArray, out: Uint8Array) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
}
