/** Built-in test stream for the video benchmark (no file needed). */
import { Rng } from '../math';

/** Procedural full-screen test stream with exact ground truth (noise from a pre-computed table). */
const NOISE_N = 1 << 20;
let noiseTable: Float32Array | null = null;
export function syntheticFrame(i: number, fps: number, W: number, H: number, rng: Rng, out: Uint8Array): [number, number] | null {
  if (!noiseTable) {
    const r = new Rng(99);
    noiseTable = new Float32Array(NOISE_N);
    for (let k = 0; k < NOISE_N; k++) noiseTable[k] = r.gauss();
  }
  const tab = noiseTable;
  const t = i / fps;
  const x = W / 2 + 0.33 * W * Math.sin((2 * Math.PI * t) / 5);
  const y = H / 2 + 0.3 * H * Math.sin((2 * Math.PI * t) / 3.3 + 0.7);
  let off = Math.floor(rng.next() * NOISE_N);
  const stride = 1 + 2 * Math.floor(rng.next() * 50);
  for (let p = 0; p < out.length; p++) {
    const g = tab[off];
    off = (off + stride) & (NOISE_N - 1);
    let v = 14 + 12 * g;
    // Salt & pepper (~1 %) from the table's tails.
    if (g > 2.33) v = 255;
    else if (g < -2.33) v = 0;
    out[p] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  const hidden = t >= 3 && t < 3.6; // a passing cloud
  if (hidden) return null;
  const x0 = Math.round(x - 5);
  const y0 = Math.round(y - 5);
  for (let yy = y0; yy < y0 + 10; yy++) for (let xx = x0; xx < x0 + 10; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) out[yy * W + xx] = Math.min(255, out[yy * W + xx] + 220);
  return [x0 + 5, y0 + 5];
}

