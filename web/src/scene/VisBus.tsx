/** Copies the latest telemetry into `vis`, smoothing 30 Hz data for 60 fps rendering. */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { live, useApp } from '../state/store';
import { vis } from './vis';
import { iconicScale } from './world';
import { PinholeCamera } from '../core/optics/camera';

const lerpAngle = (a: number, b: number, k: number) => {
  let d = ((b - a + 540) % 360) - 180;
  if (d < -180) d += 360;
  return a + d * k;
};

export function VisBus() {
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), prev: new THREE.Vector3(), cam: null as PinholeCamera | null }), []);
  useFrame((state, dt) => {
    const s = live.snap;
    vis.time = state.clock.elapsedTime;
    const { view, config } = useApp.getState();
    if (s) {
      const k = vis.ready ? 1 - Math.exp(-Math.min(dt, 0.1) * 18) : 1;
      vis.pan = lerpAngle(vis.pan, s.gimbal.pan, k);
      vis.tilt += (s.gimbal.tilt - vis.tilt) * k;
      vis.axisAz = lerpAngle(vis.axisAz, s.gimbal.axisAz, k);
      vis.axisEl += (s.gimbal.axisEl - vis.axisEl) * k;
      vis.dPan = s.gimbal.axisAz - s.gimbal.pan;
      vis.dTilt = s.gimbal.axisEl - s.gimbal.tilt;
      vis.hfov += (s.camera.hfovDeg - vis.hfov) * k;
      vis.vfov += (s.camera.vfovDeg - vis.vfov) * k;
      tmp.v.set(s.target.posKm[0], s.target.posKm[1], s.target.posKm[2]);
      tmp.prev.copy(vis.sat);
      vis.sat.copy(tmp.v); // unsmoothed so the beacon, trails and estimate stay consistent
      if (dt > 0) vis.satVel.copy(vis.sat).sub(tmp.prev).divideScalar(dt);
      if (vis.satVel.lengthSq() < 1e-4) vis.satVel.set(0, 0, 0);
      vis.range += (s.target.rangeKm - vis.range) * k;
      vis.refAz = s.target.refAz;
      vis.refEl = s.target.refEl;
      if (s.state !== vis.state) vis.stateT = vis.time;
      vis.state = s.state;
      vis.linkMargin = s.link.marginDb;
      if (s.kalman.estPx && s.kalman.initialized) {
        if (!tmp.cam) tmp.cam = new PinholeCamera(config.camera);
        tmp.cam.cfg = config.camera;
        tmp.cam.setFov(s.camera.hfovDeg);
        tmp.cam.setPose(s.gimbal.pan, s.gimbal.tilt);
        const d = tmp.cam.unproject(s.kalman.estPx[0], s.kalman.estPx[1]);
        if (!vis.est) vis.est = new THREE.Vector3();
        vis.est.set(d[0], d[1], d[2]);
      } else vis.est = null;
      vis.ready = true;
    }
    const cam = state.camera.position;
    vis.camDistTerminal = cam.length();
    const pov = view === 'sensor';
    const follow = view === 'follow'; // close to another spacecraft: keep the others small
    vis.terminalScale = iconicScale(0.0075, vis.camDistTerminal, view === 'orbit' ? 0.016 : follow ? 0.012 : 0.05);
    vis.satScale = view === 'link' ? 1 : iconicScale(0.0105, cam.distanceTo(vis.sat), pov ? 0.008 : follow ? 0.014 : 0.06);
    vis.pov = pov;
    vis.view = view;
  }, -2);
  return null;
}
