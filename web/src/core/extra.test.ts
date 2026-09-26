/**
 * Tests for the features added in the second iteration: scheduled occlusions and the
 * visibility-aware re-acquisition metric, the learned beacon verifier, the automatic
 * performance report, the camera-bypass video analyzer on full-screen frames and the
 * candidate-ranking fix for busy frames.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from './config';
import { SimulationEngine } from './engine';
import { presetConfig } from './presets';
import { CentroidDetector } from './detection/centroid';
import { VERIFIER, verifierProbability } from './detection/verifier';
import { buildReport, reportHtml, reportMarkdown } from './analysis/report';
import { VideoAnalyzer, parseTruthCsv } from './video/analyzer';
import { syntheticFrame as builtinStreamFrame } from './video/synthetic';
import { Rng } from './math';
import type { SensorFrame } from './optics/sensor';

function run(cfg = DEFAULT_CONFIG, seconds = 10) {
  const e = new SimulationEngine(cfg);
  e.renderAlways = false;
  e.start();
  let s = e.step();
  let occluded = false;
  for (let i = 1; i < seconds * 30; i++) {
    s = e.step();
    occluded ||= s.disturbance.occluded;
  }
  return { s, occluded };
}

function syntheticFrame(W: number, H: number, spots: [number, number, number][], seed: number, noise = 10, sp = 0): SensorFrame {
  const rng = new Rng(seed);
  const data = new Uint8ClampedArray(W * H);
  for (let i = 0; i < data.length; i++) {
    let v = 14 + noise * rng.gauss();
    if (sp > 0) {
      const u = rng.next();
      if (u < sp / 2) v = 0;
      else if (u > 1 - sp / 2) v = 255;
    }
    data[i] = v;
  }
  for (const [cx, cy, size] of spots) {
    const x0 = Math.round(cx - size / 2);
    const y0 = Math.round(cy - size / 2);
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) if (x >= 0 && y >= 0 && x < W && y < H) data[y * W + x] = Math.min(255, data[y * W + x] + 200);
  }
  return { width: W, height: H, data, truthPx: null, spotPx: null, spotVisible: true, spotSizePx: 10, spotPeak: 0, decoyPx: null, background: 14 };
}

const ctx = (over = {}) => ({
  frameIndex: 0,
  t: 0,
  predicted: null,
  tracking: false,
  gatePx: 60,
  expectedSizePx: 10,
  thresholdSigma: 5,
  minConfidence: 0.35,
  rng: new Rng(3),
  ...over,
});

describe('occlusion and re-acquisition', () => {
  it('scheduled outages cause losses that are re-acquired within 1 s with low error', () => {
    const { s, occluded } = run(presetConfig('occlusion', 11), 14);
    expect(occluded).toBe(true);
    expect(s.metrics.lossEvents).toBeGreaterThanOrEqual(2);
    expect(s.metrics.reacqMaxS).not.toBeNull();
    expect(s.metrics.reacqMaxS as number).toBeLessThanOrEqual(1);
    expect(s.metrics.errRmsPx as number).toBeLessThan(10);
  });
});

describe('learned beacon verifier', () => {
  it('ships trained weights with an operating point', () => {
    expect(VERIFIER.trained).toBe(true);
    expect(VERIFIER.layers.length).toBe(3);
    expect(VERIFIER.threshold).toBeGreaterThan(0.3);
    expect(Number(VERIFIER.metrics?.aucMlp)).toBeGreaterThan(Number(VERIFIER.metrics?.aucHand));
  });
  it('accepts a clean 10 px beacon and rejects single-pixel impulses', () => {
    const f = syntheticFrame(640, 480, [[300, 200, 10]], 5, 8, 0.02);
    const r = new CentroidDetector().detect(f, ctx({ verifier: true, collectAll: true }));
    expect(r.detection).not.toBeNull();
    expect(Math.hypot((r.detection as { x: number }).x - 300, (r.detection as { y: number }).y - 200)).toBeLessThan(0.8);
    const others = r.candidates.filter((c) => Math.hypot(c.x - 300, c.y - 200) > 5);
    for (const c of others) expect(c.pBeacon ?? 0).toBeLessThan(VERIFIER.threshold);
  });
  it('probability is monotone in the obvious direction', () => {
    const good = [0, Math.log(40), 0, 0, 0.8, 0, Math.log(10), 0, Math.log(8), 0.8, 0.35];
    const noise = [-3, Math.log(6), 0.4, 0.7, 0.5, 0, Math.log(10), 0, Math.log(8), 0.05, 0.1];
    expect(verifierProbability(good)).toBeGreaterThan(0.9);
    expect(verifierProbability(noise)).toBeLessThan(0.1);
  });
});

describe('detector on busy frames', () => {
  it('finds a beacon below more than 64 noise blobs (strongest candidates kept, not the first in raster order)', () => {
    const blobs: [number, number, number][] = [];
    for (let i = 0; i < 120; i++) blobs.push([20 + (i % 30) * 20, 10 + Math.floor(i / 30) * 12, 2]);
    blobs.push([320, 400, 10]);
    const f = syntheticFrame(640, 480, blobs, 9, 6);
    const r = new CentroidDetector().detect(f, ctx({ verifier: true }));
    expect(r.detection).not.toBeNull();
    expect(Math.hypot((r.detection as { x: number }).x - 320, (r.detection as { y: number }).y - 400)).toBeLessThan(1);
  });
  it('searches large frames coarse-to-fine and keeps sub-pixel accuracy', () => {
    const f = syntheticFrame(1600, 1600, [[1112, 378, 10]], 4, 12, 0.01);
    const r = new CentroidDetector().detect(f, ctx({ verifier: true }));
    expect(r.detection).not.toBeNull();
    expect(Math.hypot((r.detection as { x: number }).x - 1112, (r.detection as { y: number }).y - 378)).toBeLessThan(0.5);
  });
});

describe('camera-bypass video analyzer', () => {
  it('tracks a beacon across a full-screen video with automatic spot size', () => {
    const a = new VideoAnalyzer(undefined, 30);
    const W = 1400;
    for (let i = 0; i < 45; i++) {
      const t = i / 30;
      const x = W / 2 + 0.3 * W * Math.sin((2 * Math.PI * t) / 5);
      const y = W / 2 + 0.3 * W * Math.sin((2 * Math.PI * t) / 3.3 + 0.7);
      const cx = Math.round(x - 5) + 5;
      const cy = Math.round(y - 5) + 5;
      const f = syntheticFrame(W, W, [[cx, cy, 10]], 100 + i, 10, 0.01);
      a.process(f.data, W, W, [cx, cy]);
    }
    const s = a.summary('synthetic', true);
    expect(a.spotSizePx).toBeGreaterThan(7);
    expect(a.spotSizePx).toBeLessThan(14);
    expect(s.acquisitionS).not.toBeNull();
    expect(s.acquisitionS as number).toBeLessThan(0.5);
    expect(s.centroidRmsePx as number).toBeLessThan(0.8);
    expect(s.lockRetentionPct as number).toBeGreaterThan(95);
    expect(a.csv().split('\n')[0]).toBe('frame,t_s,state,detected,x_px,y_px,confidence,kf_x_px,kf_y_px,err_x_px,err_y_px,err_px,err_deg,proc_ms,truth_x_px,truth_y_px,centroid_err_px');
  });
  it('handles the built-in 2000×2000 stream with salt & pepper (impulses removed before the coarse search)', () => {
    const a = new VideoAnalyzer(undefined, 30);
    const g = new Uint8Array(2000 * 2000);
    const rng = new Rng(7);
    for (let i = 0; i < 40; i++) a.process(g, 2000, 2000, builtinStreamFrame(i, 30, 2000, 2000, rng, g));
    const s = a.summary('builtin', true);
    expect(s.acquisitionS as number).toBeLessThan(0.5);
    expect(s.centroidRmsePx as number).toBeLessThan(0.5);
    expect(s.lockRetentionPct as number).toBeGreaterThan(90);
  });
  it('parses a ground-truth CSV', () => {
    const m = parseTruthCsv('frame,x,y\n0,10.5,20\n2,11,21.25\n');
    expect(m.get(2)).toEqual([11, 21.25]);
    expect(m.size).toBe(2);
  });
});

describe('automatic performance report', () => {
  it('contains every quantity the PS asks for, in JSON, Markdown and HTML', () => {
    const { s } = run(mergeConfig(DEFAULT_CONFIG, { seed: 4 }), 6);
    const rep = buildReport({ kind: 'live', source: 'test', config: DEFAULT_CONFIG, metrics: s.metrics, events: s.events });
    const keys = rep.rows.map((r) => r.key);
    for (const k of ['duration', 'fps', 'acq', 'errMean', 'errMax', 'retention', 'proc']) expect(keys).toContain(k);
    expect(rep.acceptance.length).toBeGreaterThanOrEqual(4);
    expect(reportMarkdown(rep)).toContain('| Metric | Value | PS169 limit | Result |');
    expect(reportHtml(rep)).toContain('<title>ASTRAQ performance report');
  });
  it('aggregates a batch', () => {
    const rows = [1, 2].map((seed) => ({ seed, finalState: 'LOCKED', metrics: run(mergeConfig(DEFAULT_CONFIG, { seed }), 4).s.metrics }));
    const rep = buildReport({ kind: 'batch', source: 'test', config: DEFAULT_CONFIG, batch: rows });
    expect(rep.batch?.rows.length).toBe(2);
    expect(rep.rows.find((r) => r.key === 'locked')?.value).toBe(2);
  });
});
