/**
 * Telemetry contract between an engine (browser worker, FastAPI server or replay)
 * and the UI. The Python engine emits exactly these field names.
 */
export type TrackState = 'IDLE' | 'SEARCHING' | 'DETECTED' | 'ACQUIRING' | 'TRACKING' | 'LOCKED' | 'LOST' | 'REACQUIRING';

export const TRACK_STATES: TrackState[] = ['IDLE', 'SEARCHING', 'DETECTED', 'ACQUIRING', 'TRACKING', 'LOCKED', 'LOST', 'REACQUIRING'];

export interface TransitionEvent {
  t: number;
  kind: 'transition' | 'info' | 'warn';
  from?: TrackState;
  to?: TrackState;
  message: string;
}

export interface MetricsSummary {
  elapsedS: number;
  frames: number;
  /** Start → first confirmed detection / first TRACKING / first LOCKED, s. */
  tDetect: number | null;
  tTrack: number | null;
  acquisitionS: number | null;
  /** Pointing error (true target vs optical axis) over TRACKING+LOCKED frames, px. */
  errMeanPx: number | null;
  errRmsPx: number | null;
  errMaxPx: number | null;
  errP95Px: number | null;
  /** Centroid error (detected vs rendered spot), px. */
  centroidRmsPx: number | null;
  /** Accepted detections not associated with the beacon (noise, stars, decoy). */
  falseDetections: number;
  /** Share of frames after first lock without an active track, %. */
  lossPct: number | null;
  lossEvents: number;
  reacqMeanS: number | null;
  reacqMaxS: number | null;
  lockRetentionPct: number | null;
  procMeanMs: number;
  procMaxMs: number;
  /** Engine frame rate (simulated frames per wall-clock second), filled in by the host. */
  fps: number;
  /** Alignment Quality Score (transparent formula, see analysis/link.ts). */
  aqs: number;
  acceptance: { acquisition: boolean | null; error: boolean | null; loss: boolean | null; reacq: boolean | null; fps: boolean | null };
}

export interface LinkEstimate {
  rangeKm: number;
  geomLossDb: number;
  atmLossDb: number;
  pointingLossDb: number;
  prDbm: number;
  marginDb: number;
  fineHandover: boolean;
  pAcquire2s: number;
  pInitialInView: number;
  pDetectFrame: number;
}

export interface Snapshot {
  t: number;
  frame: number;
  state: TrackState;
  stateSince: number;
  mode: 'auto' | 'manual';
  running: boolean;
  source: string;
  target: {
    az: number;
    el: number;
    rangeKm: number;
    posKm: [number, number, number];
    u: number;
    v: number;
    angRateDegS: number;
    transverseKmS: number;
    inFov: boolean;
    truthPx: [number, number] | null;
    decoyPx: [number, number] | null;
    refAz: number;
    refEl: number;
  };
  gimbal: {
    pan: number;
    tilt: number;
    panRate: number;
    tiltRate: number;
    panCmd: number;
    tiltCmd: number;
    atLimit: boolean;
    /** Actual optical axis incl. platform disturbance. */
    axisAz: number;
    axisEl: number;
    boresightU: number;
    boresightV: number;
    goalU: number | null;
    goalV: number | null;
  };
  camera: { width: number; height: number; hfovDeg: number; vfovDeg: number; ifovDeg: number; focalMm: number; fx: number };
  detection: {
    valid: boolean;
    x: number;
    y: number;
    bbox: [number, number, number, number];
    confidence: number;
    snr: number;
    area: number;
    candidates: number;
    accepted: boolean;
  } | null;
  candidates: { x: number; y: number; confidence: number }[];
  procMs: number;
  roi: [number, number, number, number] | null;
  kalman: {
    enabled: boolean;
    initialized: boolean;
    measPx: [number, number] | null;
    estPx: [number, number] | null;
    predPx: [number, number] | null;
    sigmaPx: [number, number];
    azRate: number;
    elRate: number;
    innovationPx: number;
  };
  error: {
    /** True pointing error (target − optical axis), px; +x right, +y down. */
    px: [number, number] | null;
    magPx: number | null;
    angDeg: number;
    /** Error the tracker believes (estimate/measurement), px. */
    estMagPx: number | null;
  };
  control: { p: [number, number]; i: [number, number]; d: [number, number]; ff: [number, number] };
  disturbance: { dPanDeg: number; dTiltDeg: number; transmission: number; scint: number; dropout: boolean; occluded: boolean };
  metrics: MetricsSummary;
  link: LinkEstimate;
  timeline: { search: number | null; detect: number | null; acquire: number | null; track: number | null; lock: number | null };
  events: TransitionEvent[];
  demo: { active: boolean; phase: number; phases: number; title: string; caption: string; progress: number } | null;
  plan?: { path: [number, number][]; search: [number, number][] };
}
