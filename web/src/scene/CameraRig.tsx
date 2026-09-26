/**
 * Viewpoint presets. "sensor" puts the 3D camera at the terminal's lens with the
 * terminal camera's true FOV — the 3D equivalent of the sensor feed.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CameraControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useApp } from '../state/store';
import { vis } from './vis';
import { EARTH_CENTER, EARTH_R } from './world';
import { basisFromAzEl } from '../core/geometry';
import { SUN_DIR } from './models/Satellite';
import { spaceBodies } from './space/SpaceObjects';

const UP = new THREE.Vector3(0, 1, 0);

/** Imperative handle used by the on-screen zoom buttons and keyboard (+ / −). */
export const cameraApi = {
  zoom: (_factor: number) => {},
};

export function CameraRig() {
  const ref = useRef<CameraControls>(null);
  const view = useApp((s) => s.view);
  const nonce = useApp((s) => s.viewNonce);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const hud = useRef({ at: 0, right: 414, bottom: 250 });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const S = vis.sat.clone();
    if (S.lengthSq() < 1) S.set(-300, 500, -600);
    const l = S.clone().normalize();
    const side = new THREE.Vector3().crossVectors(l, UP).normalize();
    const lh = new THREE.Vector3(l.x, 0, l.z).normalize();
    const R = S.length();
    // In sensor POV the orbit controls are disabled and the pose is set directly each frame.
    // Sensor POV and the spacecraft chase camera set the pose directly every frame.
    // Spacecraft and fly-to views stay user-controllable: the orbit target travels with the craft.
    c.enabled = view !== 'sensor';
    // Around a spacecraft, zoom straight towards it (towards the cursor it would slide off screen).
    c.dollyToCursor = view !== 'link' && view !== 'follow';
    c.minDistance = 0.003;
    if (view !== 'sensor') {
      camera.fov = 42;
      camera.updateProjectionMatrix();
      camera.up.set(0, 1, 0);
      c.updateCameraUp();
    }
    let pos: THREE.Vector3 | null = null;
    let tgt: THREE.Vector3 | null = null;
    switch (view) {
      case 'overview':
        {
          // Look at the middle of the link from the side, just far enough that terminal and
          // satellite both fit inside the part of the screen not covered by the HUD.
          const fracV = Math.max(0.3, (size.height - hud.current.bottom - 100) / size.height);
          const fracH = Math.max(0.3, (size.width - hud.current.right - 66) / size.width);
          const halfV = THREE.MathUtils.degToRad(42 / 2) * fracV;
          const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(21)) * (size.width / size.height)) * fracH;
          const d = (0.56 * R) / Math.sin(Math.min(halfV, halfH));
          const dir = side.clone().multiplyScalar(-1).addScaledVector(UP, 0.12).addScaledVector(lh, -0.12).normalize();
          tgt = S.clone().multiplyScalar(0.5);
          pos = tgt.clone().addScaledVector(dir, d);
        }
        break;
      case 'terminal':
        pos = new THREE.Vector3().addScaledVector(side, -0.019).addScaledVector(UP, 0.0075).addScaledVector(lh, -0.012);
        tgt = new THREE.Vector3(0, 0.0036, 0).addScaledVector(lh, 0.0015);
        break;
      case 'link':
      case 'follow':
        // Initial pose is set in the tracking frame hook (the craft's position is known there).
        chase.current.init = false;
        if (nonce > 0) useApp.getState().notify('Drag to look around the spacecraft · scroll to zoom · the camera travels with it', 5000);
        break;
      case 'orbit': {
        const sunH = new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z).normalize();
        const dir = UP.clone().multiplyScalar(0.8).addScaledVector(sunH, 0.5).addScaledVector(side, -0.25).normalize();
        pos = EARTH_CENTER.clone().addScaledVector(dir, EARTH_R + 17000);
        tgt = EARTH_CENTER.clone().addScaledVector(UP, EARTH_R * 0.55);
        break;
      }
      default:
        break;
    }
    // The spacecraft moves at 7.5 km/s: jump straight to it instead of animating.
    if (pos && tgt) c.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, nonce > 0 && view !== 'link');
    // size is read by value: its object is replaced every few frames, which used to reset the camera
  }, [view, nonce, camera, size.width, size.height]);

  const lastSat = useRef<THREE.Vector3 | null>(null);
  const chase = useRef({ init: false, key: '', last: new THREE.Vector3(), r: new THREE.Vector3(), v: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), t: new THREE.Vector3() });
  const tmpP = useRef(new THREE.Vector3());
  const tmpT = useRef(new THREE.Vector3());
  // Spacecraft / fly-to views: the user orbits and zooms freely with the mouse; the orbit
  // target is carried along with the spacecraft (7.5 km/s) every frame. Runs before
  // CameraControls.update (priority −1) so the camera is placed from this frame's position.
  useFrame(() => {
    const c = ref.current;
    if (!c || (view !== 'link' && view !== 'follow')) return;
    const key = view === 'link' ? 'main' : useApp.getState().followKey;
    const body = view === 'link' ? { pos: vis.sat, vel: vis.satVel, sizeKm: 0.0077 } : spaceBodies[key];
    if (!body) return;
    const ch = chase.current;
    const jumped = ch.init && body.pos.distanceTo(ch.last) > 50; // e.g. a new LEO pass started
    if (!ch.init || ch.key !== key || jumped) {
      // Start facing the solar wings' cells, three-quarter on. Every craft is nadir-pointed
      // (body y = radial, z = along-track) and its wings turn about body x towards the Sun,
      // so the cells face the Sun's direction projected onto the body y–z plane.
      ch.r.copy(body.pos).sub(EARTH_CENTER).normalize();
      ch.v.copy(body.vel);
      if (ch.v.lengthSq() < 1e-8) ch.v.set(0, 0, -1);
      ch.t.crossVectors(ch.r, ch.v); // body x (wing axis)
      if (ch.t.lengthSq() < 1e-8) ch.t.set(1, 0, 0);
      ch.t.normalize();
      ch.c.copy(SUN_DIR).addScaledVector(ch.t, -SUN_DIR.dot(ch.t)); // wing normal
      if (ch.c.lengthSq() < 1e-6) ch.c.copy(ch.r);
      ch.c.normalize();
      // Stand along-track on the cells' side, a little above (Earth's limb in view), then
      // turn three-quarter on towards the wing axis.
      ch.v.addScaledVector(ch.r, -ch.v.dot(ch.r)).normalize();
      const side = ch.c.dot(ch.v) >= 0 ? 1 : -1;
      const D = view === 'link' ? 0.02 : body.sizeKm * 2.6;
      ch.c.copy(ch.v).multiplyScalar(side * Math.cos(0.3)).addScaledVector(ch.r, Math.sin(0.3)).normalize();
      ch.p.copy(ch.c).multiplyScalar(Math.cos(0.6) * D).addScaledVector(ch.t, Math.sin(0.6) * D);
      c.minDistance = view === 'link' ? 0.0045 : Math.max(0.004, body.sizeKm * 0.55); // not inside the craft
      camera.up.copy(ch.r);
      c.updateCameraUp();
      const eye = body.pos.clone().add(ch.p);
      const tgt = body.pos.clone();
      c.setLookAt(eye.x, eye.y, eye.z, tgt.x, tgt.y, tgt.z, false);
      ch.last.copy(body.pos);
      ch.init = true;
      ch.key = key;
      return;
    }
    // Carry the orbit target (and so the camera) along with the craft; the user's
    // rotation, zoom and pan are kept.
    ch.p.copy(body.pos).sub(ch.last);
    if (ch.p.lengthSq() > 0) {
      c.getTarget(ch.t);
      ch.t.add(ch.p);
      c.moveTo(ch.t.x, ch.t.y, ch.t.z, false);
    }
    ch.last.copy(body.pos);
  }, -1.5);

  useFrame(() => {
    // Follow the moving remote terminal in the views that are framed on it.
    let follow = view === 'overview' ? 0.5 : 0;
    if (view === 'free' && ref.current && lastSat.current) {
      // Free camera parked next to the spacecraft keeps up with it (7.5 km/s).
      ref.current.getTarget(tmpT.current);
      if (tmpT.current.distanceTo(lastSat.current) < 0.5) follow = 1;
    }
    if (lastSat.current && follow > 0 && ref.current) {
      const d = vis.sat.clone().sub(lastSat.current).multiplyScalar(follow);
      if (d.lengthSq() > 1e-10 && d.length() < 200) {
        ref.current.getPosition(tmpP.current);
        ref.current.getTarget(tmpT.current);
        tmpP.current.add(d);
        tmpT.current.add(d);
        ref.current.setLookAt(tmpP.current.x, tmpP.current.y, tmpP.current.z, tmpT.current.x, tmpT.current.y, tmpT.current.z, false);
      }
    }
    lastSat.current = vis.sat.clone();
    // Shift the principal point to the centre of the area not covered by the HUD
    // (left tool rail, right sensor column, bottom dock) so the scene is framed there.
    if (view !== 'sensor') {
      // Measure the HUD occasionally (it is responsive) and centre the scene in the free area.
      const now = performance.now();
      if (now - hud.current.at > 500) {
        const rc = document.querySelector('.rightcol')?.getBoundingClientRect();
        const dk = document.querySelector('.dock')?.getBoundingClientRect();
        hud.current = { at: now, right: rc ? size.width - rc.left : 414, bottom: dk ? size.height - dk.top : 250 };
      }
      const ox = Math.round((hud.current.right - 66) / 2);
      const oy = Math.round((hud.current.bottom - 100) / 2);
      const v = camera.view;
      if (!v || !v.enabled || v.offsetX !== ox || v.offsetY !== oy || v.fullWidth !== size.width || v.fullHeight !== size.height) {
        camera.setViewOffset(size.width, size.height, ox, oy, size.width, size.height);
      }
      return;
    }
    if (camera.view?.enabled) camera.clearViewOffset();
    // Sensor POV: the 3D camera sits just in front of the terminal's lens, looks along
    // the actual optical axis and uses the terminal camera's vertical FOV.
    const b = basisFromAzEl(vis.axisAz, vis.axisEl);
    const f = new THREE.Vector3(...b.f);
    camera.position.copy(vis.lens).addScaledVector(f, 0.0012);
    camera.up.set(...b.u);
    camera.lookAt(camera.position.clone().add(f));
    camera.updateMatrixWorld();
    if (Math.abs(camera.fov - vis.vfov) > 1e-3) {
      camera.fov = vis.vfov;
      camera.updateProjectionMatrix();
    }
  }, -1);

  useEffect(() => {
    cameraApi.zoom = (factor: number) => {
      const c = ref.current;
      if (!c) return;
      if (useApp.getState().view === 'sensor') return;
      c.dollyTo(Math.max(c.minDistance, Math.min(c.maxDistance, c.distance * factor)), true);
    };
  }, []);

  useEffect(() => {
    // Test/debug handle (used by the automated UI checks in TEST_REPORT.md).
    (window as unknown as { __ASTRAQ_CAM__: unknown }).__ASTRAQ_CAM__ = { camera, controls: ref };
  }, [camera]);
  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={0.003}
      maxDistance={120000}
      dollySpeed={1.6}
      dollyToCursor
      smoothTime={0.28}
      draggingSmoothTime={0.1}
      onStart={() => {
        const st = useApp.getState();
        // Overview/Terminal/Orbit become a free camera once the user moves it; the
        // spacecraft and fly-to views stay attached to their craft while being explored.
        if (st.view !== 'free' && st.view !== 'sensor' && st.view !== 'link' && st.view !== 'follow') st.set({ view: 'free' });
      }}
    />
  );
}
