/**
 * Site-local geometry.
 *
 * Frame: the terminal's local East-Up-South frame, chosen so it maps 1:1 onto the
 * three.js scene frame (x = East, y = Up, z = South; North = −z).
 *   azimuth   = degrees clockwise from North
 *   elevation = degrees above the local horizon
 *
 * "Field" coordinates (u, v) are gnomonic (tangent-plane) angles, in degrees,
 * around a reference direction (the predicted line of sight): u to the right
 * (increasing azimuth), v upward (increasing elevation).
 */
import { DEG, RAD, Vec3, add, clamp, cross, dot, normalize, scale } from './math';

export const EARTH_RADIUS_KM = 6371;
export const MU_EARTH = 398600.4418; // km³/s²

export function dirFromAzEl(azDeg: number, elDeg: number): Vec3 {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export function azElFromDir(d: Vec3): { az: number; el: number } {
  const n = normalize(d);
  const el = Math.asin(clamp(n[1], -1, 1)) * RAD;
  let az = Math.atan2(n[0], -n[2]) * RAD;
  if (az < 0) az += 360;
  return { az, el };
}

/** Right/up/forward basis of a camera looking along (az, el) with no roll. */
export interface Basis {
  f: Vec3;
  r: Vec3;
  u: Vec3;
}

export function basisFromAzEl(azDeg: number, elDeg: number): Basis {
  const f = dirFromAzEl(azDeg, elDeg);
  // Right vector is the horizontal direction of increasing azimuth; well defined
  // even at zenith because it does not depend on f.
  const a = azDeg * DEG;
  const r: Vec3 = [Math.cos(a), 0, Math.sin(a)];
  const u = cross(r, f);
  return { f, r: normalize(r), u: normalize(u) };
}

/** Direction at gnomonic field offset (uDeg, vDeg) about a basis. */
export function dirFromField(b: Basis, uDeg: number, vDeg: number): Vec3 {
  return normalize(add(add(b.f, scale(b.r, Math.tan(uDeg * DEG))), scale(b.u, Math.tan(vDeg * DEG))));
}

/** Gnomonic field offset of a direction relative to a basis (null if behind). */
export function fieldFromDir(b: Basis, d: Vec3): { u: number; v: number } | null {
  const z = dot(d, b.f);
  if (z <= 1e-9) return null;
  return { u: Math.atan(dot(d, b.r) / z) * RAD, v: Math.atan(dot(d, b.u) / z) * RAD };
}

/**
 * Slant range from a ground site to an object at altitude h seen at elevation el.
 */
export function slantRangeKm(altKm: number, elDeg: number): number {
  const R = EARTH_RADIUS_KM;
  const e = elDeg * DEG;
  return Math.sqrt((R + altKm) ** 2 - (R * Math.cos(e)) ** 2) - R * Math.sin(e);
}

/**
 * Circular-orbit pass over the site. Returns the ENU position (km, relative to the
 * site) at time t (s) where t = 0 is the moment of closest approach.
 *
 * Model: a circular orbit of altitude h whose plane is tilted so that the maximum
 * elevation seen from the site equals `maxElDeg`; the ground track crosses in the
 * horizontal direction `headingDeg`. Earth rotation is neglected (passes last
 * minutes; the error is a small cross-track drift).
 */
export class OrbitalPass {
  readonly omega: number; // rad/s
  readonly speedKmS: number;
  private readonly a: Vec3;
  private readonly b: Vec3;
  private readonly rOrbit: number;
  constructor(
    readonly altKm: number,
    readonly maxElDeg: number,
    readonly headingDeg: number,
  ) {
    const R = EARTH_RADIUS_KM;
    this.rOrbit = R + altKm;
    this.omega = Math.sqrt(MU_EARTH / this.rOrbit ** 3);
    this.speedKmS = this.omega * this.rOrbit;
    // Earth-central angle λ between site and closest-approach point for elevation maxEl:
    // tan(el) = (cos λ − R/r) / sin λ  → solve by bisection on λ ∈ (0, acos(R/r)).
    const k = R / this.rOrbit;
    const target = Math.max(1, Math.min(89.9, maxElDeg)) * DEG;
    let lo = 1e-6;
    let hi = Math.acos(k) - 1e-6;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const el = Math.atan2(Math.cos(mid) - k, Math.sin(mid));
      if (el > target) lo = mid;
      else hi = mid;
    }
    const lambda = (lo + hi) / 2;
    const h = headingDeg * DEG;
    // Along-track horizontal unit vector (ENU) and the cross-track one (to the right of it).
    const along: Vec3 = [Math.sin(h), 0, -Math.cos(h)];
    const crossDir: Vec3 = [Math.cos(h), 0, Math.sin(h)];
    // Earth-centred frame whose axes coincide with site ENU; site at (0, R, 0).
    const up: Vec3 = [0, 1, 0];
    this.a = normalize(add(scale(up, Math.cos(lambda)), scale(crossDir, Math.sin(lambda))));
    this.b = along;
  }
  /** Site-relative ENU position, km. */
  positionKm(t: number): Vec3 {
    const th = this.omega * t;
    const pEc = scale(add(scale(this.a, Math.cos(th)), scale(this.b, Math.sin(th))), this.rOrbit);
    return [pEc[0], pEc[1] - EARTH_RADIUS_KM, pEc[2]];
  }
}
