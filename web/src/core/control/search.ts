/**
 * Search patterns, in field coordinates (deg) around a centre.
 *
 * Global search: square spiral outward from the predicted line of sight, with step
 * sizes of 85 % of the current FOV so adjacent footprints overlap. When the field is
 * covered the spiral restarts.
 * Reacquisition: the same spiral centred on the Kalman prediction, limited to a few
 * FOVs, because a recently lost target is almost certainly close.
 */
export class SpiralSearch {
  private points: [number, number][] = [];
  private index = 0;
  cycles = 0;

  private limU: number;
  private limV: number;
  constructor(
    private halfU: number,
    private halfV: number,
    private stepU: number,
    private stepV: number,
    private maxRings = 99,
  ) {
    // stepU/V are 85 % of the FOV; the footprint half-width is stepU / 1.7.
    this.limU = Math.max(0, halfU - stepU / 1.7 + 0.1);
    this.limV = Math.max(0, halfV - stepV / 1.7 + 0.1);
    this.build();
  }

  private build() {
    const pts: [number, number][] = [[0, 0]];
    // Square spiral: R, U, L L, D D, R R R, U U U, …
    let x = 0;
    let y = 0;
    let len = 1;
    const dirs = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    let d = 0;
    const nu = Math.ceil(this.halfU / this.stepU);
    const nv = Math.ceil(this.halfV / this.stepV);
    const maxLen = Math.min(2 * Math.max(nu, nv) + 2, 2 * this.maxRings + 2);
    while (len <= maxLen) {
      for (let rep = 0; rep < 2; rep++) {
        for (let k = 0; k < len; k++) {
          x += dirs[d][0];
          y += dirs[d][1];
          if (Math.abs(x) <= nu && Math.abs(y) <= nv) {
            // Clamp so the footprint edge (not the centre) reaches the field edge.
            const p: [number, number] = [
              Math.max(-this.limU, Math.min(this.limU, x * this.stepU)),
              Math.max(-this.limV, Math.min(this.limV, y * this.stepV)),
            ];
            const prev = pts[pts.length - 1];
            if (Math.abs(prev[0] - p[0]) > 1e-6 || Math.abs(prev[1] - p[1]) > 1e-6) pts.push(p);
          }
        }
        d = (d + 1) % 4;
      }
      len++;
    }
    this.points = pts;
    this.index = 0;
  }

  current(): [number, number] {
    return this.points[this.index];
  }

  /** Advance when the camera is within `tol` (deg) of the current waypoint. */
  update(u: number, v: number, tolU: number, tolV: number): [number, number] {
    const [pu, pv] = this.points[this.index];
    if (Math.abs(u - pu) < tolU && Math.abs(v - pv) < tolV) {
      this.index++;
      if (this.index >= this.points.length) {
        this.index = 0;
        this.cycles++;
      }
    }
    return this.points[this.index];
  }

  waypoints() {
    return this.points;
  }

  progress() {
    return this.index / this.points.length;
  }
}
