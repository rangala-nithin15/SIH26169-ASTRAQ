import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MU, passFrame, passIndex, passState, type Pass } from './orbits';
import { EARTH_CENTER, EARTH_R, azElVec } from '../world';

const ISS: Pass = { altKm: 420, headingDeg: 58, offsetKm: 260, halfArcDeg: 20, phase: 0.1 };

describe('space traffic orbits (visual layer)', () => {
  it('stays on a circular orbit at the stated altitude', () => {
    const pos = new THREE.Vector3();
    const vel = new THREE.Vector3();
    for (let t = 0; t < 600; t += 37) {
      passState(ISS, t, 210, 38, pos, vel);
      expect(pos.distanceTo(EARTH_CENTER) - EARTH_R).toBeCloseTo(420, 6);
      // velocity is tangential
      expect(Math.abs(vel.dot(pos.clone().sub(EARTH_CENTER).normalize()))).toBeLessThan(1e-9);
    }
  });

  it('moves at the real circular-orbit speed √(μ/r)', () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const v = new THREE.Vector3();
    passState(ISS, 100, 210, 38, a, v, false);
    passState(ISS, 101, 210, 38, b, v, false);
    const expected = Math.sqrt(MU / (EARTH_R + 420)); // ≈ 7.66 km/s
    expect(a.distanceTo(b)).toBeGreaterThan(expected * 0.999);
    expect(a.distanceTo(b)).toBeLessThan(expected * 1.001);
  });

  it('centres each pass near the link line of sight, offset sideways as configured', () => {
    const F = passFrame({ ...ISS, offsetKm: 0 }, 210, 38);
    const centre = F.centre.clone().multiplyScalar(F.r).add(EARTH_CENTER);
    // the pass centre lies on the line of sight from the terminal
    const dir = centre.clone().normalize();
    expect(dir.angleTo(azElVec(210, 38))).toBeLessThan(1e-6);
  });

  it('fades in and out at the ends of the repeating window, and not when followed', () => {
    const pos = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const F = passFrame(ISS, 210, 38);
    const tStart = (1 - ISS.phase) * F.period; // window wraps here
    expect(passState(ISS, tStart + 0.001, 210, 38, pos, vel)).toBeLessThan(0.05);
    expect(passState(ISS, tStart + F.period / 2, 210, 38, pos, vel)).toBeCloseTo(1, 6);
    expect(passState(ISS, tStart + 0.001, 210, 38, pos, vel, false)).toBe(1);
  });

  it('switching a spacecraft to continuous flight (fly-to) does not make it jump', () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (const t of [30, 777, 5000]) {
      passState(ISS, t, 210, 38, a, v, true);
      passState(ISS, t, 210, 38, b, v, false, passIndex(ISS, t, 210, 38));
      expect(a.distanceTo(b)).toBeLessThan(1e-6);
    }
  });
});
