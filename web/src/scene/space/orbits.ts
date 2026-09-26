/**
 * Orbit maths for the visual space traffic: circular orbits at real speed
 * (v = √(μ/r)), laid out so each object repeats a pass over the region the link is
 * looking at. Pure functions (no React), unit-tested in orbits.test.ts.
 */
import * as THREE from 'three';
import { EARTH_CENTER, EARTH_R, azElVec } from '../world';

export const MU = 398600.4418; // km³/s²

/* ------------------------------------------------------------------ orbits ---- */

export interface Pass {
  altKm: number;
  headingDeg: number; // ground-track heading at the pass centre (0 = north, 90 = east)
  offsetKm: number; // cross-track offset of the pass centre from the link's line of sight
  halfArcDeg: number; // pass window ±
  phase: number; // 0..1 start phase within the window
}

const tmpA = new THREE.Vector3();

/** Unit vector (from Earth's centre) of the point on the line of sight at the given altitude. */
function losCentre(out: THREE.Vector3, losAz: number, losEl: number, altKm: number): THREE.Vector3 {
  const d = azElVec(losAz, losEl);
  // |O + s d − C| = R + h with O = 0, C = (0, −R, 0)
  const oc = tmpA.copy(EARTH_CENTER).negate(); // O − C
  const b = oc.dot(d);
  const c = oc.lengthSq() - (EARTH_R + altKm) ** 2;
  const s = -b + Math.sqrt(Math.max(0, b * b - c));
  return out.copy(d).multiplyScalar(s).sub(EARTH_CENTER).normalize();
}

interface PassFrame {
  key: string;
  centre: THREE.Vector3;
  v2: THREE.Vector3;
  r: number;
  half: number;
  period: number;
}
const frames = new WeakMap<Pass, PassFrame>();

/** Index of the repeating pass an object is on at time t. */
export function passIndex(p: Pass, t: number, losAz: number, losEl: number): number {
  const F = passFrame(p, losAz, losEl);
  return Math.floor(t / F.period + p.phase);
}

export function passFrame(p: Pass, losAz: number, losEl: number): PassFrame {
  const key = `${losAz}|${losEl}`;
  const hit = frames.get(p);
  if (hit && hit.key === key) return hit;
  const r = EARTH_R + p.altKm;
  const up = losCentre(new THREE.Vector3(), losAz, losEl, p.altKm);
  const east = new THREE.Vector3(0, 1, 0).cross(up);
  if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
  east.normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  const h = THREE.MathUtils.degToRad(p.headingDeg);
  const along = new THREE.Vector3().addScaledVector(north, Math.cos(h)).addScaledVector(east, Math.sin(h)).normalize();
  const cross = new THREE.Vector3().crossVectors(up, along).normalize();
  const off = p.offsetKm / r;
  const centre = up.clone().multiplyScalar(Math.cos(off)).addScaledVector(cross, Math.sin(off)).normalize();
  const n = new THREE.Vector3().crossVectors(centre, along).normalize(); // orbit normal
  const v2 = new THREE.Vector3().crossVectors(n, centre).normalize();
  const w = Math.sqrt(MU / r) / r; // rad/s, real circular-orbit rate
  const half = THREE.MathUtils.degToRad(p.halfArcDeg);
  const f: PassFrame = { key, centre, v2, r, half, period: (2 * half) / w };
  frames.set(p, f);
  return f;
}

/** Circular-orbit position for a repeating pass, plus the velocity direction; returns a 0..1 fade. */
export function passState(p: Pass, t: number, losAz: number, losEl: number, pos: THREE.Vector3, vel: THREE.Vector3, wrap = true, base = 0): number {
  const F = passFrame(p, losAz, losEl);
  const u = t / F.period + p.phase;
  const f = (((u % 1) + 1) % 1);
  // wrap = false: keep flying the full circular orbit (used while the camera follows it)
  // (base = the pass index at which continuous flight started, so there is no jump)
  const th = -F.half + 2 * F.half * (wrap ? f : u - base);
  const c = Math.cos(th);
  const sn = Math.sin(th);
  pos.copy(F.centre).multiplyScalar(c).addScaledVector(F.v2, sn).multiplyScalar(F.r).add(EARTH_CENTER);
  vel.copy(F.v2).multiplyScalar(c).addScaledVector(F.centre, -sn);
  // fade in/out at the ends of the window so the wrap is never seen
  if (!wrap) return 1;
  return THREE.MathUtils.smoothstep(f, 0, 0.06) * (1 - THREE.MathUtils.smoothstep(f, 0.94, 1));
}

