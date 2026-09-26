/**
 * Training/evaluation data for the learned beacon verifier.
 *
 * Renders random sensor frames that span the problem statement's disturbance space
 * (all atmospheres, Gaussian σ 0–20, salt & pepper 0–10 %, Poisson, turbulence, spot
 * size 5–20 px, three spot shapes, narrow 4° and wide 12° FOV, decoy glints, stars),
 * runs the classical detector with every candidate kept, and labels each candidate:
 * 1 = within max(3 px, ½ spot) of the drawn beacon, 0 = anything else.
 *
 * Output: CSV (features…, label, group) on stdout. Usage (from web/):
 *   npx rolldown scripts/verifier/gen-data.ts --platform node -o /tmp/gen.mjs && node /tmp/gen.mjs 6000 1 > data.csv
 */
import { DEFAULT_CONFIG, mergeConfig, SimConfig, AtmosphereMode, SpotShape } from '../../src/core/config';
import { PinholeCamera } from '../../src/core/optics/camera';
import { SensorRenderer } from '../../src/core/optics/sensor';
import { makeStarCatalog } from '../../src/core/optics/stars';
import { DisturbanceModel } from '../../src/core/disturbance/disturbance';
import { CentroidDetector } from '../../src/core/detection/centroid';
import { dirFromField } from '../../src/core/geometry';
import { Rng } from '../../src/core/math';

const nFrames = Number(process.argv[2] ?? 4000);
const seed = Number(process.argv[3] ?? 1);
const rng = new Rng(seed * 7919 + 13);
const stars = makeStarCatalog();
const renderer = new SensorRenderer(640, 480, seed);
const det = new CentroidDetector();
const ATM: AtmosphereMode[] = ['clear', 'clear', 'haze', 'fog', 'rain', 'low_light'];
const SHAPES: SpotShape[] = ['square', 'square', 'disk', 'gaussian'];
const out: string[] = [];
const u = (a: number, b: number) => a + (b - a) * rng.next();
const pick = <T,>(a: T[]) => a[Math.floor(rng.next() * a.length)];

for (let f = 0; f < nFrames; f++) {
  const wide = rng.next() < 0.35;
  const hfov = wide ? 12 : 4;
  const spot = Math.round(u(5, 20));
  const atmosphere = pick(ATM);
  const cfg: SimConfig = mergeConfig(DEFAULT_CONFIG, {
    target: { spotSizePx: spot, spotShape: pick(SHAPES), beaconIntensity: u(70, 255) },
    disturbance: {
      gaussianNoise: rng.next() < 0.15 ? 0 : u(2, 20),
      saltPepper: rng.next() < 0.4 ? 0 : u(0.002, 0.1),
      poisson: rng.next() < 0.7,
      atmosphere,
      atmosphereStrength: u(0.1, 1),
      turbulence: u(0, 1),
      dropoutProb: 0,
      decoy: rng.next() < 0.3,
      jitterPx: 0,
      vibrationPx: 0,
    },
  });
  const az = u(150, 260);
  const el = u(15, 75);
  const cam = new PinholeCamera(cfg.camera, az, el, hfov);
  const dm = new DisturbanceModel(seed * 100000 + f);
  const dist = dm.step(1 / 30, cfg.disturbance, hfov / 640);
  dist.dropout = rng.next() < 0.1;
  const halfU = hfov / 2;
  const halfV = (hfov * 0.75) / 2;
  const bu = u(-halfU * 1.05, halfU * 1.05);
  const bv = u(-halfV * 1.05, halfV * 1.05);
  const beaconDir = dirFromField(cam.basis, bu, bv);
  const decoyDir = cfg.disturbance.decoy ? dirFromField(cam.basis, u(-halfU, halfU), u(-halfV, halfV)) : null;
  const frame = renderer.render({ cam, cfg, beaconDir, decoyDir, dist, stars, nominalHfovDeg: 4 });
  const sizeScale = 4 / hfov;
  const tracking = rng.next() < 0.3 && !!frame.spotPx;
  const res = det.detect(frame, {
    frameIndex: f,
    t: f / 30,
    predicted: tracking && frame.spotPx ? [frame.spotPx[0] + u(-15, 15), frame.spotPx[1] + u(-15, 15)] : null,
    tracking,
    gatePx: 60,
    expectedSizePx: spot * sizeScale,
    thresholdSigma: u(3.2, 4.5),
    minConfidence: 0,
    rng,
    collectAll: true,
  });
  const group = `${atmosphere}|${wide ? 'wide' : 'narrow'}|${cfg.disturbance.decoy ? 'decoy' : '-'}`;
  for (const c of res.candidates) {
    if (!c.features) continue;
    let label = 0;
    if (frame.spotVisible && frame.spotPx) {
      const d = Math.hypot(c.x - frame.spotPx[0], c.y - frame.spotPx[1]);
      if (d <= Math.max(3, 0.5 * spot * sizeScale)) label = 1;
    }
    out.push([...c.features.map((v) => v.toFixed(5)), c.confidence.toFixed(5), label, f, group].join(','));
  }
}
process.stdout.write(['f0,f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,conf,label,frame,group', ...out].join('\n') + '\n');
