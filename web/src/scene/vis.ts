/**
 * Per-frame visual state derived from the latest snapshot, smoothed for 60 fps
 * rendering of 30 Hz telemetry. Updated once per animation frame by <VisBus/>;
 * every scene component reads it inside its own useFrame.
 */
import * as THREE from 'three';
import type { TrackState } from '../core/telemetry/types';

export const vis = {
  ready: false,
  pan: 0,
  tilt: 0,
  axisAz: 0,
  axisEl: 0,
  dPan: 0,
  dTilt: 0,
  hfov: 4,
  vfov: 3,
  sat: new THREE.Vector3(0, 500, -500),
  beacon: new THREE.Vector3(0, 500, -500),
  satVel: new THREE.Vector3(),
  range: 780,
  refAz: 0,
  refEl: 0,
  state: 'IDLE' as TrackState,
  stateT: 0,
  lens: new THREE.Vector3(0, 0.0065, 0),
  terminalScale: 1,
  satScale: 1,
  camDistTerminal: 1,
  linkMargin: 0,
  est: null as THREE.Vector3 | null,
  pov: false,
  view: 'overview' as string,
  time: 0,
};

export const TERMINAL_HEADING_DEG = 150;
