/**
 * Synthetic focal-plane renderer: produces the 8-bit monochrome image the terminal's
 * camera would record for the current pose. This image is what the image-based
 * detector processes and what the Sensor view displays — it is not a decoration.
 *
 * Contents: sky background (+ atmospheric airlight), catalogue stars, the beacon
 * spot (square / disk / Gaussian, sub-pixel anti-aliased), optional decoy glint,
 * rain streaks, then sensor noise (Gaussian, signal-dependent Poisson, salt & pepper).
 */
import { SimConfig } from '../config';
import { Rng, Vec3, dot } from '../math';
import { DisturbanceState } from '../disturbance/disturbance';
import { PinholeCamera } from './camera';
import { StarCatalog } from './stars';

export interface SensorFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Geometric projection of the beacon (before turbulence wander). */
  truthPx: [number, number] | null;
  /** Where the spot was actually drawn (includes angle-of-arrival wander). */
  spotPx: [number, number] | null;
  spotVisible: boolean;
  spotSizePx: number;
  spotPeak: number;
  decoyPx: [number, number] | null;
  background: number;
}

const NOISE_TABLE_SIZE = 1 << 17;

export class SensorRenderer {
  private buf: Float32Array;
  private out: Uint8ClampedArray;
  private noise: Float32Array;
  private rng: Rng;
  constructor(
    private width: number,
    private height: number,
    seed: number,
  ) {
    this.buf = new Float32Array(width * height);
    this.out = new Uint8ClampedArray(width * height);
    this.rng = new Rng(seed ^ 0x5e45);
    this.noise = new Float32Array(NOISE_TABLE_SIZE);
    for (let i = 0; i < NOISE_TABLE_SIZE; i++) this.noise[i] = this.rng.gauss();
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.buf = new Float32Array(w * h);
    this.out = new Uint8ClampedArray(w * h);
  }

  render(args: {
    cam: PinholeCamera; // actual optical axis (encoder + platform disturbance)
    cfg: SimConfig;
    beaconDir: Vec3;
    decoyDir: Vec3 | null;
    dist: DisturbanceState;
    stars: StarCatalog;
    nominalHfovDeg: number;
  }): SensorFrame {
    const { cam, cfg, beaconDir, decoyDir, dist, stars } = args;
    const W = this.width;
    const H = this.height;
    const buf = this.buf;
    const atm = dist.atm;
    const d = cfg.disturbance;
    const gain = atm.gain;

    // 1. Background: dark sky + airlight.
    const bg = (12 + atm.airlightGrey) * gain;
    buf.fill(bg);

    // 2. Stars (only those near the optical axis are tested in detail).
    const cosLimit = Math.cos(((cam.k.hfovDeg * 0.75) * Math.PI) / 180);
    const f = cam.basis.f;
    for (let i = 0; i < stars.count; i++) {
      const sx = stars.dirs[i * 3];
      const sy = stars.dirs[i * 3 + 1];
      const sz = stars.dirs[i * 3 + 2];
      if (sx * f[0] + sy * f[1] + sz * f[2] < cosLimit) continue;
      const p = cam.project([sx, sy, sz]);
      if (!p) continue;
      const amp = Math.min(70, 70 * Math.pow(10, -0.4 * (stars.mags[i] - 0.5))) * atm.transmission * gain;
      if (amp < 1.5) continue;
      this.splatGaussian(p[0], p[1], 0.75, amp);
    }

    // 3. Beacon spot.
    const truthPx = cam.project(beaconDir);
    const sizeScale = args.nominalHfovDeg / cam.k.hfovDeg;
    const spotSize = Math.max(1.2, cfg.target.spotSizePx * sizeScale * (1 + 0.25 * d.turbulence));
    let spotPx: [number, number] | null = null;
    let peak = 0;
    let visible = false;
    if (truthPx) {
      spotPx = [truthPx[0] + dist.aoaX * sizeScale, truthPx[1] + dist.aoaY * sizeScale];
      const inside = spotPx[0] > -spotSize && spotPx[1] > -spotSize && spotPx[0] < W + spotSize && spotPx[1] < H + spotSize;
      if (inside && !dist.dropout) {
        peak = cfg.target.beaconIntensity * atm.transmission * dist.scint * gain;
        this.drawSpot(spotPx[0], spotPx[1], spotSize, peak, cfg.target.spotShape);
        visible = spotPx[0] >= 0 && spotPx[1] >= 0 && spotPx[0] < W && spotPx[1] < H;
      }
    }

    // 4. Decoy glint: dimmer, smaller, different shape.
    let decoyPx: [number, number] | null = null;
    if (decoyDir) {
      decoyPx = cam.project(decoyDir);
      if (decoyPx && dot(decoyDir, f) > 0) {
        this.drawSpot(decoyPx[0], decoyPx[1], Math.max(1.5, spotSize * 0.4), 0.55 * cfg.target.beaconIntensity * atm.transmission * gain, 'gaussian');
      }
    }

    // 5. Rain streaks.
    for (let s = 0; s < atm.streaks; s++) {
      const x0 = this.rng.uniform(0, W);
      const y0 = this.rng.uniform(0, H);
      const len = this.rng.uniform(15, 45);
      const amp = this.rng.uniform(6, 16) * gain;
      for (let k = 0; k < len; k++) {
        const x = Math.round(x0 + k * 0.25);
        const y = Math.round(y0 + k);
        if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] += amp;
      }
    }

    // 6. Sensor noise → 8-bit.
    const out = this.out;
    const n = W * H;
    const sg = d.gaussianNoise;
    const tab = this.noise;
    const mask = NOISE_TABLE_SIZE - 1;
    let idx = this.rng.int(NOISE_TABLE_SIZE);
    const stride = 1 + 2 * this.rng.int(1000); // odd stride → visits the whole table
    if (d.poisson) {
      const sg2 = sg * sg;
      const kP = 0.45; // photon-transfer gain (grey² per grey level)
      for (let i = 0; i < n; i++) {
        const v = buf[i];
        out[i] = v + Math.sqrt(sg2 + kP * (v > 0 ? v : 0)) * tab[idx];
        idx = (idx + stride) & mask;
      }
    } else if (sg > 0) {
      for (let i = 0; i < n; i++) {
        out[i] = buf[i] + sg * tab[idx];
        idx = (idx + stride) & mask;
      }
    } else {
      for (let i = 0; i < n; i++) out[i] = buf[i];
    }
    if (d.saltPepper > 0) {
      const count = Math.round(d.saltPepper * n);
      for (let k = 0; k < count; k++) {
        out[this.rng.int(n)] = this.rng.next() < 0.5 ? 0 : 255;
      }
    }

    return {
      width: W,
      height: H,
      data: out,
      truthPx,
      spotPx,
      spotVisible: visible,
      spotSizePx: spotSize,
      spotPeak: peak,
      decoyPx,
      background: bg,
    };
  }

  /** Anti-aliased spot. Square uses exact area coverage (separable); disk uses 4×4 supersampling. */
  private drawSpot(cx: number, cy: number, size: number, amp: number, shape: 'square' | 'disk' | 'gaussian') {
    const W = this.width;
    const H = this.height;
    const buf = this.buf;
    if (shape === 'gaussian') {
      this.splatGaussian(cx, cy, size / 2.6, amp, Math.ceil(size * 1.3));
      return;
    }
    const half = size / 2;
    const x0 = Math.max(0, Math.floor(cx - half - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + half + 1));
    const y0 = Math.max(0, Math.floor(cy - half - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + half + 1));
    if (shape === 'square') {
      for (let y = y0; y <= y1; y++) {
        const oy = Math.max(0, Math.min(y + 1, cy + half) - Math.max(y, cy - half));
        if (oy <= 0) continue;
        for (let x = x0; x <= x1; x++) {
          const ox = Math.max(0, Math.min(x + 1, cx + half) - Math.max(x, cx - half));
          if (ox > 0) buf[y * W + x] += amp * ox * oy;
        }
      }
      return;
    }
    const r2 = half * half;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let cov = 0;
        for (let sy = 0; sy < 4; sy++) {
          const py = y + (sy + 0.5) / 4 - cy;
          for (let sx = 0; sx < 4; sx++) {
            const px = x + (sx + 0.5) / 4 - cx;
            if (px * px + py * py <= r2) cov++;
          }
        }
        if (cov) buf[y * W + x] += (amp * cov) / 16;
      }
    }
  }

  private splatGaussian(cx: number, cy: number, sigma: number, amp: number, radius = 2) {
    const W = this.width;
    const H = this.height;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(W - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(H - 1, Math.ceil(cy + radius));
    const inv = 1 / (2 * sigma * sigma);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        this.buf[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) * inv);
      }
    }
  }
}
