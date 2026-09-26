/**
 * Cross-engine parity fixture: one rendered frame plus the browser engine's candidates,
 * features and verifier probabilities. server/tests/test_engine.py checks that the
 * Python detector reproduces them. Usage (from web/):
 *   npx rolldown scripts/verifier/make-fixture.ts --platform node -o /tmp/fx.mjs && node /tmp/fx.mjs > ../server/tests/fixtures/verifier_fixture.json
 */
import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config';
import { PinholeCamera } from '../../src/core/optics/camera';
import { SensorRenderer } from '../../src/core/optics/sensor';
import { makeStarCatalog } from '../../src/core/optics/stars';
import { DisturbanceModel } from '../../src/core/disturbance/disturbance';
import { CentroidDetector } from '../../src/core/detection/centroid';
import { dirFromField } from '../../src/core/geometry';
import { Rng } from '../../src/core/math';

const cfg = mergeConfig(DEFAULT_CONFIG, {
  target: { spotSizePx: 8, beaconIntensity: 140 },
  disturbance: { gaussianNoise: 14, saltPepper: 0.02, atmosphere: 'haze', atmosphereStrength: 0.6, decoy: true, jitterPx: 0, vibrationPx: 0 },
});
const cam = new PinholeCamera(cfg.camera, 205, 42, 4);
const dist = new DisturbanceModel(3).step(1 / 30, cfg.disturbance, 0.00625);
dist.dropout = false;
const frame = new SensorRenderer(640, 480, 11).render({
  cam,
  cfg,
  beaconDir: dirFromField(cam.basis, 0.6, -0.4),
  decoyDir: dirFromField(cam.basis, -1.1, 0.7),
  dist,
  stars: makeStarCatalog(),
  nominalHfovDeg: 4,
});
const res = new CentroidDetector().detect(frame, {
  frameIndex: 0,
  t: 0,
  predicted: null,
  tracking: false,
  gatePx: 60,
  expectedSizePx: 8,
  thresholdSigma: 5,
  minConfidence: 0.35,
  rng: new Rng(1),
  verifier: true,
  collectAll: true,
});
process.stdout.write(
  JSON.stringify({
    width: frame.width,
    height: frame.height,
    spotPx: frame.spotPx,
    expectedSizePx: 8,
    thresholdSigma: 5,
    data: Buffer.from(frame.data).toString('base64'),
    detection: res.detection ? { x: res.detection.x, y: res.detection.y, p: res.detection.pBeacon } : null,
    candidates: res.candidates.map((c) => ({ x: c.x, y: c.y, p: c.pBeacon, features: c.features })),
  }),
);
