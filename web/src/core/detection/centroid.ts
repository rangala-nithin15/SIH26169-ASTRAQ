/**
 * Image-based beacon detector (classical computer vision, no learned model).
 *
 *   1. ROI      full frame while searching; a window around the Kalman prediction
 *               while tracking (faster and rejects distant decoys).
 *   2. Impulse  saturated/black pixels with fewer than 3 similar 8-neighbours (salt &
 *      repair   pepper, including adjacent pairs) are replaced by the mean of their
 *               dissimilar neighbours. Beacon cores survive: their neighbours are bright.
 *   3. Smooth   3×3 box mean from an integral image (≈3× lower white-noise σ).
 *   4. Stats    robust background: median and MAD of the smoothed ROI (histogram).
 *   5. Segment  threshold = median + k·σ, 4-connected components.
 *   6. Score    size match against the expected spot footprint and SNR → confidence.
 *               While tracking, candidates are also weighted by distance to the
 *               prediction (data association).
 *   7. Centroid intensity-weighted centre of gravity on the repaired image.
 */
import { Candidate, DetectionContext, DetectionProvider, DetectionResult } from './types';
import { SensorFrame } from '../optics/sensor';
import { VERIFIER, verifierProbability } from './verifier';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class CentroidDetector implements DetectionProvider {
  readonly id = 'centroid';
  readonly label = 'Image centroid detector (threshold + connected components)';
  readonly needsImage = true;
  private work = new Float32Array(0);
  private smooth = new Float32Array(0);
  private integ = new Float64Array(0);
  private labels = new Int32Array(0);
  private stack = new Int32Array(0);

  reset() {}

  private ensure(n: number, w: number, h: number) {
    if (this.work.length < n) {
      this.work = new Float32Array(n);
      this.smooth = new Float32Array(n);
      this.labels = new Int32Array(n);
      this.stack = new Int32Array(n);
    }
    const ni = (w + 1) * (h + 1);
    if (this.integ.length < ni) this.integ = new Float64Array(ni);
  }

  /** Frames larger than this are searched coarse-to-fine (½ resolution, then refined). */
  static PYRAMID_PIXELS = 1_500_000;
  /** Candidates kept per frame (strongest first). */
  static MAX_CANDIDATES = 64;

  detect(frame: SensorFrame | null, ctx: DetectionContext): DetectionResult {
    const t0 = now();
    if (!frame) return { detection: null, candidates: [], procMs: 0, roi: null, threshold: 0 };
    if (!ctx.tracking && !ctx.noPyramid && frame.width * frame.height > CentroidDetector.PYRAMID_PIXELS) return this.detectPyramid(frame, ctx, t0);
    return this.detectFull(frame, ctx, t0);
  }

  /** Search a 2×2-mean decimated copy, then refine around the best hit at full resolution. */
  private detectPyramid(frame: SensorFrame, ctx: DetectionContext, t0: number): DetectionResult {
    const W = frame.width;
    const H = frame.height;
    const w2 = W >> 1;
    const h2 = H >> 1;
    const small = new Uint8ClampedArray(w2 * h2);
    // Remove salt & pepper at full resolution first: averaged impulses would otherwise
    // survive decimation as thousands of faint blobs.
    const d = repairImpulses(frame.data, W, H);
    for (let y = 0; y < h2; y++) {
      const r0 = 2 * y * W;
      const r1 = r0 + W;
      for (let x = 0; x < w2; x++) {
        const i = 2 * x;
        small[y * w2 + x] = (d[r0 + i] + d[r0 + i + 1] + d[r1 + i] + d[r1 + i + 1] + 2) >> 2;
      }
    }
    const sf: SensorFrame = { ...frame, width: w2, height: h2, data: small, spotSizePx: frame.spotSizePx / 2 };
    const r1 = this.detectFull(sf, { ...ctx, gatePx: ctx.gatePx / 2, expectedSizePx: Math.max(1.5, ctx.expectedSizePx / 2), noPyramid: true }, t0);
    const scale = (c: Candidate): Candidate => ({ ...c, x: c.x * 2, y: c.y * 2, bbox: [c.bbox[0] * 2, c.bbox[1] * 2, c.bbox[2] * 2 + 1, c.bbox[3] * 2 + 1], area: c.area * 4 });
    if (!r1.detection) return { ...r1, candidates: r1.candidates.map(scale), roi: null, procMs: now() - t0 };
    const r2 = this.detectFull(
      frame,
      { ...ctx, tracking: true, predicted: [r1.detection.x * 2, r1.detection.y * 2], gatePx: Math.max(12, ctx.expectedSizePx * 1.5), noPyramid: true },
      t0,
    );
    const detection = r2.detection ?? { ...scale(r1.detection), candidates: r1.detection.candidates };
    return { ...r2, detection, procMs: now() - t0 };
  }

  private detectFull(frame: SensorFrame, ctx: DetectionContext, t0: number): DetectionResult {
    const W = frame.width;
    const H = frame.height;
    const img = frame.data;

    // 1. ROI
    let x0 = 0;
    let y0 = 0;
    let x1 = W - 1;
    let y1 = H - 1;
    if (ctx.tracking && ctx.predicted) {
      const half = Math.round(Math.max(48, ctx.gatePx + ctx.expectedSizePx * 1.5));
      const [px, py] = ctx.predicted;
      if (px > -half && py > -half && px < W + half && py < H + half) {
        x0 = Math.max(0, Math.floor(px - half));
        y0 = Math.max(0, Math.floor(py - half));
        x1 = Math.min(W - 1, Math.ceil(px + half));
        y1 = Math.min(H - 1, Math.ceil(py + half));
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w < 3 || h < 3) return { detection: null, candidates: [], procMs: now() - t0, roi: [x0, y0, x1, y1], threshold: 0 };
    const n = w * h;
    this.ensure(n, w, h);
    const work = this.work;

    // 2. Copy ROI with impulse repair.
    for (let y = 0; y < h; y++) {
      const gy = y + y0;
      for (let x = 0; x < w; x++) {
        const gx = x + x0;
        const gi = gy * W + gx;
        let v = img[gi];
        if (v >= 250 || v <= 4) {
          // 8-neighbourhood: an extreme pixel with fewer than 3 similar neighbours is
          // an impulse (isolated or paired salt/pepper) → replace by neighbour mean.
          let same = 0;
          let sum = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = gy + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = gx + dx;
              if ((dx === 0 && dy === 0) || xx < 0 || xx >= W) continue;
              const q = img[yy * W + xx];
              if (Math.abs(q - v) <= 12) same++;
              else {
                sum += q;
                cnt++;
              }
            }
          }
          if (same < 3 && cnt > 0) v = sum / cnt;
        }
        work[y * w + x] = v;
      }
    }

    // 3. Integral image → 3×3 box mean.
    const I = this.integ;
    const iw = w + 1;
    for (let x = 0; x <= w; x++) I[x] = 0;
    for (let y = 1; y <= h; y++) {
      let row = 0;
      I[y * iw] = 0;
      for (let x = 1; x <= w; x++) {
        row += work[(y - 1) * w + (x - 1)];
        I[y * iw + x] = I[(y - 1) * iw + x] + row;
      }
    }
    const s = this.smooth;
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - 1);
      const yb = Math.min(h, y + 2);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - 1);
        const xb = Math.min(w, x + 2);
        const sum = I[yb * iw + xb] - I[ya * iw + xb] - I[yb * iw + xa] + I[ya * iw + xa];
        s[y * w + x] = sum / ((yb - ya) * (xb - xa));
      }
    }

    // 4. Robust statistics from a 1/4-grey-level histogram (sampled).
    const hist = new Uint32Array(1024);
    let samples = 0;
    const step = n > 40000 ? 3 : 1;
    for (let i = 0; i < n; i += step) {
      const b = Math.min(1023, Math.max(0, Math.round(s[i] * 4)));
      hist[b]++;
      samples++;
    }
    const median = histQuantile(hist, samples, 0.5) / 4;
    const devHist = new Uint32Array(1024);
    for (let i = 0; i < n; i += step) {
      const b = Math.min(1023, Math.round(Math.abs(s[i] - median) * 4));
      devHist[b]++;
    }
    const mad = histQuantile(devHist, samples, 0.5) / 4;
    const sigma = Math.max(0.35, 1.4826 * mad);
    const useVerifier = !!ctx.verifier && VERIFIER.trained;
    const kSeg = useVerifier ? Math.min(ctx.thresholdSigma, VERIFIER.segmentSigma) : ctx.thresholdSigma;
    let threshold = median + kSeg * sigma;

    // 5. Segmentation (retry with a higher threshold if the ROI is flooded).
    let comps = this.components(w, h, threshold, median, sigma, x0, y0, ctx);
    if (comps === null) {
      threshold = median + kSeg * 2.5 * sigma;
      comps = this.components(w, h, threshold, median, sigma, x0, y0, ctx) ?? [];
    }

    // 6. Selection (optionally rescored by the learned verifier).
    if (useVerifier) {
      for (const c of comps) {
        if (!c.features) continue;
        c.pBeacon = verifierProbability(c.features);
        c.confidence = c.pBeacon;
      }
    }
    const minConf = useVerifier ? VERIFIER.threshold : ctx.minConfidence;
    let best: Candidate | null = null;
    let bestScore = 0;
    for (const c of comps) {
      let score = c.confidence;
      if (ctx.tracking && ctx.predicted) {
        const dx = c.x - ctx.predicted[0];
        const dy = c.y - ctx.predicted[1];
        const d2 = dx * dx + dy * dy;
        const g = ctx.gatePx;
        if (d2 > 6.25 * g * g) continue;
        score *= Math.exp(-d2 / (2 * g * g));
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    comps.sort((a, b) => b.confidence - a.confidence);
    const detection = best && best.confidence >= minConf ? { ...best, candidates: comps.length } : null;
    return { detection, candidates: ctx.collectAll ? comps : comps.slice(0, 6), procMs: now() - t0, roi: [x0, y0, x1, y1], threshold };
  }

  /** Mean smoothed level in a 2-px ring just outside a component's bounding box. */
  private ringMean(w: number, h: number, bx0: number, by0: number, bx1: number, by1: number): number {
    const s = this.smooth;
    const xa = Math.max(0, bx0 - 3);
    const xb = Math.min(w - 1, bx1 + 3);
    const ya = Math.max(0, by0 - 3);
    const yb = Math.min(h - 1, by1 + 3);
    let sum = 0;
    let cnt = 0;
    for (let y = ya; y <= yb; y++) {
      const inY = y >= by0 - 1 && y <= by1 + 1;
      for (let x = xa; x <= xb; x++) {
        if (inY && x >= bx0 - 1 && x <= bx1 + 1) continue;
        sum += s[y * w + x];
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  }

  /** Connected components above threshold; returns null if the ROI is flooded (>20 %). */
  private components(
    w: number,
    h: number,
    thr: number,
    median: number,
    sigma: number,
    ox: number,
    oy: number,
    ctx: DetectionContext,
  ): Candidate[] | null {
    const s = this.smooth;
    const work = this.work;
    const labels = this.labels;
    const stack = this.stack;
    const n = w * h;
    let above = 0;
    for (let i = 0; i < n; i++) {
      if (s[i] > thr) {
        labels[i] = -1;
        above++;
      } else labels[i] = 0;
    }
    if (above > n * 0.2) return null;
    const out: Candidate[] = [];
    const expArea = (ctx.expectedSizePx + 1.5) ** 2;
    let next = 1;
    for (let start = 0; start < n && out.length < 200000; start++) {
      if (labels[start] !== -1) continue;
      const id = next++;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = id;
      let area = 0;
      let sw = 0;
      let swx = 0;
      let swy = 0;
      let swxx = 0;
      let swyy = 0;
      let rawSum = 0;
      let rawPeak = 0;
      let sat = 0;
      let peak = 0;
      let bx0 = w;
      let by0 = h;
      let bx1 = 0;
      let by1 = 0;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % w;
        const y = (i - x) / w;
        area++;
        const wt = Math.max(0, work[i] - median);
        sw += wt;
        swx += wt * (x + 0.5);
        swy += wt * (y + 0.5);
        swxx += wt * (x + 0.5) * (x + 0.5);
        swyy += wt * (y + 0.5) * (y + 0.5);
        rawSum += work[i];
        if (work[i] > rawPeak) rawPeak = work[i];
        if (work[i] >= 250) sat++;
        if (s[i] > peak) peak = s[i];
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        if (x > 0 && labels[i - 1] === -1) {
          labels[i - 1] = id;
          stack[sp++] = i - 1;
        }
        if (x < w - 1 && labels[i + 1] === -1) {
          labels[i + 1] = id;
          stack[sp++] = i + 1;
        }
        if (y > 0 && labels[i - w] === -1) {
          labels[i - w] = id;
          stack[sp++] = i - w;
        }
        if (y < h - 1 && labels[i + w] === -1) {
          labels[i + w] = id;
          stack[sp++] = i + w;
        }
      }
      if (area < 2 || sw <= 0) continue;
      const snr = (peak - median) / sigma;
      const lr = Math.log(area / expArea);
      const sizeScore = Math.exp(-(lr * lr) / (2 * 0.8 * 0.8));
      const snrScore = Math.pow(Math.min(1, Math.max(0, (snr - 6) / 24)), 0.6);
      const confidence = Math.pow(sizeScore, 0.7) * snrScore;
      const cx = swx / sw;
      const cy = swy / sw;
      const raw = { area, expArea, snr, bw: bx1 - bx0 + 1, bh: by1 - by0 + 1, meanRaw: rawSum / area, rawPeak, median, sigma, sat: sat / area, expectedSizePx: ctx.expectedSizePx, box: [bx0, by0, bx1, by1] as const, spread: Math.sqrt(Math.max(0, swxx / sw - cx * cx + swyy / sw - cy * cy)) };
      out.push({
        x: ox + swx / sw,
        y: oy + swy / sw,
        bbox: [ox + bx0, oy + by0, ox + bx1, oy + by1],
        area,
        peak,
        snr,
        sizeScore,
        confidence,
        raw,
      } as Candidate & { raw: typeof raw });
    }
    // Keep the strongest components (integrated signal) — not the first ones in raster
    // order — and compute the verifier features only for those.
    if (out.length > CentroidDetector.MAX_CANDIDATES) {
      out.sort((a, b) => b.snr * Math.sqrt(b.area) - a.snr * Math.sqrt(a.area));
      out.length = CentroidDetector.MAX_CANDIDATES;
    }
    for (const c of out as (Candidate & { raw?: { box: readonly [number, number, number, number] } & Parameters<typeof candidateFeatures>[0] })[]) {
      if (!c.raw) continue;
      const r = c.raw;
      c.features = candidateFeatures({ ...r, ring: this.ringMean(w, h, r.box[0], r.box[1], r.box[2], r.box[3]) });
      delete c.raw;
    }
    return out;
  }
}

/** Copy of an 8-bit image with isolated saturated/black pixels replaced by their neighbours' mean. */
export function repairImpulses(src: Uint8ClampedArray | Uint8Array, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = src[i];
      if (v < 250 && v > 4) continue;
      let same = 0;
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= W) continue;
          const q = src[yy * W + xx];
          if (Math.abs(q - v) <= 12) same++;
          else {
            sum += q;
            cnt++;
          }
        }
      }
      if (same < 3 && cnt > 0) out[i] = sum / cnt;
    }
  }
  return out;
}

/** Feature vector for the learned verifier (order must match verifier_weights.json and the Python port). */
export function candidateFeatures(a: {
  area: number;
  expArea: number;
  snr: number;
  bw: number;
  bh: number;
  meanRaw: number;
  rawPeak: number;
  median: number;
  sigma: number;
  sat: number;
  expectedSizePx: number;
  ring: number;
  spread: number;
}): number[] {
  const contrast = Math.max(1e-3, a.rawPeak - a.median);
  return [
    Math.log(a.area / a.expArea),
    Math.log(Math.max(1, a.snr)),
    Math.log((a.bw * a.bh) / a.area),
    Math.abs(Math.log(a.bw / a.bh)),
    Math.max(-1, Math.min(2, (a.meanRaw - a.median) / contrast)),
    a.sat,
    Math.log(Math.max(1, a.expectedSizePx)),
    Math.max(-5, Math.min(60, (a.ring - a.median) / a.sigma)) / 10,
    Math.log(a.sigma),
    contrast / 255,
    a.spread / Math.sqrt(a.area),
  ];
}

function histQuantile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}
