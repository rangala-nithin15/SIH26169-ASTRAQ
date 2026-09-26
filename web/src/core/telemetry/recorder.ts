/**
 * Experiment recorder: keeps every snapshot of a run (without images) and exports
 * CSV (one row per frame) or JSON (config + summary + events + frames). The same
 * recording drives Replay.
 */
import { SimConfig } from '../config';
import { Snapshot, TransitionEvent } from './types';

export interface Recording {
  format: 'astraq-recording';
  version: 1;
  name: string;
  createdAt: string;
  source: string;
  config: SimConfig | null;
  frames: Snapshot[];
  events: TransitionEvent[];
}

const f = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d));

export const CSV_COLUMNS = [
  't_s',
  'frame',
  'state',
  'target_az_deg',
  'target_el_deg',
  'target_u_deg',
  'target_v_deg',
  'target_rate_deg_s',
  'range_km',
  'pan_deg',
  'tilt_deg',
  'pan_rate_deg_s',
  'tilt_rate_deg_s',
  'pan_cmd_deg_s',
  'tilt_cmd_deg_s',
  'hfov_deg',
  'det_valid',
  'det_x_px',
  'det_y_px',
  'det_confidence',
  'truth_x_px',
  'truth_y_px',
  'err_x_px',
  'err_y_px',
  'err_px',
  'err_deg',
  'kf_est_x_px',
  'kf_est_y_px',
  'kf_az_rate_deg_s',
  'kf_el_rate_deg_s',
  'proc_ms',
  'transmission',
  'aqs',
];

export function snapshotRow(s: Snapshot): string {
  const d = s.detection;
  return [
    f(s.t, 4),
    s.frame,
    s.state,
    f(s.target.az),
    f(s.target.el),
    f(s.target.u),
    f(s.target.v),
    f(s.target.angRateDegS),
    f(s.target.rangeKm, 2),
    f(s.gimbal.pan),
    f(s.gimbal.tilt),
    f(s.gimbal.panRate),
    f(s.gimbal.tiltRate),
    f(s.gimbal.panCmd),
    f(s.gimbal.tiltCmd),
    f(s.camera.hfovDeg, 3),
    d ? 1 : 0,
    f(d?.x, 2),
    f(d?.y, 2),
    f(d?.confidence, 3),
    f(s.target.truthPx?.[0], 2),
    f(s.target.truthPx?.[1], 2),
    f(s.error.px?.[0], 2),
    f(s.error.px?.[1], 2),
    f(s.error.magPx, 2),
    f(s.error.angDeg, 5),
    f(s.kalman.estPx?.[0], 2),
    f(s.kalman.estPx?.[1], 2),
    f(s.kalman.azRate),
    f(s.kalman.elRate),
    f(s.procMs, 3),
    f(s.disturbance.transmission, 3),
    f(s.metrics.aqs, 1),
  ].join(',');
}

export class Recorder {
  frames: Snapshot[] = [];
  events: TransitionEvent[] = [];
  active = false;
  startedAt = '';
  maxFrames = 30 * 60 * 20; // 20 minutes at 30 Hz

  start() {
    this.frames = [];
    this.events = [];
    this.active = true;
    this.startedAt = new Date().toISOString();
  }

  stop() {
    this.active = false;
  }

  push(s: Snapshot) {
    if (!this.active) return;
    if (this.frames.length >= this.maxFrames) {
      this.active = false;
      return;
    }
    const rest: Snapshot = { ...s };
    delete rest.plan;
    this.frames.push(rest);
    if (s.events.length) this.events.push(...s.events);
  }

  toCsv(): string {
    return [CSV_COLUMNS.join(','), ...this.frames.map(snapshotRow)].join('\n');
  }

  toRecording(name: string, config: SimConfig | null, source: string): Recording {
    return {
      format: 'astraq-recording',
      version: 1,
      name,
      createdAt: this.startedAt || new Date().toISOString(),
      source,
      config,
      frames: this.frames,
      events: this.events,
    };
  }
}

export function isRecording(x: unknown): x is Recording {
  return !!x && typeof x === 'object' && (x as Recording).format === 'astraq-recording' && Array.isArray((x as Recording).frames);
}
