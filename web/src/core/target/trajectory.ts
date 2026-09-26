/**
 * Remote-terminal (beacon) motion model.
 *
 * Non-orbital patterns are defined in field coordinates (u, v) — degrees in the
 * tangent plane around the predicted line of sight. The pattern is centred on an
 * "anchor"; when the pattern changes mid-run the anchor glides so the target never
 * teleports. Linear / random / custom motion integrate a state instead.
 *
 * The orbital pattern uses a real circular-orbit pass (geometry.ts). The camera's
 * search is centred on the *predicted* pass, which runs `ephemerisErrorS` behind the
 * true satellite — the classic along-track ephemeris error an acquisition camera
 * has to absorb.
 */
import { SimConfig, TargetConfig } from '../config';
import { Basis, OrbitalPass, azElFromDir, basisFromAzEl, dirFromField, fieldFromDir, slantRangeKm } from '../geometry';
import { DEG, RAD, Rng, Vec3, clamp, hypot2, norm, normalize, sub } from '../math';

export interface TargetTruth {
  t: number;
  dir: Vec3; // unit, ENU
  az: number;
  el: number;
  rangeKm: number;
  posKm: Vec3; // ENU relative to the site
  u: number; // field coordinates relative to the predicted LOS, deg
  v: number;
  uRate: number; // deg/s
  vRate: number;
  angRateDegS: number;
  transverseKmS: number;
  ref: Basis; // predicted line-of-sight basis (search centre)
}

const PASS_START_S = -24; // orbital: run starts 24 s before closest approach

export class TargetModel {
  private rng: Rng;
  private cfg: TargetConfig;
  private sim: SimConfig;
  private t = 0;
  private patternT = 0;
  private anchor: [number, number] = [0, 0];
  private anchorGoal: [number, number] = [0, 0];
  private pos: [number, number] = [0, 0]; // stateful patterns
  private vel: [number, number] = [0, 0];
  private wpIndex = 0;
  private noise: [number, number] = [0, 0];
  private pass: OrbitalPass | null = null;
  private last: TargetTruth | null = null;
  private refFixed: Basis;

  constructor(sim: SimConfig, seed: number) {
    this.sim = sim;
    this.cfg = sim.target;
    this.rng = new Rng(seed ^ 0x51ed27);
    this.refFixed = basisFromAzEl(sim.scene.losAzDeg, sim.scene.losElDeg);
    this.reset();
  }

  get time() {
    return this.t;
  }

  /** Field bounds the target is kept inside (search field minus a margin). */
  private bounds(): [number, number] {
    const l = this.sim.logic;
    return [l.searchHalfUDeg - 0.4, l.searchHalfVDeg - 0.4];
  }

  reset() {
    this.t = 0;
    this.patternT = 0;
    this.wpIndex = 0;
    this.noise = [0, 0];
    this.last = null;
    const [bu, bv] = this.bounds();
    const margin = this.patternExtent();
    let start: [number, number];
    if (this.cfg.startMode === 'fixed') {
      start = [clamp(this.cfg.startUDeg, -bu, bu), clamp(this.cfg.startVDeg, -bv, bv)];
    } else {
      // PS default: random initial location inside the search field.
      start = [this.rng.uniform(-bu, bu), this.rng.uniform(-bv, bv)];
    }
    this.pos = [...start];
    const h = this.cfg.headingDeg * DEG;
    this.vel = [Math.cos(h) * this.cfg.speedDegS, Math.sin(h) * this.cfg.speedDegS];
    const f0 = this.patternOffset(0);
    this.anchor = [start[0] - f0[0], start[1] - f0[1]];
    this.anchorGoal = [clamp(this.anchor[0], -bu + margin, bu - margin), clamp(this.anchor[1], -bv + margin, bv - margin)];
    this.anchor = [...this.anchorGoal];
    this.pass =
      this.cfg.trajectory === 'orbital'
        ? new OrbitalPass(this.sim.scene.altitudeKm, this.sim.scene.passMaxElDeg, this.sim.scene.passHeadingDeg)
        : null;
  }

  /** Change the motion model mid-run without a position jump. */
  setConfig(sim: SimConfig) {
    const prevKind = this.cfg.trajectory;
    const cur = this.last ? [this.last.u, this.last.v] : [...this.pos];
    this.sim = sim;
    this.cfg = sim.target;
    this.refFixed = basisFromAzEl(sim.scene.losAzDeg, sim.scene.losElDeg);
    if (this.cfg.trajectory === 'orbital') {
      if (prevKind !== 'orbital' || !this.pass) {
        this.pass = new OrbitalPass(sim.scene.altitudeKm, sim.scene.passMaxElDeg, sim.scene.passHeadingDeg);
        this.t = 0;
      }
      return;
    }
    this.pass = null;
    this.patternT = 0;
    this.pos = [cur[0], cur[1]];
    const h = this.cfg.headingDeg * DEG;
    this.vel = [Math.cos(h) * this.cfg.speedDegS, Math.sin(h) * this.cfg.speedDegS];
    const f0 = this.patternOffset(0);
    this.anchor = [cur[0] - f0[0], cur[1] - f0[1]];
    const [bu, bv] = this.bounds();
    const m = this.patternExtent();
    this.anchorGoal = [clamp(this.anchor[0], -bu + m, bu - m), clamp(this.anchor[1], -bv + m, bv - m)];
    if (prevKind === 'orbital') this.anchor = [...this.anchorGoal];
  }

  /** Maximum excursion of the current pattern from its anchor, deg. */
  private patternExtent(): number {
    const k = this.cfg.trajectory;
    return k === 'circular' || k === 'sinusoidal' || k === 'figure8' || k === 'spiral' ? this.cfg.amplitudeDeg : 0;
  }

  /** Pattern offset from the anchor at pattern time t (before heading rotation is applied). */
  private patternOffset(t: number): [number, number] {
    const A = this.cfg.amplitudeDeg;
    const w = (2 * Math.PI) / Math.max(0.5, this.cfg.periodS);
    let x = 0;
    let y = 0;
    switch (this.cfg.trajectory) {
      case 'circular':
        x = A * Math.cos(w * t);
        y = A * Math.sin(w * t);
        break;
      case 'sinusoidal':
        x = A * Math.sin(w * t);
        y = 0.45 * A * Math.sin(3 * w * t);
        break;
      case 'figure8':
        x = A * Math.sin(w * t);
        y = 0.6 * A * Math.sin(2 * w * t);
        break;
      case 'spiral': {
        const frac = (t / Math.max(0.5, this.cfg.periodS)) % 1;
        const r = A * (0.15 + 0.85 * (1 - Math.abs(2 * frac - 1)));
        x = r * Math.cos(3 * w * t);
        y = r * Math.sin(3 * w * t);
        break;
      }
      default:
        break;
    }
    const h = this.cfg.headingDeg * DEG;
    return [x * Math.cos(h) - y * Math.sin(h), x * Math.sin(h) + y * Math.cos(h)];
  }

  step(dt: number, noiseDeg: number): TargetTruth {
    this.t += dt;
    this.patternT += dt;
    const k = this.cfg.trajectory;
    const [bu, bv] = this.bounds();

    // Low-pass random perturbation (target motion noise).
    const tau = 0.8;
    const a = Math.exp(-dt / tau);
    const s = noiseDeg * Math.sqrt(1 - a * a);
    this.noise = [a * this.noise[0] + s * this.rng.gauss(), a * this.noise[1] + s * this.rng.gauss()];

    let u = 0;
    let v = 0;
    let ref = this.refFixed;
    let dir: Vec3;
    let rangeKm = this.cfg.rangeKm;

    if (k === 'orbital' && this.pass) {
      const tp = PASS_START_S + this.t;
      const p = this.pass.positionKm(tp);
      const pPred = this.pass.positionKm(tp - this.sim.scene.ephemerisErrorS);
      const pred = azElFromDir(pPred);
      ref = basisFromAzEl(pred.az, pred.el);
      dir = normalize(p);
      rangeKm = norm(p);
      const f = fieldFromDir(ref, dir) ?? { u: 0, v: 0 };
      u = f.u + this.noise[0];
      v = f.v + this.noise[1];
      dir = dirFromField(ref, u, v);
    } else {
      if (k === 'linear') {
        this.pos[0] += this.vel[0] * dt;
        this.pos[1] += this.vel[1] * dt;
        if (Math.abs(this.pos[0]) > bu) {
          this.vel[0] = -Math.sign(this.pos[0]) * Math.abs(this.vel[0]);
          this.pos[0] = clamp(this.pos[0], -bu, bu);
        }
        if (Math.abs(this.pos[1]) > bv) {
          this.vel[1] = -Math.sign(this.pos[1]) * Math.abs(this.vel[1]);
          this.pos[1] = clamp(this.pos[1], -bv, bv);
        }
        u = this.pos[0];
        v = this.pos[1];
      } else if (k === 'random') {
        // Bounded random walk: Ornstein–Uhlenbeck velocity + soft walls.
        const tv = 2.0;
        const av = Math.exp(-dt / tv);
        const sv = this.cfg.speedDegS * Math.sqrt(1 - av * av);
        for (let i = 0; i < 2; i++) {
          const b = i === 0 ? bu : bv;
          let acc = 0;
          if (Math.abs(this.pos[i]) > 0.7 * b) acc = -Math.sign(this.pos[i]) * this.cfg.speedDegS * 1.5;
          this.vel[i] = av * this.vel[i] + sv * this.rng.gauss() + acc * dt;
          this.pos[i] = clamp(this.pos[i] + this.vel[i] * dt, -b, b);
        }
        u = this.pos[0];
        v = this.pos[1];
      } else if (k === 'custom') {
        const wps = this.cfg.waypoints.length >= 2 ? this.cfg.waypoints : [[0, 0] as [number, number], [1, 1] as [number, number]];
        let remaining = this.cfg.speedDegS * dt;
        for (let guard = 0; guard < 8 && remaining > 0; guard++) {
          const goal = wps[this.wpIndex % wps.length];
          const gu = clamp(goal[0], -bu, bu);
          const gv = clamp(goal[1], -bv, bv);
          const d = hypot2(gu - this.pos[0], gv - this.pos[1]);
          if (d <= remaining) {
            this.pos = [gu, gv];
            remaining -= d;
            this.wpIndex++;
          } else {
            this.pos[0] += ((gu - this.pos[0]) / d) * remaining;
            this.pos[1] += ((gv - this.pos[1]) / d) * remaining;
            remaining = 0;
          }
        }
        u = this.pos[0];
        v = this.pos[1];
      } else {
        // Anchored periodic patterns (stationary, circular, sinusoidal, figure-8, spiral).
        const maxGlide = 0.8 * dt; // deg per step
        for (let i = 0; i < 2; i++) {
          const d = this.anchorGoal[i] - this.anchor[i];
          this.anchor[i] += clamp(d, -maxGlide, maxGlide);
        }
        const f = this.patternOffset(this.patternT);
        u = this.anchor[0] + f[0];
        v = this.anchor[1] + f[1];
        this.pos = [u, v];
      }
      u += this.noise[0];
      v += this.noise[1];
      dir = dirFromField(ref, u, v);
      if (this.sim.scene.remote === 'leo') {
        const el = azElFromDir(dir).el;
        rangeKm = slantRangeKm(this.sim.scene.altitudeKm, Math.max(1, el));
      }
    }

    const ae = azElFromDir(dir);
    const posKm: Vec3 = [dir[0] * rangeKm, dir[1] * rangeKm, dir[2] * rangeKm];
    let uRate = 0;
    let vRate = 0;
    let angRate = 0;
    let transverse = 0;
    if (this.last && dt > 0) {
      uRate = (u - this.last.u) / dt;
      vRate = (v - this.last.v) / dt;
      const cosang = Math.min(1, Math.max(-1, dir[0] * this.last.dir[0] + dir[1] * this.last.dir[1] + dir[2] * this.last.dir[2]));
      angRate = (Math.acos(cosang) * RAD) / dt;
      const dp = sub(posKm, this.last.posKm);
      transverse = k === 'orbital' ? norm(dp) / dt : angRate * DEG * rangeKm;
    }
    const truth: TargetTruth = {
      t: this.t,
      dir,
      az: ae.az,
      el: ae.el,
      rangeKm,
      posKm,
      u,
      v,
      uRate,
      vRate,
      angRateDegS: angRate,
      transverseKmS: transverse,
      ref,
    };
    this.last = truth;
    return truth;
  }

  /** Future positions of the current pattern (for drawing the planned path), field deg. */
  previewPath(seconds: number, samples: number): [number, number][] {
    const k = this.cfg.trajectory;
    if (k === 'linear' || k === 'random' || k === 'orbital') return [];
    if (k === 'custom') return this.cfg.waypoints.map(([a, b]) => [a, b]);
    const out: [number, number][] = [];
    for (let i = 0; i <= samples; i++) {
      const f = this.patternOffset(this.patternT + (seconds * i) / samples);
      out.push([this.anchorGoal[0] + f[0], this.anchorGoal[1] + f[1]]);
    }
    return out;
  }
}
