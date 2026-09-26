/**
 * Scene ↔ physics mapping. Scene units are kilometres and the scene frame IS the
 * terminal's local East-Up-South frame used by the simulation core, with the
 * terminal at the origin (floating origin → full float precision near the terminal).
 * The Earth's centre is therefore at (0, −R, 0).
 */
import * as THREE from 'three';
import { EARTH_RADIUS_KM, dirFromAzEl } from '../core/geometry';

export const EARTH_R = EARTH_RADIUS_KM;
export const EARTH_CENTER = new THREE.Vector3(0, -EARTH_R, 0);
export const MOON_DISTANCE_KM = 384400;
export const MOON_RADIUS_KM = 1737;

/** Rotation taking Earth-fixed geographic coordinates to the site's ENU scene frame. */
export function earthQuaternion(latDeg: number, lonDeg: number): THREE.Quaternion {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  // Geographic object frame: +y north pole, lon 0 on +z, lon 90°E on +x.
  const U = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const E = new THREE.Vector3(Math.cos(lon), 0, -Math.sin(lon));
  const Nn = new THREE.Vector3().crossVectors(U, E);
  const m = new THREE.Matrix4().set(E.x, E.y, E.z, 0, U.x, U.y, U.z, 0, -Nn.x, -Nn.y, -Nn.z, 0, 0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export function azElVec(azDeg: number, elDeg: number, r = 1): THREE.Vector3 {
  const d = dirFromAzEl(azDeg, elDeg);
  return new THREE.Vector3(d[0] * r, d[1] * r, d[2] * r);
}

/** Screen-size-preserving "iconic" scale: real size until the object gets too small. */
export function iconicScale(realSizeKm: number, distanceKm: number, minAngularSize: number): number {
  return Math.max(1, (distanceKm * minAngularSize) / realSizeKm);
}
