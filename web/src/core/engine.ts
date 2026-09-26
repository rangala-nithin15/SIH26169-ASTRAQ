/**
 * ASTRAQ simulation engine — one closed-loop coarse-pointing system.
 *
 * Per camera frame (default 30 Hz):
 *   1. control   the gimbal servo loop runs at controlRateHz (default 60 Hz) over the
 *                frame interval, driven by the latest estimate (Kalman prediction)
 *   2. world     target motion, platform disturbance, turbulence, atmosphere
 *   3. capture   the sensor frame is rendered from the *actual* optical axis
 *                (encoders + platform disturbance the encoders cannot see)
 *   4. detect    the selected DetectionProvider finds the beacon (optionally delayed)
 *   5. estimate  pixel → direction with the capture-time encoder pose → Kalman update
 *   6. decide    the supervisor state machine updates the acquisition state
 *   7. measure   metrics against ground truth (truth is used ONLY here and by the
 *                synthetic detector model)
 *
 * The engine is pure TypeScript with no DOM or three.js dependency: it runs in a Web
 * Worker in the browser, in Node for tests, and is mirrored by the Python engine.
 */
import { DeepPartial, SimConfig, DEFAULT_CONFIG, cloneConfig, intrinsics, mergeConfig, sanitizeConfig } from './config';
import { Basis, azElFromDir, basisFromAzEl, dirFromAzEl, dirFromField, fieldFromDir } from './geometry';
import { Rng, Vec3, angleBetweenDeg, clamp, wrapDeg } from './math';
import { TargetModel, TargetTruth } from './target/trajectory';
import { DisturbanceModel, DisturbanceState } from './disturbance/disturbance';
import { PinholeCamera } from './optics/camera';
import { SensorFrame, SensorRenderer } from './optics/sensor';
import { StarCatalog, makeStarCatalog } from './optics/stars';
import { createDetector } from './detection/registry';
import { DetectionProvider, DetectionResult } from './detection/types';
import { SyntheticDetector } from './detection/synthetic';
import { AngularKalman } from './estimation/kalman';
import { PidAxis } from './control/pid';
import { Gimbal } from './control/gimbal';
import { SpiralSearch } from './control/search';
import { Supervisor } from './tracking/supervisor';
import { RunMetrics } from './analysis/metrics';
import { linkEstimate } from './analysis/link';
import { DEMO_DURATION, DEMO_PHASES, demoPhaseAt } from './demo/script';
import { Snapshot, TrackState, TransitionEvent } from './telemetry/types';

interface Capture {
  t: number;
  pan: number;
  tilt: number;
  hfov: number;
  result: DetectionResult;
  truthPx: [number, number] | null;
  spotPx: [number, number] | null;
}

/** Time spent following the prediction before the re-acquisition spiral starts, s. */
const REACQ_DWELL_S = 1.0;

const RESET_KEYS: (keyof SimConfig)[] = ['seed', 'scene'];

export class SimulationEngine {
  cfg: SimConfig;
  readonly stars: StarCatalog;
  private rng!: Rng;
  private target!: TargetModel;
  private dist!: DisturbanceModel;
  private renderer!: SensorRenderer;
  private detector!: DetectionProvider;
  private kf = new AngularKalman();
  private pidPan = new PidAxis();
  private pidTilt = new PidAxis();
  private gimbal!: Gimbal;
  private sup!: Supervisor;
  private metrics = new RunMetrics();
  private search!: SpiralSearch;
  private reacq: SpiralSearch | null = null;
  private reacqCenter: Basis | null = null;
  private reacqT0 = 0;
  private queue: Capture[] = [];
  private encCam!: PinholeCamera;
  private actCam!: PinholeCamera;

  t = 0;
  frame = 0;
  running = false;
  mode: 'auto' | 'manual' = 'auto';
  manualGoal: [number, number] = [0, 0];
  private hfov = 4;
  private truth!: TargetTruth;
  private distState!: DisturbanceState;
  private lastFrame: SensorFrame | null = null;
  private lastMeasDir: Vec3 | null = null;
  private lastDetDir: Vec3 | null = null;
  private events: TransitionEvent[] = [];
  private timeline: Snapshot['timeline'] = { search: null, detect: null, acquire: null, track: null, lock: null };
  private demoActive = false;
  private demoPhase = -1;
  private demoT0 = 0;
  private searchGoal: [number, number] | null = null;
  configVersion = 0;
  private ff: [number, number] = [0, 0];
  /** Renders frames even when the detector does not need them (for display). */
  renderAlways = true;
  source = 'local';

  constructor(cfg: SimConfig = DEFAULT_CONFIG, stars?: StarCatalog) {
    this.cfg = sanitizeConfig(cfg);
    this.stars = stars ?? makeStarCatalog();
    this.build();
  }

  private build() {
    const c = this.cfg;
    this.rng = new Rng(c.seed);
    this.target = new TargetModel(c, c.seed);
    this.dist = new DisturbanceModel(c.seed);
    this.renderer = new SensorRenderer(c.camera.width, c.camera.height, c.seed);
    this.detector = createDetector(c.detection);
    this.gimbal = new Gimbal(c.gimbal);
    this.sup = new Supervisor(c.logic);
    this.encCam = new PinholeCamera(c.camera);
    this.actCam = new PinholeCamera(c.camera);
    this.reset();
  }

  /** Back to t = 0: camera at the centre of the field (PS item 6), new random target start. */
  reset() {
    const c = this.cfg;
    this.t = 0;
    this.frame = 0;
    this.target.reset();
    this.dist.reset();
    this.kf.reset();
    this.pidPan.reset();
    this.pidTilt.reset();
    this.sup.reset();
    this.metrics.reset(0);
    this.queue = [];
    this.events = [];
    this.lastMeasDir = null;
    this.lastDetDir = null;
    this.reacq = null;
    this.timeline = { search: null, detect: null, acquire: null, track: null, lock: null };
    this.hfov = c.camera.wideAcquisition ? c.camera.wideHfovDeg : c.camera.hfovDeg;
    // Prime the world state at t = 0.
    this.truth = this.target.step(0, 0);
    const ref = azElFromDir(this.truth.ref.f);
    this.gimbal.reset(ref.az, ref.el);
    this.manualGoal = [this.gimbal.pan, this.gimbal.tilt];
    this.distState = this.dist.step(0, c.disturbance, intrinsics(c.camera).ifovDeg);
    this.buildSearch();
    if (this.running) this.startTracking();
  }

  private buildSearch() {
    const k = intrinsics(this.cfg.camera, this.hfov);
    this.search = new SpiralSearch(
      this.cfg.logic.searchHalfUDeg,
      this.cfg.logic.searchHalfVDeg,
      k.hfovDeg * 0.85,
      k.vfovDeg * 0.85,
    );
  }

  private startTracking() {
    if (this.sup.state === 'IDLE') {
      this.pushEvent(this.sup.force(this.t, 'SEARCHING', 'run started — scanning the search field'));
      this.timeline.search = this.t;
    }
  }

  start() {
    this.running = true;
    this.startTracking();
  }

  pause() {
    this.running = false;
  }

  setMode(mode: 'auto' | 'manual') {
    this.mode = mode;
    this.manualGoal = [this.gimbal.pan, this.gimbal.tilt];
    this.pushInfo(mode === 'manual' ? 'manual pointing — automatic tracking suspended' : 'automatic tracking resumed');
  }

  setManualGoal(pan: number, tilt: number) {
    this.manualGoal = [wrapDeg(pan), clamp(tilt, this.cfg.gimbal.tiltMinDeg, this.cfg.gimbal.tiltMaxDeg)];
  }

  /** Force a fresh acquisition (operator "reacquire"). */
  reacquire() {
    this.kf.reset();
    this.sup.reset();
    this.hfov = this.cfg.camera.wideAcquisition ? this.cfg.camera.wideHfovDeg : this.cfg.camera.hfovDeg;
    this.buildSearch();
    this.pushEvent(this.sup.force(this.t, 'SEARCHING', 'operator requested reacquisition'));
  }

  /** Apply a partial configuration. Scene/seed changes restart the run. */
  applyConfig(patch: DeepPartial<SimConfig>, silent = false) {
    const next = sanitizeConfig(mergeConfig(this.cfg, patch));
    const needsReset = RESET_KEYS.some((k) => k in patch) ||
      next.camera.width !== this.cfg.camera.width || next.camera.height !== this.cfg.camera.height;
    const detectorChanged = next.detection.provider !== this.cfg.detection.provider;
    this.cfg = next;
    this.configVersion++;
    this.gimbal.cfg = next.gimbal;
    this.sup.cfg = next.logic;
    this.encCam.cfg = next.camera;
    this.actCam.cfg = next.camera;
    if (detectorChanged) this.detector = createDetector(next.detection);
    else if (this.detector instanceof SyntheticDetector) this.detector.configure(next.detection.syntheticNoisePx, next.detection.syntheticMissProb);
    if (needsReset) {
      this.renderer.resize(next.camera.width, next.camera.height);
      this.target = new TargetModel(next, next.seed);
      this.dist = new DisturbanceModel(next.seed);
      this.reset();
      if (!silent) this.pushInfo('configuration applied — run restarted');
    } else {
      if ('target' in patch) this.target.setConfig(next);
      if ('logic' in patch || 'camera' in patch) this.buildSearch();
      if (!silent) this.pushInfo('configuration applied');
    }
  }

  setDemo(on: boolean) {
    if (on) {
      this.cfg = sanitizeConfig(mergeConfig(cloneConfig(DEFAULT_CONFIG), { seed: this.cfg.seed }));
      this.demoActive = true;
      this.configVersion++;
      this.demoPhase = -1;
      this.running = true;
      this.mode = 'auto';
      this.build();
      this.demoT0 = this.t;
      this.startTracking();
      this.pushInfo('demo started');
    } else {
      this.demoActive = false;
      this.pushInfo('demo ended');
    }
  }

  get demoRunning() {
    return this.demoActive;
  }

  private pushEvent(ev: TransitionEvent | null) {
    if (!ev) return;
    this.events.push(ev);
  }

  private pushInfo(message: string, kind: 'info' | 'warn' = 'info') {
    this.events.push({ t: this.t, kind, message });
  }

  /** Current Kalman / measurement-based estimate of the target direction at time t. */
  private estimateDir(t: number): { dir: Vec3; azRate: number; elRate: number } | null {
    if (this.cfg.kalman.enabled) {
      if (!this.kf.initialized) return null;
      const e = this.kf.estimateAt(t);
      return { dir: dirFromAzEl(e.az, e.el), azRate: e.azRate, elRate: e.elRate };
    }
    return this.lastMeasDir ? { dir: this.lastMeasDir, azRate: 0, elRate: 0 } : null;
  }

  private controlLaw(tS: number, dt: number): [number, number] {
    const g = this.gimbal;
    if (this.mode === 'manual') return g.rateToward(this.manualGoal[0], this.manualGoal[1]);
    const st = this.sup.state;
    this.ff = [0, 0];
    this.searchGoal = null;
    if (st === 'IDLE') return [0, 0];

    if (st === 'SEARCHING' || (st === 'DETECTED' && !this.lastDetDir)) {
      const ref = this.truth.ref; // predicted line of sight (ephemeris) — not truth
      const bf = fieldFromDir(ref, dirFromAzEl(g.pan, g.tilt)) ?? { u: 0, v: 0 };
      const k = intrinsics(this.cfg.camera, this.hfov);
      const goal = this.search.update(bf.u, bf.v, Math.min(0.3, k.hfovDeg * 0.08), Math.min(0.3, k.vfovDeg * 0.08));
      this.searchGoal = goal;
      const d = azElFromDir(dirFromField(ref, goal[0], goal[1]));
      return g.rateToward(d.az, d.el);
    }
    if (st === 'DETECTED' && this.lastDetDir) {
      const d = azElFromDir(this.lastDetDir);
      return g.rateToward(d.az, d.el);
    }
    // Re-acquisition: first keep following the prediction (the wide FOV opens around it),
    // then spiral around the moving prediction if the beacon has not reappeared.
    const dwelling = st === 'REACQUIRING' && tS - this.reacqT0 < REACQ_DWELL_S;
    if (st === 'REACQUIRING' && !dwelling && this.reacq && this.reacqCenter) {
      const center = this.reacqCenterAt(tS) ?? this.reacqCenter;
      const bf = fieldFromDir(center, dirFromAzEl(g.pan, g.tilt)) ?? { u: 0, v: 0 };
      const k = intrinsics(this.cfg.camera, this.hfov);
      const goal = this.reacq.update(bf.u, bf.v, Math.min(0.3, k.hfovDeg * 0.08), Math.min(0.3, k.vfovDeg * 0.08));
      const d = azElFromDir(dirFromField(center, goal[0], goal[1]));
      const gf = fieldFromDir(this.truth.ref, dirFromField(center, goal[0], goal[1]));
      this.searchGoal = gf ? [gf.u, gf.v] : null;
      return g.rateToward(d.az, d.el);
    }
    // ACQUIRING / TRACKING / LOCKED / LOST: closed loop on the estimate, evaluated one
    // servo time-constant ahead (lead compensation for the gimbal's rate-loop lag).
    const est = this.estimateDir(tS);
    if (!est) return [0, 0];
    this.encCam.setPose(g.pan, g.tilt);
    const e = this.encCam.angularError(est.dir);
    if (!e) return [0, 0];
    const gains = this.cfg.control;
    const lim = this.cfg.gimbal.maxRateDegS;
    const cosT = Math.max(0.2, Math.cos((g.tilt * Math.PI) / 180));
    const ffPan = gains.feedForward ? est.azRate : 0;
    const ffTilt = gains.feedForward ? est.elRate : 0;
    this.ff = [ffPan, ffTilt];
    const panCmd = this.pidPan.update(e.ex / cosT, dt, gains, lim, ffPan);
    const tiltCmd = this.pidTilt.update(e.ey, dt, gains, lim, ffTilt);
    return [panCmd, tiltCmd];
  }

  private reacqCenterAt(t: number): Basis | null {
    const est = this.estimateDir(t);
    if (!est) return null;
    const ae = azElFromDir(est.dir);
    return basisFromAzEl(ae.az, ae.el);
  }

  /** Advance one camera frame and return the telemetry snapshot. */
  step(): Snapshot {
    const c = this.cfg;
    const fps = c.camera.frameRateHz;
    const dtF = 1 / fps;
    const nSub = Math.max(1, Math.round(c.control.controlRateHz / fps));
    const dtS = dtF / nSub;
    const tPrev = this.t;

    // 1. Servo loop over the frame interval.
    for (let s = 0; s < nSub; s++) {
      const tS = tPrev + (s + 1) * dtS;
      const [cp, ct] = this.running ? this.controlLaw(tS, dtS) : [0, 0];
      this.gimbal.step(dtS, cp, ct, this.running ? this.distState.windPan : 0, this.running ? this.distState.windTilt : 0);
    }
    this.t = tPrev + dtF;
    this.frame++;

    // Demo script.
    if (this.demoActive) {
      const td = this.t - this.demoT0;
      const idx = demoPhaseAt(td);
      if (idx !== this.demoPhase) {
        this.demoPhase = idx;
        const ph = DEMO_PHASES[idx];
        this.applyConfig(ph.patch, true);
        this.pushInfo(`demo phase ${idx + 1}/${DEMO_PHASES.length}: ${ph.title}`);
      }
      if (td >= DEMO_DURATION) {
        this.demoActive = false;
        this.pushInfo('demo complete — simulation continues');
      }
    }

    // 2. World.
    const ifovNom = intrinsics(c.camera).ifovDeg;
    this.truth = this.target.step(dtF, c.disturbance.targetNoiseDeg);
    this.distState = this.dist.step(dtF, c.disturbance, ifovNom);
    const ds = this.distState;

    // Zoom: wide while searching, narrow once a target is being acquired.
    const st0 = this.sup.state;
    let wantWide = c.camera.wideAcquisition && (st0 === 'SEARCHING' || st0 === 'DETECTED' || st0 === 'REACQUIRING' || st0 === 'IDLE');
    if (c.camera.wideAcquisition && st0 === 'ACQUIRING') {
      // Stay wide until the estimate is well inside the narrow field, then zoom in.
      const e0 = this.estimateDir(this.t);
      if (e0) {
        const narrowHalfV = intrinsics(c.camera).vfovDeg / 2;
        wantWide = angleBetweenDeg(dirFromAzEl(this.gimbal.pan, this.gimbal.tilt), e0.dir) > 0.5 * narrowHalfV;
      }
    }
    const goalFov = wantWide ? c.camera.wideHfovDeg : c.camera.hfovDeg;
    const prevFov = this.hfov;
    this.hfov += clamp(goalFov - this.hfov, -c.camera.zoomRateDegS * dtF, c.camera.zoomRateDegS * dtF);
    if (Math.abs(this.hfov - prevFov) > 1e-9 && this.hfov === goalFov && (st0 === 'SEARCHING' || st0 === 'IDLE')) this.buildSearch();

    // 3. Capture from the actual optical axis.
    const g = this.gimbal;
    this.actCam.setFov(this.hfov);
    this.actCam.setPose(g.pan + ds.dPan, g.tilt + ds.dTilt);
    this.encCam.setFov(this.hfov);
    this.encCam.setPose(g.pan, g.tilt);
    const decoyDir = c.disturbance.decoy
      ? dirFromField(this.truth.ref, this.truth.u + 1.1 * Math.sin(this.t * 0.37) + 0.6, this.truth.v + 0.9 * Math.cos(this.t * 0.29) - 0.4)
      : null;
    const needImage = this.detector.needsImage || this.renderAlways;
    let frame: SensorFrame | null = null;
    if (needImage) {
      frame = this.renderer.render({
        cam: this.actCam,
        cfg: c,
        beaconDir: this.truth.dir,
        decoyDir,
        dist: ds,
        stars: this.stars,
        nominalHfovDeg: c.camera.hfovDeg,
      });
      this.lastFrame = frame;
    }
    const truthPx = this.actCam.project(this.truth.dir);
    const spotVisible = frame ? frame.spotVisible : !!truthPx && this.actCam.inFrame(truthPx) && !ds.dropout;

    // 4. Detection (with the tracker's prediction as context).
    const hasTrack = this.sup.hasTrack && (this.kf.initialized || !c.kalman.enabled);
    const est = this.estimateDir(this.t);
    const predPx = hasTrack && est ? this.encCam.project(est.dir) : null;
    const kEst = this.cfg.kalman.enabled && this.kf.initialized ? this.kf.estimateAt(this.t) : null;
    const sigmaPx = kEst ? Math.max(kEst.sigmaAz, kEst.sigmaEl) / this.encCam.k.ifovDeg : 0;
    const lostTime = this.sup.lostAt !== null ? this.t - this.sup.lostAt : 0;
    const gate = c.detection.gateRadiusPx + Math.min(200, 3 * sigmaPx) + (this.sup.state === 'REACQUIRING' ? 80 * lostTime : 0);
    const sizeScale = c.camera.hfovDeg / this.hfov;
    const result = this.detector.detect(frame, {
      frameIndex: this.frame,
      t: this.t,
      predicted: predPx,
      tracking: hasTrack && !!predPx,
      gatePx: gate,
      expectedSizePx: c.target.spotSizePx * sizeScale,
      thresholdSigma: c.detection.thresholdSigma,
      minConfidence: c.detection.minConfidence,
      verifier: c.detection.verifier,
      rng: this.rng,
      truth: {
        px: frame?.spotPx ?? truthPx,
        visible: spotVisible,
        transmission: ds.atm.transmission * ds.atm.gain,
        noiseSigma: c.disturbance.gaussianNoise,
      },
    });
    this.queue.push({ t: this.t, pan: g.pan, tilt: g.tilt, hfov: this.hfov, result, truthPx, spotPx: frame?.spotPx ?? truthPx });
    const cap = this.queue.length > c.detection.latencyFrames ? this.queue.shift()! : null;

    // 5. Measurement → direction → Kalman.
    let accepted = false;
    let measErrPx: number | null = null;
    const det = cap?.result.detection ?? null;
    let measDir: Vec3 | null = null;
    if (cap && det) {
      const capCam = new PinholeCamera(c.camera, cap.pan, cap.tilt, cap.hfov);
      measDir = capCam.unproject(det.x, det.y);
      measErrPx = Math.hypot(det.x - capCam.k.cx, det.y - capCam.k.cy);
    }
    const q = c.kalman.processNoise;
    if (this.kf.initialized && cap) this.kf.predictTo(cap.t, q, azElFromDir(measDir ?? est?.dir ?? this.truth.ref.f).el);
    if (measDir && cap) {
      const m = azElFromDir(measDir);
      const rDeg = c.kalman.measurementNoisePx * intrinsics(c.camera, cap.hfov).ifovDeg;
      if (this.sup.state === 'SEARCHING') {
        accepted = true;
      } else if (this.sup.state === 'DETECTED') {
        // Confirmation requires spatial consistency with the first detection.
        const tol = Math.max(0.15, 3 * c.target.spotSizePx * intrinsics(c.camera).ifovDeg + c.target.speedDegS * 0.2);
        accepted = !this.lastDetDir || angleBetweenDeg(this.lastDetDir, measDir) < tol;
      } else if (c.kalman.enabled) {
        if (!this.kf.initialized) {
          this.kf.init(m.az, m.el, cap.t, Math.max(rDeg, 0.01));
          accepted = true;
        } else {
          accepted = this.kf.update(m.az, m.el, rDeg, c.kalman.gate);
          if (!accepted && (this.sup.state === 'LOST' || this.sup.state === 'REACQUIRING')) {
            // The detector already gated spatially; a stale prediction must not block reacquisition.
            this.kf.init(m.az, m.el, cap.t, Math.max(rDeg, 0.01) * 2, true);
            accepted = true;
          }
        }
      } else {
        accepted = true;
      }
      if (accepted) {
        this.lastDetDir = measDir;
        if (this.sup.hasTrack || this.sup.state === 'DETECTED') this.lastMeasDir = measDir;
      }
    }

    // 6. Supervisor.
    if (this.running && this.mode === 'auto') {
      const prev = this.sup.state;
      let filtErrPx: number | null = null;
      if (accepted && c.kalman.enabled && this.kf.initialized && cap) {
        const e = this.kf.estimateAt(cap.t);
        const capCam = new PinholeCamera(c.camera, cap.pan, cap.tilt, cap.hfov);
        const p = capCam.project(dirFromAzEl(e.az, e.el));
        if (p) filtErrPx = Math.hypot(p[0] - capCam.k.cx, p[1] - capCam.k.cy);
      }
      const ev = this.sup.step({ t: this.t, detected: accepted, measErrPx: accepted ? measErrPx : null, filtErrPx, confidence: det?.confidence ?? 0 });
      if (ev) {
        this.pushEvent(ev);
        this.onTransition(prev, this.sup.state, measDir, cap?.t ?? this.t);
      }
    }

    // 7. Truth metrics.
    const pointErrVec: [number, number] | null = truthPx ? [truthPx[0] - this.actCam.k.cx, truthPx[1] - this.actCam.k.cy] : null;
    const axisDir = this.actCam.basis.f;
    const angErr = angleBetweenDeg(axisDir, this.truth.dir);
    const pointErrPx = angErr / this.actCam.k.ifovDeg;
    // Centroid error only for detections that are associated with the true spot;
    // anything farther than 3 spot sizes is counted as a false detection instead.
    let centroidErr = det && cap?.spotPx ? Math.hypot(det.x - cap.spotPx[0], det.y - cap.spotPx[1]) : null;
    const falseDet = !!det && accepted && (centroidErr === null || centroidErr > Math.max(15, 3 * c.target.spotSizePx * sizeScale));
    if (falseDet) centroidErr = null;
    this.metrics.update({
      t: this.t,
      state: this.sup.state,
      pointErrPx: pointErrPx,
      centroidErrPx: accepted ? centroidErr : null,
      falseDetection: falseDet,
      confidence: det?.confidence ?? 0,
      procMs: result.procMs,
      beaconVisible: !ds.occluded,
    });
    this.updateTimeline();
    return this.snapshot(result, cap, accepted, measErrPx, pointErrVec, pointErrPx, angErr, predPx, decoyDir);
  }

  private onTransition(from: TrackState, to: TrackState, measDir: Vec3 | null, tCap: number) {
    const c = this.cfg;
    if (to === 'ACQUIRING') {
      this.pidPan.reset();
      this.pidTilt.reset();
      if (c.kalman.enabled && measDir && !this.kf.initialized) {
        const m = azElFromDir(measDir);
        this.kf.init(m.az, m.el, tCap, c.kalman.measurementNoisePx * intrinsics(c.camera, this.hfov).ifovDeg * 2);
      }
    }
    if (to === 'SEARCHING') {
      this.kf.reset();
      this.lastMeasDir = null;
      this.lastDetDir = null;
      this.reacq = null;
      this.buildSearch();
    }
    if (to === 'REACQUIRING') {
      this.reacqT0 = this.t;
      const center = this.reacqCenterAt(this.t);
      this.reacqCenter = center ?? basisFromAzEl(this.gimbal.pan, this.gimbal.tilt);
      const k = intrinsics(c.camera, c.camera.wideAcquisition ? c.camera.wideHfovDeg : c.camera.hfovDeg);
      this.reacq = new SpiralSearch(k.hfovDeg * 1.5, k.vfovDeg * 1.5, k.hfovDeg * 0.8, k.vfovDeg * 0.8, 2);
    }
    if (to === 'TRACKING' && from === 'ACQUIRING') {
      this.pidPan.integral = 0;
      this.pidTilt.integral = 0;
    }
    if (to === 'TRACKING' && (from === 'LOST' || from === 'REACQUIRING')) {
      this.reacq = null;
      this.pidPan.reset();
      this.pidTilt.reset();
    }
  }

  private updateTimeline() {
    const s = this.sup.state;
    const tl = this.timeline;
    if (s === 'DETECTED' && tl.detect === null) tl.detect = this.t;
    if (s === 'ACQUIRING' && tl.acquire === null) tl.acquire = this.t;
    if (s === 'TRACKING' && tl.track === null) tl.track = this.t;
    if (s === 'LOCKED' && tl.lock === null) tl.lock = this.t;
  }

  getFrame(): SensorFrame | null {
    return this.lastFrame;
  }

  setMeasuredFps(fps: number) {
    this.metrics.fps = fps;
  }

  get state(): TrackState {
    return this.sup.state;
  }

  planPreview() {
    return {
      path: this.target.previewPath(this.cfg.target.periodS, 96),
      search: this.search.waypoints().slice(0, 400),
    };
  }

  private snapshot(
    result: DetectionResult,
    cap: Capture | null,
    accepted: boolean,
    measErrPx: number | null,
    pointErrVec: [number, number] | null,
    pointErrPx: number,
    angErr: number,
    predPx: [number, number] | null,
    decoyDir: Vec3 | null,
  ): Snapshot {
    const c = this.cfg;
    const g = this.gimbal;
    const tr = this.truth;
    const k = this.encCam.k;
    const det = cap?.result.detection ?? null;
    const axis = azElFromDir(this.actCam.basis.f);
    const bf = fieldFromDir(tr.ref, this.actCam.basis.f) ?? { u: 0, v: 0 };
    const ref = azElFromDir(tr.ref.f);
    const kEst = c.kalman.enabled && this.kf.initialized ? this.kf.estimateAt(this.t) : null;
    const estDir = this.estimateDir(this.t)?.dir ?? null;
    const estPx = estDir ? this.encCam.project(estDir) : null;
    const events = this.events;
    this.events = [];
    const inFov = !!(this.lastFrame ? this.lastFrame.spotPx && this.actCam.inFrame(this.lastFrame.spotPx) : this.actCam.inFrame(this.actCam.project(tr.dir)));
    const metrics = this.metrics.summary(this.t, c.logic.lockPx);
    const demoIdx = this.demoPhase >= 0 ? this.demoPhase : 0;
    const snap: Snapshot = {
      t: this.t,
      frame: this.frame,
      state: this.sup.state,
      stateSince: this.sup.since,
      mode: this.mode,
      running: this.running,
      source: this.source,
      target: {
        az: tr.az,
        el: tr.el,
        rangeKm: tr.rangeKm,
        posKm: tr.posKm,
        u: tr.u,
        v: tr.v,
        angRateDegS: tr.angRateDegS,
        transverseKmS: tr.transverseKmS,
        inFov,
        truthPx: this.actCam.project(tr.dir),
        decoyPx: decoyDir ? this.actCam.project(decoyDir) : null,
        refAz: ref.az,
        refEl: ref.el,
      },
      gimbal: {
        pan: g.pan,
        tilt: g.tilt,
        panRate: g.panRate,
        tiltRate: g.tiltRate,
        panCmd: g.panCmd,
        tiltCmd: g.tiltCmd,
        atLimit: g.atLimit,
        axisAz: axis.az,
        axisEl: axis.el,
        boresightU: bf.u,
        boresightV: bf.v,
        goalU: this.searchGoal ? this.searchGoal[0] : null,
        goalV: this.searchGoal ? this.searchGoal[1] : null,
      },
      camera: { width: c.camera.width, height: c.camera.height, hfovDeg: k.hfovDeg, vfovDeg: k.vfovDeg, ifovDeg: k.ifovDeg, focalMm: k.focalMm, fx: k.fx },
      detection: det
        ? {
            valid: true,
            x: det.x,
            y: det.y,
            bbox: det.bbox,
            confidence: det.confidence,
            snr: det.snr,
            area: det.area,
            candidates: det.candidates,
            accepted,
          }
        : null,
      candidates: (cap?.result.candidates ?? []).map((q) => ({ x: q.x, y: q.y, confidence: q.confidence })),
      procMs: result.procMs,
      roi: result.roi,
      kalman: {
        enabled: c.kalman.enabled,
        initialized: this.kf.initialized,
        measPx: det ? [det.x, det.y] : null,
        estPx,
        predPx,
        sigmaPx: [kEst ? kEst.sigmaAz / k.ifovDeg : 0, kEst ? kEst.sigmaEl / k.ifovDeg : 0],
        azRate: kEst?.azRate ?? 0,
        elRate: kEst?.elRate ?? 0,
        innovationPx: this.kf.lastInnovationDeg / k.ifovDeg,
      },
      error: {
        px: pointErrVec,
        magPx: pointErrPx,
        angDeg: angErr,
        estMagPx: estPx ? Math.hypot(estPx[0] - k.cx, estPx[1] - k.cy) : measErrPx,
      },
      control: {
        p: [this.pidPan.lastP, this.pidTilt.lastP],
        i: [this.pidPan.lastI, this.pidTilt.lastI],
        d: [this.pidPan.lastD, this.pidTilt.lastD],
        ff: this.ff,
      },
      disturbance: {
        dPanDeg: this.distState.dPan,
        dTiltDeg: this.distState.dTilt,
        transmission: this.distState.atm.transmission,
        scint: this.distState.scint,
        dropout: this.distState.dropout,
        occluded: this.distState.occluded,
      },
      metrics,
      link: linkEstimate(c, tr.rangeKm, tr.el, angErr),
      timeline: { ...this.timeline },
      events,
      demo: this.demoActive
        ? {
            active: true,
            phase: demoIdx,
            phases: DEMO_PHASES.length,
            title: DEMO_PHASES[demoIdx].title,
            caption: DEMO_PHASES[demoIdx].caption,
            progress: Math.min(1, (this.t - this.demoT0) / DEMO_DURATION),
          }
        : null,
    };
    if (this.frame % 15 === 1) snap.plan = this.planPreview();
    return snap;
  }
}
