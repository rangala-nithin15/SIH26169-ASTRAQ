/**
 * Pinhole model of the terminal's optical camera.
 *
 * The camera is carried by the pan/tilt gimbal: pan = azimuth of the optical axis,
 * tilt = elevation. Roll is zero (a yoke gimbal cannot roll). Pixel (0,0) is the
 * top-left corner; the principal point is the image centre.
 */
import { CameraConfig, intrinsics } from '../config';
import { Basis, basisFromAzEl } from '../geometry';
import { Vec3, add, dot, normalize, scale, RAD } from '../math';

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  hfovDeg: number;
  vfovDeg: number;
  ifovDeg: number;
  focalMm: number;
}

export class PinholeCamera {
  basis: Basis;
  k: Intrinsics;
  constructor(
    public cfg: CameraConfig,
    public panDeg = 0,
    public tiltDeg = 0,
    hfovDeg = cfg.hfovDeg,
  ) {
    this.k = intrinsics(cfg, hfovDeg);
    this.basis = basisFromAzEl(panDeg, tiltDeg);
  }

  setPose(panDeg: number, tiltDeg: number) {
    this.panDeg = panDeg;
    this.tiltDeg = tiltDeg;
    this.basis = basisFromAzEl(panDeg, tiltDeg);
  }

  setFov(hfovDeg: number) {
    this.k = intrinsics(this.cfg, hfovDeg);
  }

  /** Project a unit direction to pixel coordinates. Null if behind the camera. */
  project(d: Vec3): [number, number] | null {
    const { f, r, u } = this.basis;
    const z = dot(d, f);
    if (z <= 1e-9) return null;
    return [this.k.cx + (this.k.fx * dot(d, r)) / z, this.k.cy - (this.k.fy * dot(d, u)) / z];
  }

  /** Back-project a pixel into a unit direction (the pixel's line of sight). */
  unproject(px: number, py: number): Vec3 {
    const { f, r, u } = this.basis;
    return normalize(add(add(f, scale(r, (px - this.k.cx) / this.k.fx)), scale(u, -(py - this.k.cy) / this.k.fy)));
  }

  inFrame(p: [number, number] | null, margin = 0): boolean {
    return !!p && p[0] >= -margin && p[1] >= -margin && p[0] < this.cfg.width + margin && p[1] < this.cfg.height + margin;
  }

  /**
   * Angular error of a direction relative to the optical axis, measured in the
   * camera frame: ex > 0 → target right of centre, ey > 0 → target above centre.
   */
  angularError(d: Vec3): { ex: number; ey: number } | null {
    const { f, r, u } = this.basis;
    const z = dot(d, f);
    if (z <= 1e-9) return null;
    return { ex: Math.atan(dot(d, r) / z) * RAD, ey: Math.atan(dot(d, u) / z) * RAD };
  }
}
