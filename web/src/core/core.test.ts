/**
 * Unit tests for the ASTRAQ simulation core (run: npm test).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, cloneConfig, intrinsics, mergeConfig } from './config';
import { OrbitalPass, azElFromDir, basisFromAzEl, dirFromAzEl, dirFromField, fieldFromDir, slantRangeKm } from './geometry';
import { Rng, angleBetweenDeg } from './math';
import { PinholeCamera } from './optics/camera';
import { SensorRenderer } from './optics/sensor';
import { makeStarCatalog } from './optics/stars';
import { CentroidDetector } from './detection/centroid';
import { SyntheticDetector } from './detection/synthetic';
import { AngularKalman } from './estimation/kalman';
import { PidAxis } from './control/pid';
import { Gimbal } from './control/gimbal';
import { SpiralSearch } from './control/search';
import { Supervisor } from './tracking/supervisor';
import { TargetModel } from './target/trajectory';
import { DisturbanceModel, atmosphereEffect } from './disturbance/disturbance';
import { linkEstimate, acquisitionProbability } from './analysis/link';
import { Recorder, CSV_COLUMNS } from './telemetry/recorder';
import { SimulationEngine } from './engine';
import type { TrajectoryKind } from './config';

const noDist = {
  vibrationPx: 0,
  jitterPx: 0,
  windDegS: 0,
  targetNoiseDeg: 0,
  turbulence: 0,
  gaussianNoise: 4,
  saltPepper: 0,
  dropoutProb: 0,
  occlusionPeriodS: 0,
  occlusionDurS: 1,
};

describe('geometry', () => {
  it('az/el round-trips', () => {
    for (const [az, el] of [[0, 0], [90, 10], [205, 42], [359, 80]]) {
      const r = azElFromDir(dirFromAzEl(az, el));
      expect(r.az).toBeCloseTo(az, 6);
      expect(r.el).toBeCloseTo(el, 6);
    }
  });
  it('field coordinates round-trip (gnomonic)', () => {
    const b = basisFromAzEl(120, 35);
    const f = fieldFromDir(b, dirFromField(b, 3.2, -1.7))!;
    expect(f.u).toBeCloseTo(3.2, 6);
    expect(f.v).toBeCloseTo(-1.7, 6);
  });
  it('orbital pass reaches the configured maximum elevation', () => {
    const p = new OrbitalPass(550, 62, 160);
    let maxEl = -90;
    for (let t = -300; t <= 300; t += 0.5) maxEl = Math.max(maxEl, azElFromDir(p.positionKm(t)).el);
    expect(maxEl).toBeCloseTo(62, 1);
    expect(p.speedKmS).toBeGreaterThan(7.4);
    expect(p.speedKmS).toBeLessThan(7.7);
  });
  it('slant range at zenith equals altitude', () => {
    expect(slantRangeKm(550, 90)).toBeCloseTo(550, 6);
  });
});

describe('camera model', () => {
  const cam = new PinholeCamera(DEFAULT_CONFIG.camera, 205, 42);
  it('PS default intrinsics: 640×480, 4°×3°, 0.00625 °/px', () => {
    const k = intrinsics(DEFAULT_CONFIG.camera);
    expect(k.vfovDeg).toBeCloseTo(3.0, 2);
    expect(k.ifovDeg).toBeCloseTo(0.00625, 6);
    expect(k.cx).toBe(320);
    expect(k.cy).toBe(240);
  });
  it('optical axis projects to the principal point', () => {
    const p = cam.project(cam.basis.f)!;
    expect(p[0]).toBeCloseTo(320, 9);
    expect(p[1]).toBeCloseTo(240, 9);
  });
  it('half-FOV offset projects to the image edge; +u → right, +v → up', () => {
    const b = basisFromAzEl(205, 42);
    expect(cam.project(dirFromField(b, 2, 0))![0]).toBeCloseTo(640, 6);
    expect(cam.project(dirFromField(b, 0, 1.5))![1]).toBeCloseTo(0, 1);
  });
  it('unproject inverts project', () => {
    const d = dirFromField(basisFromAzEl(205, 42), 0.7, -0.4);
    const p = cam.project(d)!;
    expect(angleBetweenDeg(cam.unproject(p[0], p[1]), d)).toBeLessThan(1e-9);
  });
  it('directions behind the camera are rejected', () => {
    expect(cam.project(cam.basis.f.map((x) => -x) as [number, number, number])).toBeNull();
  });
});

describe('target trajectories', () => {
  const kinds: TrajectoryKind[] = ['stationary', 'linear', 'circular', 'sinusoidal', 'figure8', 'spiral', 'random', 'custom'];
  for (const k of kinds) {
    it(`${k} stays inside the search field and moves continuously`, () => {
      const cfg = mergeConfig(DEFAULT_CONFIG, { target: { trajectory: k } });
      const m = new TargetModel(cfg, 3);
      let prev = m.step(1 / 30, 0);
      for (let i = 0; i < 30 * 60; i++) {
        const s = m.step(1 / 30, 0);
        expect(Math.abs(s.u)).toBeLessThanOrEqual(cfg.logic.searchHalfUDeg + 1e-6);
        expect(Math.abs(s.v)).toBeLessThanOrEqual(cfg.logic.searchHalfVDeg + 1e-6);
        expect(Math.hypot(s.u - prev.u, s.v - prev.v)).toBeLessThan(0.2); // < 6 °/s
        prev = s;
      }
      if (k !== 'stationary') expect(prev.angRateDegS).toBeGreaterThanOrEqual(0);
    });
  }
  it('switching pattern mid-run does not teleport the target', () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { target: { trajectory: 'circular' } });
    const m = new TargetModel(cfg, 9);
    let s = m.step(1 / 30, 0);
    for (let i = 0; i < 100; i++) s = m.step(1 / 30, 0);
    m.setConfig(mergeConfig(cfg, { target: { trajectory: 'figure8' } }));
    const s2 = m.step(1 / 30, 0);
    expect(Math.hypot(s2.u - s.u, s2.v - s.v)).toBeLessThan(0.15);
  });
  it('random start positions differ between seeds (PS default: random)', () => {
    const a = new TargetModel(DEFAULT_CONFIG, 1).step(0, 0);
    const b = new TargetModel(DEFAULT_CONFIG, 2).step(0, 0);
    expect(Math.hypot(a.u - b.u, a.v - b.v)).toBeGreaterThan(0.01);
  });
  it('orbital target follows a pass with ephemeris offset', () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { target: { trajectory: 'orbital' } });
    const m = new TargetModel(cfg, 1);
    const s = m.step(1 / 30, 0);
    expect(s.rangeKm).toBeGreaterThan(550);
    expect(Math.hypot(s.u, s.v)).toBeGreaterThan(0.5); // predicted LOS lags the true satellite
  });
});

describe('sensor + centroid detector', () => {
  const stars = makeStarCatalog();
  function frameWith(offsetU: number, offsetV: number, patch = {}) {
    const cfg = mergeConfig(DEFAULT_CONFIG, { disturbance: { ...noDist, ...patch } });
    const cam = new PinholeCamera(cfg.camera, 205, 42);
    const r = new SensorRenderer(640, 480, 5);
    const dm = new DisturbanceModel(1);
    const dist = dm.step(1 / 30, cfg.disturbance, 0.00625);
    dist.dropout = false;
    const beacon = dirFromField(cam.basis, offsetU, offsetV);
    return { frame: r.render({ cam, cfg, beaconDir: beacon, decoyDir: null, dist, stars, nominalHfovDeg: 4 }), cfg };
  }
  const ctx = (cfg = DEFAULT_CONFIG) => ({
    frameIndex: 1,
    t: 0,
    predicted: null,
    tracking: false,
    gatePx: 60,
    expectedSizePx: 10,
    thresholdSigma: cfg.detection.thresholdSigma,
    minConfidence: cfg.detection.minConfidence,
    rng: new Rng(1),
  });
  it('renders the beacon where the camera model projects it', () => {
    const { frame } = frameWith(0.5, -0.25);
    expect(frame.truthPx![0]).toBeCloseTo(320 + 0.5 / 0.00625, 0);
    expect(frame.truthPx![1]).toBeCloseTo(240 + 0.25 / 0.00625, 0);
    expect(frame.spotVisible).toBe(true);
  });
  it('detects the beacon with sub-pixel centroid accuracy', () => {
    const { frame, cfg } = frameWith(0.5, -0.25);
    const r = new CentroidDetector().detect(frame, ctx(cfg));
    expect(r.detection).not.toBeNull();
    expect(Math.hypot(r.detection!.x - frame.spotPx![0], r.detection!.y - frame.spotPx![1])).toBeLessThan(0.5);
    expect(r.detection!.confidence).toBeGreaterThan(0.8);
  });
  it('survives 10 % salt & pepper and σ = 20 Gaussian noise (PS maxima)', () => {
    const { frame, cfg } = frameWith(-0.8, 0.6, { saltPepper: 0.1, gaussianNoise: 20, poisson: true });
    const r = new CentroidDetector().detect(frame, ctx(cfg));
    expect(r.detection).not.toBeNull();
    expect(Math.hypot(r.detection!.x - frame.spotPx![0], r.detection!.y - frame.spotPx![1])).toBeLessThan(1.5);
  });
  it('reports nothing when only noise is present', () => {
    const { frame, cfg } = frameWith(30, 30, { saltPepper: 0.05, gaussianNoise: 12 }); // beacon far outside
    const r = new CentroidDetector().detect(frame, ctx(cfg));
    expect(r.detection).toBeNull();
  });
  it('fog lowers the recorded beacon peak', () => {
    const clear = frameWith(0, 0).frame.spotPeak;
    const fog = frameWith(0, 0, { atmosphere: 'fog', atmosphereStrength: 0.8 }).frame.spotPeak;
    expect(fog).toBeLessThan(clear * 0.5);
  });
  it('synthetic provider is labelled as a model and follows truth', () => {
    const det = new SyntheticDetector(0.5, 0);
    const r = det.detect(null, { ...ctx(), truth: { px: [100, 200], visible: true, transmission: 1, noiseSigma: 0 } });
    expect(det.label).toMatch(/model/i);
    expect(Math.hypot(r.detection!.x - 100, r.detection!.y - 200)).toBeLessThan(3);
  });
});

describe('Kalman filter', () => {
  it('converges on a constant-velocity target and estimates its rate', () => {
    const kf = new AngularKalman();
    const rng = new Rng(4);
    const dt = 1 / 30;
    kf.init(100, 30, 0, 0.01);
    for (let i = 1; i <= 300; i++) {
      const t = i * dt;
      kf.predictTo(t, 0.02, 30);
      kf.update(100 + 0.8 * t + 0.003 * rng.gauss(), 30 - 0.3 * t + 0.003 * rng.gauss(), 0.003, 25);
    }
    const e = kf.estimateAt(10);
    expect(e.azRate).toBeCloseTo(0.8, 1);
    expect(e.elRate).toBeCloseTo(-0.3, 1);
    expect(Math.abs(e.el - 27)).toBeLessThan(0.01);
  });
  it('rejects gross outliers through the innovation gate', () => {
    const kf = new AngularKalman();
    kf.init(10, 10, 0, 0.005);
    for (let i = 1; i < 20; i++) {
      kf.predictTo(i / 30, 0.5, 10);
      kf.update(10, 10, 0.005, 25);
    }
    kf.predictTo(20 / 30, 0.5, 10);
    expect(kf.update(12, 10, 0.005, 25)).toBe(false);
  });
});

describe('PID, gimbal, search', () => {
  const g = { ...DEFAULT_CONFIG.control };
  it('PID output respects the rate limit and does not wind up', () => {
    const pid = new PidAxis();
    for (let i = 0; i < 600; i++) expect(Math.abs(pid.update(5, 1 / 60, g, 5))).toBeLessThanOrEqual(5);
    expect(Math.abs(pid.integral)).toBeLessThanOrEqual(g.integralLimit);
  });
  it('gimbal obeys rate and tilt limits', () => {
    const gim = new Gimbal(DEFAULT_CONFIG.gimbal);
    gim.reset(0, 80);
    for (let i = 0; i < 600; i++) gim.step(1 / 60, 50, 50);
    expect(Math.abs(gim.panRate)).toBeLessThanOrEqual(5 + 1e-9);
    expect(gim.tilt).toBeLessThanOrEqual(DEFAULT_CONFIG.gimbal.tiltMaxDeg);
    expect(gim.atLimit).toBe(true);
  });
  it('pan and tilt are independently controllable', () => {
    const gim = new Gimbal(DEFAULT_CONFIG.gimbal);
    gim.reset(10, 20);
    for (let i = 0; i < 120; i++) gim.step(1 / 60, 2, 0);
    expect(gim.pan).toBeGreaterThan(13);
    expect(gim.tilt).toBeCloseTo(20, 6);
  });
  it('spiral search covers the whole field', () => {
    const k = intrinsics(DEFAULT_CONFIG.camera);
    const s = new SpiralSearch(6.25, 6.25, k.hfovDeg * 0.85, k.vfovDeg * 0.85);
    const pts = s.waypoints();
    for (let u = -6; u <= 6; u += 0.5)
      for (let v = -6; v <= 6; v += 0.5)
        expect(pts.some(([pu, pv]) => Math.abs(pu - u) <= k.hfovDeg / 2 && Math.abs(pv - v) <= k.vfovDeg / 2)).toBe(true);
  });
});

describe('supervisor state machine', () => {
  it('walks SEARCHING → DETECTED → ACQUIRING → TRACKING → LOCKED on real conditions', () => {
    const s = new Supervisor(DEFAULT_CONFIG.logic);
    s.force(0, 'SEARCHING', 'start');
    const seen: string[] = [];
    let t = 0;
    const errs = [200, 150, 100, 60, 25, 12, 8, 7, 6, 5, 5, 5, 4, 4];
    for (const e of errs) {
      t += 1 / 30;
      const ev = s.step({ t, detected: true, measErrPx: e, filtErrPx: e, confidence: 0.9 });
      if (ev) seen.push(ev.to!);
    }
    expect(seen).toEqual(['DETECTED', 'ACQUIRING', 'TRACKING', 'LOCKED']);
  });
  it('misses lead to LOST, then REACQUIRING, then SEARCHING on timeout', () => {
    const s = new Supervisor(DEFAULT_CONFIG.logic);
    s.force(0, 'TRACKING', 'test');
    const seen: string[] = [];
    for (let i = 1; i < 200; i++) {
      const ev = s.step({ t: i / 30, detected: false, measErrPx: null, filtErrPx: null, confidence: 0 });
      if (ev) seen.push(ev.to!);
    }
    expect(seen).toEqual(['LOST', 'REACQUIRING', 'SEARCHING']);
  });
  it('a single noise hit is not confirmed', () => {
    const s = new Supervisor(DEFAULT_CONFIG.logic);
    s.force(0, 'SEARCHING', 'start');
    s.step({ t: 0.03, detected: true, measErrPx: 100, filtErrPx: null, confidence: 0.5 });
    s.step({ t: 0.06, detected: false, measErrPx: null, filtErrPx: null, confidence: 0 });
    const ev = s.step({ t: 0.1, detected: false, measErrPx: null, filtErrPx: null, confidence: 0 });
    expect(ev?.to).toBe('SEARCHING');
  });
});

describe('closed loop (PS acceptance scenarios)', () => {
  const kinds: TrajectoryKind[] = ['stationary', 'linear', 'circular', 'sinusoidal', 'figure8', 'random', 'orbital'];
  for (const k of kinds) {
    it(`${k}: acquires ≤ 2 s and tracks with RMS error ≤ 10 px`, () => {
      const e = new SimulationEngine(mergeConfig(DEFAULT_CONFIG, { seed: 21, target: { trajectory: k } }));
      e.start();
      let s = e.step();
      for (let i = 0; i < 30 * 15; i++) s = e.step();
      expect(s.metrics.acquisitionS).not.toBeNull();
      expect(s.metrics.acquisitionS!).toBeLessThanOrEqual(2);
      expect(s.metrics.errRmsPx!).toBeLessThanOrEqual(10);
      expect(s.metrics.lossPct!).toBeLessThan(5);
      expect(['TRACKING', 'LOCKED']).toContain(s.state);
    });
  }
  it('gimbal actually moves and the target actually moves', () => {
    const e = new SimulationEngine(mergeConfig(DEFAULT_CONFIG, { seed: 2, target: { trajectory: 'circular' } }));
    e.start();
    const a = e.step();
    let b = a;
    for (let i = 0; i < 150; i++) b = e.step();
    expect(Math.hypot(b.gimbal.pan - a.gimbal.pan, b.gimbal.tilt - a.gimbal.tilt)).toBeGreaterThan(0.05);
    expect(Math.hypot(b.target.u - a.target.u, b.target.v - a.target.v)).toBeGreaterThan(0.05);
  });
  it('dropouts cause LOST and the tracker reacquires', () => {
    const e = new SimulationEngine(mergeConfig(DEFAULT_CONFIG, { seed: 8, target: { trajectory: 'circular' } }));
    e.start();
    for (let i = 0; i < 30 * 5; i++) e.step();
    e.applyConfig({ disturbance: { dropoutProb: 0.95 } });
    const states = new Set<string>();
    for (let i = 0; i < 30 * 2; i++) states.add(e.step().state);
    e.applyConfig({ disturbance: { dropoutProb: 0 } });
    let s = e.step();
    for (let i = 0; i < 30 * 5; i++) s = e.step();
    expect(states.has('LOST')).toBe(true);
    expect(['TRACKING', 'LOCKED']).toContain(s.state);
    expect(s.metrics.lossEvents).toBeGreaterThan(0);
    expect(s.metrics.reacqMaxS).not.toBeNull();
  });
  it('Kalman filter + feed-forward outperform raw measurements', () => {
    const run = (enabled: boolean) => {
      const e = new SimulationEngine(mergeConfig(DEFAULT_CONFIG, { seed: 4, target: { trajectory: 'circular', periodS: 10 }, kalman: { enabled } }));
      e.start();
      let s = e.step();
      for (let i = 0; i < 30 * 15; i++) s = e.step();
      return s.metrics.errRmsPx ?? 999;
    };
    expect(run(true)).toBeLessThan(run(false));
  });
  it('manual mode drives pan and tilt to operator angles', () => {
    const e = new SimulationEngine(DEFAULT_CONFIG);
    e.start();
    e.setMode('manual');
    e.setManualGoal(210, 45);
    let s = e.step();
    for (let i = 0; i < 30 * 4; i++) s = e.step();
    expect(s.gimbal.pan).toBeCloseTo(-150, 0);
    expect(s.gimbal.tilt).toBeCloseTo(45, 0);
  });
  it('demo runs its phases and is deterministic for a seed', () => {
    const go = () => {
      const e = new SimulationEngine(DEFAULT_CONFIG);
      e.setDemo(true);
      const titles = new Set<string>();
      let s = e.step();
      for (let i = 0; i < 30 * 91; i++) {
        s = e.step();
        if (s.demo) titles.add(s.demo.title);
      }
      return { titles, s };
    };
    const a = go();
    const b = go();
    expect(a.titles.size).toBe(6);
    expect(a.s.metrics.lossEvents).toBeGreaterThan(0);
    expect(a.s.metrics.errRmsPx).toBeCloseTo(b.s.metrics.errRmsPx!, 9);
  }, 60000);
});

describe('analysis & recording', () => {
  it('link budget: margin falls with range and atmosphere', () => {
    const a = linkEstimate(DEFAULT_CONFIG, 600, 60, 0);
    const b = linkEstimate(DEFAULT_CONFIG, 1200, 60, 0);
    const fog = linkEstimate(mergeConfig(DEFAULT_CONFIG, { disturbance: { atmosphere: 'fog', atmosphereStrength: 1 } }), 600, 60, 0);
    expect(b.marginDb).toBeLessThan(a.marginDb);
    expect(b.geomLossDb - a.geomLossDb).toBeCloseTo(6.02, 1); // inverse-square
    expect(fog.marginDb).toBeLessThan(a.marginDb - 5);
    expect(linkEstimate(DEFAULT_CONFIG, 600, 60, 0.2).fineHandover).toBe(false);
  });
  it('acquisition probability is higher with wide-field acquisition', () => {
    const wide = acquisitionProbability(DEFAULT_CONFIG).pAcq;
    const narrow = acquisitionProbability(mergeConfig(DEFAULT_CONFIG, { camera: { wideAcquisition: false } })).pAcq;
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThan(0);
    expect(wide).toBeLessThanOrEqual(1);
  });
  it('atmosphere presets order by severity', () => {
    expect(atmosphereEffect('fog', 1).transmission).toBeLessThan(atmosphereEffect('haze', 1).transmission);
    expect(atmosphereEffect('clear', 1).transmission).toBeGreaterThan(0.8);
  });
  it('recorder exports a CSV row per frame with the documented columns', () => {
    const e = new SimulationEngine(cloneConfig(DEFAULT_CONFIG));
    e.start();
    const rec = new Recorder();
    rec.start();
    for (let i = 0; i < 90; i++) rec.push(e.step());
    const csv = rec.toCsv().split('\n');
    expect(csv.length).toBe(91);
    expect(csv[0].split(',')).toEqual(CSV_COLUMNS);
    expect(csv[5].split(',').length).toBe(CSV_COLUMNS.length);
    const json = rec.toRecording('test', e.cfg, 'local');
    expect(json.frames.length).toBe(90);
    expect(json.events.length).toBeGreaterThan(0);
  });
});
