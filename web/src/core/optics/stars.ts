/**
 * Procedural star catalogue shared by the 3D sky and the sensor renderer, so a star
 * seen in the 3D view is the same star that can appear (dimly) in the camera frame.
 *
 * Directions are in the site ENU frame (Earth rotation is ignored over a run).
 * Magnitudes follow the observed growth N(<m) ∝ 10^(0.45 m); a band of extra
 * density imitates the Milky Way.
 */
import { Rng, Vec3, cross, normalize } from '../math';

export interface StarCatalog {
  count: number;
  dirs: Float32Array; // xyz triplets
  mags: Float32Array;
  temps: Float32Array; // colour index 0 (blue) … 1 (red)
}

export function makeStarCatalog(seed = 7, count = 6000): StarCatalog {
  const rng = new Rng(seed);
  const dirs = new Float32Array(count * 3);
  const mags = new Float32Array(count);
  const temps = new Float32Array(count);
  const galPole = normalize([0.35, 0.55, 0.76]);
  const e1 = normalize(cross(galPole, [0, 1, 0]));
  const e2 = cross(galPole, e1);
  const mMin = -1.2;
  const mMax = 7.5;
  const k = 0.45 * Math.LN10;
  const cMin = Math.exp(k * mMin);
  const cMax = Math.exp(k * mMax);
  for (let i = 0; i < count; i++) {
    let d: Vec3;
    if (rng.next() < 0.42) {
      // Galactic band: around the great circle ⟂ galPole, gaussian thickness.
      const phi = rng.uniform(0, Math.PI * 2);
      const b = rng.gauss() * 0.16;
      d = normalize([
        (e1[0] * Math.cos(phi) + e2[0] * Math.sin(phi)) * Math.cos(b) + galPole[0] * Math.sin(b),
        (e1[1] * Math.cos(phi) + e2[1] * Math.sin(phi)) * Math.cos(b) + galPole[1] * Math.sin(b),
        (e1[2] * Math.cos(phi) + e2[2] * Math.sin(phi)) * Math.cos(b) + galPole[2] * Math.sin(b),
      ]);
    } else {
      const z = rng.uniform(-1, 1);
      const phi = rng.uniform(0, Math.PI * 2);
      const r = Math.sqrt(1 - z * z);
      d = [r * Math.cos(phi), z, r * Math.sin(phi)];
    }
    dirs[i * 3] = d[0];
    dirs[i * 3 + 1] = d[1];
    dirs[i * 3 + 2] = d[2];
    const c = cMin + rng.next() * (cMax - cMin);
    mags[i] = Math.log(c) / k;
    temps[i] = Math.min(1, Math.max(0, 0.45 + 0.28 * rng.gauss()));
  }
  return { count, dirs, mags, temps };
}
