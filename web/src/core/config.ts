/**
 * ASTRAQ simulation configuration: one typed object, defaults taken from the
 * SIH26169 / PS169 parameter table where the problem statement fixes a value.
 *
 * The Python engine (server/astraq_engine/config.py) mirrors these field names so a
 * config JSON can be sent to either engine unchanged.
 */

export type TrajectoryKind =
  | 'stationary'
  | 'linear'
  | 'circular'
  | 'sinusoidal'
  | 'figure8'
  | 'spiral'
  | 'random'
  | 'custom'
  | 'orbital';

export type SpotShape = 'square' | 'disk' | 'gaussian';
export type AtmosphereMode = 'clear' | 'haze' | 'fog' | 'rain' | 'low_light';
export type PlatformMotionKind = 'none' | 'linear' | 'circular' | 'random';
export type DetectorKind = 'centroid' | 'synthetic';
export type RemoteKind = 'leo' | 'haps' | 'uav';

export interface TargetConfig {
  trajectory: TrajectoryKind;
  /** Angular speed for linear / random / custom motion, deg/s. */
  speedDegS: number;
  /** Pattern half-amplitude, deg (circular, sinusoidal, figure-8, spiral). */
  amplitudeDeg: number;
  /** Pattern period, s. */
  periodS: number;
  /** Heading of linear motion / orientation of patterns, deg (0 = +u, right). */
  headingDeg: number;
  /** Start position inside the search field. PS default: random. */
  startMode: 'random' | 'fixed';
  startUDeg: number;
  startVDeg: number;
  /** Custom trajectory waypoints in field coordinates, deg. */
  waypoints: [number, number][];
  /** Beacon spot size on the sensor at the nominal (narrow) FOV, px. PS: 5–20, default 10. */
  spotSizePx: number;
  spotShape: SpotShape;
  /** Peak beacon grey level before atmosphere, 0–255. */
  beaconIntensity: number;
  /** Line-of-sight range for non-orbital scenarios, km. */
  rangeKm: number;
}

export interface CameraConfig {
  width: number; // px
  height: number; // px
  /** Horizontal FOV at tracking zoom, deg. PS default 4° (→ 3° vertical at 640×480). */
  hfovDeg: number;
  /** Wide-field acquisition: search with a wider FOV, zoom in once detected. */
  wideAcquisition: boolean;
  wideHfovDeg: number;
  zoomRateDegS: number;
  frameRateHz: number; // PS ≥ 30 Hz
  pixelPitchUm: number; // used only to express focal length in mm
}

export interface GimbalConfig {
  maxRateDegS: number; // PS 5–10 °/s, default 5
  maxAccelDegS2: number;
  /** First-order rate-loop time constant, s. */
  rateLagS: number;
  panMinDeg: number;
  panMaxDeg: number;
  tiltMinDeg: number;
  tiltMaxDeg: number;
}

export interface ControlConfig {
  kp: number; // (deg/s) per deg
  ki: number;
  kd: number;
  integralLimit: number; // deg·s
  /** Integrate only when |error| is below this, deg. */
  integralZone: number;
  derivativeFilterS: number;
  feedForward: boolean;
  controlRateHz: number; // PS ≥ 20 Hz
}

export interface KalmanConfig {
  enabled: boolean;
  /** Process noise: white-acceleration spectral density, (deg/s²)²/Hz. */
  processNoise: number;
  /** Measurement noise, px (1σ). */
  measurementNoisePx: number;
  /** Innovation gate (Mahalanobis², 2 dof). */
  gate: number;
}

export interface DetectionConfig {
  provider: DetectorKind;
  thresholdSigma: number;
  minConfidence: number;
  /** Association gate radius around the predicted position while tracking, px. */
  gateRadiusPx: number;
  /** Extra detection latency in frames (simulates processing / transport delay). */
  latencyFrames: number;
  /** Synthetic provider: centroid noise σ, px. */
  syntheticNoisePx: number;
  /** Synthetic provider: base miss probability. */
  syntheticMissProb: number;
  /** Rescore image-detector candidates with the learned beacon verifier (MLP). */
  verifier: boolean;
}

export interface DisturbanceConfig {
  /** Platform vibration amplitude, px (converted to angle via IFOV). */
  vibrationPx: number;
  vibrationHz: number;
  /** Random per-frame camera jitter, ± px. PS max ±20 px/frame. */
  jitterPx: number;
  /** Slow platform motion (attitude drift), PS item 25. */
  platformMotion: PlatformMotionKind;
  platformMotionPx: number;
  /** Wind-like torque disturbance on the gimbal axes, deg/s (1σ, low-pass). */
  windDegS: number;
  /** Random perturbation of the target path, deg (1σ, low-pass). */
  targetNoiseDeg: number;
  gaussianNoise: number; // grey levels σ, PS max 20
  saltPepper: number; // fraction 0–0.1
  poisson: boolean;
  atmosphere: AtmosphereMode;
  atmosphereStrength: number; // 0–1
  turbulence: number; // 0–1: scintillation + angle-of-arrival wander
  /** Probability a frame's beacon is blocked (occlusion / dropout). */
  dropoutProb: number;
  /** Scheduled full outages (cloud, obstruction): every period s the beacon is hidden for durS s. 0 = off. */
  occlusionPeriodS: number;
  occlusionDurS: number;
  /** Adds a dimmer, differently sized decoy spot (sun glint / other object). */
  decoy: boolean;
}

export interface SceneConfig {
  siteName: string;
  siteLatDeg: number;
  siteLonDeg: number;
  /** Nominal line of sight (predicted direction of the remote terminal). */
  losAzDeg: number;
  losElDeg: number;
  sunAzDeg: number;
  sunElDeg: number;
  remote: RemoteKind;
  altitudeKm: number;
  /** Orbital scenario: along-track ephemeris timing error, s. */
  ephemerisErrorS: number;
  /** Orbital scenario: maximum pass elevation, deg. */
  passMaxElDeg: number;
  passHeadingDeg: number;
}

export interface LinkConfig {
  txPowerMw: number;
  divergenceUrad: number; // full angle, 1/e²
  rxApertureCm: number;
  wavelengthNm: number;
  systemLossDb: number;
  rxSensitivityDbm: number;
  /** Fine-pointing stage capture half-field, mrad (hand-over criterion). */
  fineCaptureMrad: number;
}

export interface TrackLogicConfig {
  /** Lock threshold on measured pixel error, px. PS tracking error ≤ 10 px. */
  lockPx: number;
  unlockPx: number;
  lockFrames: number;
  /** Pixel error below which ACQUIRING becomes TRACKING. */
  acquirePx: number;
  confirmM: number;
  confirmN: number;
  /** Consecutive misses tolerated (coasting on prediction) before LOST. */
  coastFrames: number;
  lostHoldS: number;
  reacquireTimeoutS: number;
  /** Half-extent of the search field around the nominal LOS, deg. 2000 px × 0.00625 °/px / 2. */
  searchHalfUDeg: number;
  searchHalfVDeg: number;
}

export interface SimConfig {
  scenarioId: string;
  seed: number;
  target: TargetConfig;
  camera: CameraConfig;
  gimbal: GimbalConfig;
  control: ControlConfig;
  kalman: KalmanConfig;
  detection: DetectionConfig;
  disturbance: DisturbanceConfig;
  scene: SceneConfig;
  link: LinkConfig;
  logic: TrackLogicConfig;
}

export const DEFAULT_CONFIG: SimConfig = {
  scenarioId: 'open-sky',
  seed: 26169,
  target: {
    trajectory: 'circular',
    speedDegS: 0.6,
    amplitudeDeg: 1.6,
    periodS: 16,
    headingDeg: 30,
    startMode: 'random',
    startUDeg: 2.5,
    startVDeg: 1.5,
    waypoints: [
      [-2, -1],
      [1.5, -2],
      [2.5, 1.5],
      [-1, 2.2],
    ],
    spotSizePx: 10,
    spotShape: 'square',
    beaconIntensity: 230,
    rangeKm: 780,
  },
  camera: {
    width: 640,
    height: 480,
    hfovDeg: 4,
    wideAcquisition: true,
    wideHfovDeg: 12,
    zoomRateDegS: 10,
    frameRateHz: 30,
    pixelPitchUm: 5,
  },
  gimbal: {
    maxRateDegS: 5,
    maxAccelDegS2: 30,
    rateLagS: 0.04,
    panMinDeg: -180,
    panMaxDeg: 180,
    tiltMinDeg: -5,
    tiltMaxDeg: 88,
  },
  control: {
    kp: 8.0,
    ki: 1.0,
    kd: 0.05,
    integralLimit: 0.05,
    integralZone: 0.1,
    derivativeFilterS: 0.05,
    feedForward: true,
    controlRateHz: 60,
  },
  kalman: { enabled: true, processNoise: 2, measurementNoisePx: 1.5, gate: 25 },
  detection: {
    provider: 'centroid',
    thresholdSigma: 5,
    minConfidence: 0.35,
    gateRadiusPx: 60,
    latencyFrames: 0,
    syntheticNoisePx: 0.8,
    syntheticMissProb: 0.01,
    verifier: true,
  },
  disturbance: {
    vibrationPx: 1.5,
    vibrationHz: 6,
    jitterPx: 1,
    platformMotion: 'none',
    platformMotionPx: 0,
    windDegS: 0.05,
    targetNoiseDeg: 0.01,
    gaussianNoise: 6,
    saltPepper: 0.002,
    poisson: true,
    atmosphere: 'clear',
    atmosphereStrength: 0.3,
    turbulence: 0.2,
    dropoutProb: 0,
    occlusionPeriodS: 0,
    occlusionDurS: 1,
    decoy: false,
  },
  scene: {
    siteName: 'Bengaluru ground terminal',
    siteLatDeg: 13.03,
    siteLonDeg: 77.51,
    losAzDeg: 205,
    losElDeg: 42,
    sunAzDeg: 290,
    sunElDeg: -6,
    remote: 'leo',
    altitudeKm: 550,
    ephemerisErrorS: 2.5,
    passMaxElDeg: 62,
    passHeadingDeg: 160,
  },
  link: {
    txPowerMw: 500,
    divergenceUrad: 150,
    rxApertureCm: 20,
    wavelengthNm: 1550,
    systemLossDb: 3,
    rxSensitivityDbm: -45,
    fineCaptureMrad: 1.0,
  },
  logic: {
    lockPx: 10,
    unlockPx: 15,
    lockFrames: 6,
    acquirePx: 30,
    confirmM: 2,
    confirmN: 3,
    coastFrames: 5,
    lostHoldS: 0.25,
    reacquireTimeoutS: 3,
    searchHalfUDeg: 6.25,
    searchHalfVDeg: 6.25,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/** Deep-merge a partial patch into a config (arrays are replaced, not merged). */
export function mergeConfig<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = mergeConfig(b, v as DeepPartial<typeof b>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export const cloneConfig = (c: SimConfig): SimConfig => JSON.parse(JSON.stringify(c));

/** Derived optical quantities for a given horizontal FOV. */
export function intrinsics(cam: CameraConfig, hfovDeg = cam.hfovDeg) {
  const fx = cam.width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  const fy = fx; // square pixels
  const vfovDeg = (2 * Math.atan(cam.height / 2 / fy) * 180) / Math.PI;
  const ifovDeg = hfovDeg / cam.width; // small-angle, deg per px at centre
  return {
    fx,
    fy,
    cx: cam.width / 2,
    cy: cam.height / 2,
    hfovDeg,
    vfovDeg,
    ifovDeg,
    focalMm: (fx * cam.pixelPitchUm) / 1000,
  };
}

/** Clamp user-supplied values into safe ranges (shared by UI and remote engine). */
export function sanitizeConfig(c: SimConfig): SimConfig {
  const s = cloneConfig(c);
  const lim = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  s.camera.width = Math.round(lim(s.camera.width, 160, 1280, 640));
  s.camera.height = Math.round(lim(s.camera.height, 120, 960, 480));
  s.camera.hfovDeg = lim(s.camera.hfovDeg, 0.5, 30, 4);
  s.camera.wideHfovDeg = lim(s.camera.wideHfovDeg, s.camera.hfovDeg, 40, 12);
  s.camera.frameRateHz = lim(s.camera.frameRateHz, 10, 60, 30);
  s.target.spotSizePx = lim(s.target.spotSizePx, 2, 40, 10);
  s.target.amplitudeDeg = lim(s.target.amplitudeDeg, 0, 6, 1.6);
  s.target.periodS = lim(s.target.periodS, 2, 120, 16);
  s.target.speedDegS = lim(s.target.speedDegS, 0, 5, 0.6);
  s.gimbal.maxRateDegS = lim(s.gimbal.maxRateDegS, 0.5, 30, 5);
  s.disturbance.gaussianNoise = lim(s.disturbance.gaussianNoise, 0, 40, 6);
  s.disturbance.saltPepper = lim(s.disturbance.saltPepper, 0, 0.2, 0);
  s.disturbance.jitterPx = lim(s.disturbance.jitterPx, 0, 30, 0);
  s.disturbance.vibrationPx = lim(s.disturbance.vibrationPx, 0, 30, 0);
  s.disturbance.atmosphereStrength = lim(s.disturbance.atmosphereStrength, 0, 1, 0.3);
  s.disturbance.turbulence = lim(s.disturbance.turbulence, 0, 1, 0);
  s.disturbance.dropoutProb = lim(s.disturbance.dropoutProb, 0, 0.95, 0);
  s.disturbance.occlusionPeriodS = lim(s.disturbance.occlusionPeriodS ?? 0, 0, 120, 0);
  s.disturbance.occlusionDurS = lim(s.disturbance.occlusionDurS ?? 1, 0.1, 10, 1);
  s.detection.latencyFrames = Math.round(lim(s.detection.latencyFrames, 0, 10, 0));
  s.control.controlRateHz = lim(s.control.controlRateHz, 10, 240, 60);
  return s;
}
