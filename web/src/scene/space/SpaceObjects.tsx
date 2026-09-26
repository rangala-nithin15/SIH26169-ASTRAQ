/**
 * Space environment: other traffic and natural objects around the link.
 *
 * Purely visual. None of these objects enter the simulated sensor image or the
 * tracking loop (the sensor frame is rendered by the simulation core), so they cannot
 * change any measured result. They make the scene read like real near-Earth space:
 *
 *  - SAT-2, an Earth-observation satellite (700 km, near-polar pass)
 *  - SAT-3, a data-relay satellite with two reflectors and an optical ISL terminal (1,100 km)
 *  - the International Space Station (420 km)
 *  - meteors in the upper atmosphere, auroral ovals at both poles, and the Andromeda
 *    galaxy and Magellanic Clouds
 *
 * Orbital speeds are real (v = √(μ/r)); each spacecraft repeats a pass over the region
 * the link is looking at, so the traffic stays in view. Deep-sky positions are
 * approximate (no sidereal time) — the View drawer says so.
 */
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { makeMaterials } from '../models/materials';
import { vis } from '../vis';
import { EARTH_CENTER, EARTH_R, azElVec, earthQuaternion, iconicScale } from '../world';
import { passIndex, passState, type Pass } from './orbits';
import { useApp } from '../../state/store';
import { NOISE_GLSL } from '../shaders/noise';
import { SUN_DIR as SUN } from '../models/Satellite';

type M = ReturnType<typeof makeMaterials>;
/** Orient a body: +y radial (zenith), +z along-track. */
const oy = new THREE.Vector3();
const oz = new THREE.Vector3();
const ox = new THREE.Vector3();
const om = new THREE.Matrix4();
function orient(q: THREE.Quaternion, pos: THREE.Vector3, vel: THREE.Vector3) {
  oy.copy(pos).sub(EARTH_CENTER).normalize();
  oz.copy(vel);
  ox.crossVectors(oy, oz).normalize();
  oz.crossVectors(ox, oy).normalize();
  q.setFromRotationMatrix(om.makeBasis(ox, oy, oz));
}

/** Shared per-frame driver for a pass-flying object. */
function usePassDriver(pass: Pass, realSizeKm: number, minAng: number, labelKey: string | null) {
  const root = useRef<THREE.Group>(null);
  const st = useMemo(() => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), base: -1 }), []);
  useFrame((state) => {
    const g = root.current;
    if (!g) return;
    const { config, view, followKey } = useApp.getState();
    const followed = view === 'follow' && followKey === labelKey;
    const t = state.clock.elapsedTime;
    if (followed && st.base < 0) st.base = passIndex(pass, t, config.scene.losAzDeg, config.scene.losElDeg);
    if (!followed) st.base = -1;
    const fade = passState(pass, t, config.scene.losAzDeg, config.scene.losElDeg, st.pos, st.vel, !followed, Math.max(0, st.base));
    g.position.copy(st.pos);
    if (labelKey) {
      const b = (spaceBodies[labelKey] ??= { pos: new THREE.Vector3(), vel: new THREE.Vector3(), sizeKm: realSizeKm });
      b.pos.copy(st.pos);
      b.vel.copy(st.vel);
    }
    orient(st.q, st.pos, st.vel);
    g.quaternion.copy(st.q);
    const d = state.camera.position.distanceTo(st.pos);
    const sc = (followed ? 1 : iconicScale(realSizeKm, d, vis.pov ? minAng * 0.15 : minAng)) * 0.001 * fade;
    g.scale.setScalar(Math.max(sc, 1e-9));
    g.visible = fade > 0.01;
    if (labelKey) {
      const a = (spaceAnchors[labelKey] ??= new THREE.Vector3());
      a.copy(st.pos).sub(EARTH_CENTER).normalize().multiplyScalar(realSizeKm * 0.6 * (sc / 0.001)).add(st.pos);
      anchorOn[labelKey] = g.visible && fade > 0.3;
    }
  }, -3); // before the camera rig, so a following camera sees this frame's position
  return root;
}

/** Label anchors for the space objects (read by the label projector). */
export const spaceAnchors: Record<string, THREE.Vector3> = {};
export const anchorOn: Record<string, boolean> = {};
/** Current position and velocity direction of each named body (read by the follow camera). */
export const spaceBodies: Record<string, { pos: THREE.Vector3; vel: THREE.Vector3; sizeKm: number }> = {};
export const SPACE_TAGS = [
  { key: 'iss', title: 'ISS', sub: '420 km · crewed station' },
  { key: 'sat2', title: 'SAT-2', sub: 'Earth observation · 700 km' },
  { key: 'sat3', title: 'SAT-3', sub: 'Data relay · 1,100 km' },
] as const;

/* --------------------------------------------------------------- materials ---- */

function useExtraMaterials() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const x = c.getContext('2d')!;
    x.fillStyle = '#5a3312';
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 8; j++) {
        const v = 0.85 + ((i * 7 + j * 13) % 5) * 0.04;
        x.fillStyle = `rgb(${Math.round(176 * v)},${Math.round(98 * v)},${Math.round(38 * v)})`;
        x.fillRect(i * 16 + 1, j * 32 + 1, 14, 30);
      }
    const arr = new THREE.CanvasTexture(c);
    arr.colorSpace = THREE.SRGBColorSpace;
    arr.wrapS = arr.wrapT = THREE.RepeatWrapping;
    return {
      issArray: new THREE.MeshStandardMaterial({ map: arr, metalness: 0.4, roughness: 0.35, side: THREE.DoubleSide, envMapIntensity: 1.3 }),
      module: new THREE.MeshStandardMaterial({ color: '#e9e6df', metalness: 0.2, roughness: 0.6 }),
    };
  }, []);
}

function dishGeometry(r: number, f: number, seg = 40) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const x = (i / 16) * r;
    pts.push(new THREE.Vector2(x, (x * x) / (4 * f)));
  }
  return new THREE.LatheGeometry(pts, seg);
}

/* ----------------------------------------------------------------- SAT-2 ---- */

/** Earth-observation satellite: hexagonal bus, one large sun-tracking array, nadir imager. */
function EOSat({ m }: { m: M }) {
  const root = usePassDriver({ altKm: 700, headingDeg: 172, offsetKm: -320, halfArcDeg: 18, phase: 0.35 }, 0.009, 0.028, 'sat2');
  const wing = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!wing.current || !root.current) return;
    const s = SUN.clone().applyQuaternion(root.current.quaternion.clone().invert());
    wing.current.rotation.x = Math.atan2(s.z, s.y);
  });
  const xband = useMemo(() => dishGeometry(0.28, 0.2), []);
  return (
    <group ref={root} userData={{ measure: 'obj:sat2', measureName: 'SAT-2 (Earth observation)' }}>
      <mesh material={m.gold} rotation={[0, Math.PI / 6, 0]}>
        <cylinderGeometry args={[0.9, 0.9, 1.9, 6]} />
      </mesh>
      <mesh material={m.silverFoil} position={[0, 0.96, 0]} rotation={[0, Math.PI / 6, 0]}>
        <cylinderGeometry args={[0.86, 0.86, 0.03, 6]} />
      </mesh>
      {/* imager: telescope barrel + baffle on the nadir deck */}
      <group position={[0, -1.25, 0]}>
        <mesh material={m.whitePaint}>
          <cylinderGeometry args={[0.42, 0.42, 0.7, 32]} />
        </mesh>
        <mesh material={m.blackAnod} position={[0, -0.45, 0]}>
          <cylinderGeometry args={[0.46, 0.42, 0.22, 32, 1, true]} />
        </mesh>
        <mesh material={m.lens} position={[0, -0.36, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.38, 32]} />
        </mesh>
      </group>
      {/* X-band downlink dish */}
      <mesh geometry={xband} material={m.whitePaint} position={[0.55, -1.0, 0.45]} rotation={[Math.PI, 0, 0]} />
      {/* star trackers */}
      {[-0.35, 0.35].map((z) => (
        <mesh key={z} material={m.blackAnod} position={[0.6, 0.9, z]} rotation={[0.4, 0, -0.5]}>
          <cylinderGeometry args={[0.07, 0.09, 0.24, 14, 1, true]} />
        </mesh>
      ))}
      {/* single wing on −x, three panels */}
      <group position={[-0.8, 0.25, 0]}>
        <mesh material={m.darkMetal} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.1, 0.1, 0.2, 16]} />
        </mesh>
        <group ref={wing}>
          <mesh material={m.frame} position={[-0.4, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.03, 0.03, 0.7, 8]} />
          </mesh>
          {[0, 1, 2].map((i) => (
            <group key={i} position={[-1.65 - i * 1.9, 0, 0]}>
              <mesh material={m.cells2} position={[0, 0.012, 0]}>
                <boxGeometry args={[1.85, 0.014, 1.5]} />
              </mesh>
              <mesh material={m.panelBack2} position={[0, -0.006, 0]}>
                <boxGeometry args={[1.85, 0.02, 1.5]} />
              </mesh>
            </group>
          ))}
        </group>
      </group>
    </group>
  );
}

/* ----------------------------------------------------------------- SAT-3 ---- */

/** Data-relay satellite: large box bus, two 4-panel wings, two reflectors, optical ISL head. */
function RelaySat({ m }: { m: M }) {
  const root = usePassDriver({ altKm: 1100, headingDeg: 292, offsetKm: 520, halfArcDeg: 16, phase: 0.72 }, 0.016, 0.032, 'sat3');
  const wings = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  useFrame(() => {
    if (!root.current) return;
    const s = SUN.clone().applyQuaternion(root.current.quaternion.clone().invert());
    const a = Math.atan2(s.z, s.y);
    wings.forEach((w) => w.current && (w.current.rotation.x = a));
  });
  const refl = useMemo(() => dishGeometry(1.2, 0.9, 48), []);
  return (
    <group ref={root} userData={{ measure: 'obj:sat3', measureName: 'SAT-3 (data relay)' }}>
      <RoundedBox args={[1.9, 1.9, 2.5]} radius={0.05} smoothness={2} material={m.silverFoil} />
      <mesh material={m.gold} position={[0, 0, 0]}>
        <boxGeometry args={[1.92, 1.5, 2.2]} />
      </mesh>
      {[-1, 1].map((sz) => (
        <mesh key={sz} material={m.radiator} position={[0, 0, sz * 1.26]} rotation={[0, sz > 0 ? 0 : Math.PI, 0]}>
          <planeGeometry args={[1.7, 1.7]} />
        </mesh>
      ))}
      {/* reflectors on ±z booms, facing nadir */}
      {[-1, 1].map((sz) => (
        <group key={`d${sz}`} position={[0, -0.5, sz * 2.1]} rotation={[sz * 0.5 + Math.PI, 0, 0]}>
          <mesh geometry={refl} material={m.whitePaint} />
          <mesh material={m.frame} position={[0, 0.9, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 1.2, 8]} />
          </mesh>
          <mesh material={m.gold} position={[0, 0.95, 0]}>
            <boxGeometry args={[0.2, 0.2, 0.2]} />
          </mesh>
        </group>
      ))}
      {/* optical inter-satellite link terminal on the zenith deck */}
      <group position={[0.4, 1.2, 0.4]}>
        <mesh material={m.blackAnod}>
          <cylinderGeometry args={[0.24, 0.26, 0.25, 24]} />
        </mesh>
        <mesh material={m.whitePaint} position={[0, 0.3, 0.1]} rotation={[0.6, 0, 0]}>
          <cylinderGeometry args={[0.16, 0.16, 0.45, 24]} />
        </mesh>
        <mesh material={m.lens} position={[0, 0.48, 0.24]} rotation={[0.6 - Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.14, 24]} />
        </mesh>
      </group>
      {/* wings on ±x */}
      {[1, -1].map((side, k) => (
        <group key={side} position={[side * 0.98, 0, 0]}>
          <mesh material={m.darkMetal} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.12, 0.12, 0.16, 16]} />
          </mesh>
          <group ref={wings[k]}>
            <mesh material={m.frame} position={[side * 0.5, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.035, 0.035, 0.9, 8]} />
            </mesh>
            {[0, 1, 2, 3].map((i) => (
              <group key={i} position={[side * (2.1 + i * 2.3), 0, 0]}>
                <mesh material={m.cells2} position={[0, 0.012, 0]}>
                  <boxGeometry args={[2.25, 0.014, 1.8]} />
                </mesh>
                <mesh material={m.panelBack2} position={[0, -0.006, 0]}>
                  <boxGeometry args={[2.25, 0.02, 1.8]} />
                </mesh>
              </group>
            ))}
          </group>
        </group>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------- ISS ---- */

/** International Space Station, simplified: truss, 8 array wings, radiators, modules. */
function ISS({ m, x }: { m: M; x: ReturnType<typeof useExtraMaterials> }) {
  const root = usePassDriver({ altKm: 420, headingDeg: 58, offsetKm: 260, halfArcDeg: 20, phase: 0.1 }, 0.109, 0.05, 'iss');
  const arrays = useRef<THREE.Group[]>([]);
  useFrame(() => {
    if (!root.current) return;
    const s = SUN.clone().applyQuaternion(root.current.quaternion.clone().invert());
    const a = Math.atan2(s.z, s.y);
    arrays.current.forEach((g) => g && (g.rotation.x = a));
  });
  const wingX = [-44, -32, 32, 44];
  return (
    <group ref={root} userData={{ measure: 'obj:iss', measureName: 'International Space Station' }}>
      {/* integrated truss along x (≈ 109 m) */}
      <mesh material={m.frame}>
        <boxGeometry args={[100, 2.4, 2.4]} />
      </mesh>
      <mesh material={m.darkMetal}>
        <boxGeometry args={[100.4, 1.2, 1.2]} />
      </mesh>
      {/* solar array wings: 4 per side, two blankets each, sun-tracking about x */}
      {wingX.map((xx, i) => (
        <group key={xx} position={[xx, 0, 0]} ref={(g) => { if (g) arrays.current[i] = g; }}>
          {[-1, 1].map((sz) => (
            <group key={sz} position={[0, 0, sz * 18]}>
              <mesh material={m.frame}>
                <boxGeometry args={[0.4, 0.4, 34]} />
              </mesh>
              {[-1, 1].map((sx) => (
                <mesh key={sx} material={x.issArray} position={[sx * 3.2, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[4.6, 33]} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      ))}
      {/* thermal radiators (white), perpendicular to the truss */}
      {[-14, 14].map((xx) => (
        <group key={xx} position={[xx, -1, 0]}>
          {[0, 1, 2].map((k) => (
            <mesh key={k} material={m.whitePaint} position={[0, -4 - k * 3.4, 0]} rotation={[0, 0, 0]}>
              <boxGeometry args={[3.2, 3.2, 0.15]} />
            </mesh>
          ))}
        </group>
      ))}
      {/* pressurised modules along z (the station's long axis in flight) */}
      <group position={[0, -3.5, 0]}>
        <mesh material={x.module} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[2.1, 2.1, 50, 24]} />
        </mesh>
        {[-26, 26].map((z) => (
          <mesh key={z} material={x.module} position={[0, 0, z]}>
            <sphereGeometry args={[2.1, 20, 14]} />
          </mesh>
        ))}
        {/* laboratory modules sideways at the forward node */}
        {[-1, 1].map((sx) => (
          <mesh key={sx} material={x.module} position={[sx * 7, 0, 18]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[2.1, 2.1, 10, 20]} />
          </mesh>
        ))}
        {/* service-module arrays aft */}
        {[-1, 1].map((sx) => (
          <mesh key={`sm${sx}`} material={m.cells2} position={[sx * 8, 0, -22]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[10, 3]} />
          </mesh>
        ))}
        {/* robotic arm */}
        <mesh material={m.whitePaint} position={[4, 3, 6]} rotation={[0.3, 0, 0.9]}>
          <cylinderGeometry args={[0.2, 0.2, 16, 8]} />
        </mesh>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- meteors ---- */

const meteorVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const meteorFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform float fade;
uniform float head;
void main() {
  #include <logdepthbuf_fragment>
  float along = vUv.x;
  float tail = smoothstep(head - 0.55, head, along) * step(along, head);
  float core = exp(-pow((vUv.y - 0.5) * 7.0, 2.0));
  vec3 col = mix(vec3(0.55, 1.0, 0.75), vec3(1.0, 0.95, 0.85), smoothstep(head - 0.1, head, along));
  gl_FragColor = vec4(col * 2.2, tail * core * fade);
}`;

function Meteors() {
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: meteorVertex,
        fragmentShader: meteorFragment,
        uniforms: { fade: { value: 0 }, head: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const st = useMemo(() => ({ t0: -10, dur: 0.9, start: new THREE.Vector3(), dir: new THREE.Vector3(), len: 60, seed: 3, next: 2 }), []);
  useFrame((state) => {
    const m = mesh.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    if (t > st.next) {
      const r = () => ((st.seed = (st.seed * 16807) % 2147483647) / 2147483647);
      const { losAzDeg } = useApp.getState().config.scene;
      // a streak at 90–110 km altitude, 150–700 km from the site, roughly in the look direction
      const az = losAzDeg + (r() - 0.5) * 120;
      const ground = 150 + r() * 550;
      const h = 90 + r() * 20;
      const a = THREE.MathUtils.degToRad(az);
      st.start.set(Math.sin(a) * ground, h - (ground * ground) / (2 * EARTH_R), -Math.cos(a) * ground);
      st.dir.set(r() - 0.5, -0.35 - r() * 0.3, r() - 0.5).normalize();
      st.len = 40 + r() * 70;
      st.dur = 0.6 + r() * 0.7;
      st.t0 = t;
      st.next = t + 4 + r() * 7;
    }
    const k = (t - st.t0) / st.dur;
    if (k < 0 || k > 1.3) {
      m.visible = false;
      return;
    }
    m.visible = true;
    const mid = st.start.clone().addScaledVector(st.dir, st.len / 2);
    m.position.copy(mid);
    // billboard the quad along the streak direction
    const toCam = state.camera.position.clone().sub(mid).normalize();
    const side = new THREE.Vector3().crossVectors(st.dir, toCam).normalize();
    const n = new THREE.Vector3().crossVectors(side, st.dir).normalize();
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(st.dir, side, n));
    const width = Math.max(0.3, state.camera.position.distanceTo(mid) * 0.0016);
    m.scale.set(st.len, width, 1);
    mat.uniforms.head.value = Math.min(1, k);
    mat.uniforms.fade.value = k < 1 ? 1 : 1 - (k - 1) / 0.3;
  });
  return (
    <mesh ref={mesh} material={mat} renderOrder={3} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

/* ----------------------------------------------------------------- aurora ---- */

const auroraVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vP;
void main() {
  vUv = uv; vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const auroraFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vP;
uniform float time;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float ang = atan(vP.z, vP.x);
  float curtain = aq_fbm(vec3(ang * 6.0, time * 0.05, 1.0), 4);
  float rays = 0.6 + 0.4 * sin(ang * 180.0 + curtain * 12.0 + time * 0.3);
  float h = vUv.y;
  float vert = smoothstep(0.0, 0.08, h) * pow(1.0 - h, 1.6);
  float a = smoothstep(0.35, 0.75, curtain) * rays * vert;
  vec3 col = mix(vec3(0.15, 1.0, 0.45), vec3(0.75, 0.25, 0.9), smoothstep(0.35, 0.95, h));
  gl_FragColor = vec4(col * a * 1.6, a);
}`;

function Aurora() {
  const lat = useApp((s) => s.config.scene.siteLatDeg);
  const lon = useApp((s) => s.config.scene.siteLonDeg);
  const q = useMemo(() => earthQuaternion(lat, lon), [lat, lon]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: auroraVertex,
        fragmentShader: auroraFragment,
        uniforms: { time: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useFrame((s) => (mat.uniforms.time.value = s.clock.elapsedTime));
  const ovals = [
    { lat: 70, sign: 1 },
    { lat: 70, sign: -1 },
  ];
  return (
    <group position={EARTH_CENTER} quaternion={q}>
      {ovals.map((o) => {
        const phi = THREE.MathUtils.degToRad(o.lat);
        const rr = (EARTH_R + 180) * Math.cos(phi);
        const y = o.sign * (EARTH_R + 180) * Math.sin(phi);
        return (
          <mesh key={o.sign} material={mat} position={[0, y, 0]} rotation={[o.sign > 0 ? 0 : Math.PI, 0, 0]} renderOrder={2}>
            <cylinderGeometry args={[rr, rr * 1.01, 260, 256, 1, true]} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ---------------------------------------------------------------- deep sky ---- */

function galaxyTexture(kind: 'spiral' | 'cloud') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  let s = kind === 'spiral' ? 5 : 9;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  if (kind === 'spiral') {
    g.addColorStop(0, 'rgba(255,240,215,0.95)');
    g.addColorStop(0.12, 'rgba(230,215,200,0.45)');
    g.addColorStop(0.45, 'rgba(150,165,210,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
  } else {
    g.addColorStop(0, 'rgba(210,215,235,0.35)');
    g.addColorStop(0.5, 'rgba(170,180,220,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
  }
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.pow(r(), 0.7) * 110;
    x.fillStyle = `rgba(230,230,255,${0.08 * r()})`;
    x.fillRect(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function DeepSky() {
  const tex = useMemo(() => ({ spiral: galaxyTexture('spiral'), cloud: galaxyTexture('cloud') }), []);
  const group = useRef<THREE.Group>(null);
  useFrame((s) => group.current?.position.copy(s.camera.position));
  const R = 90000;
  // Approximate directions for a site at 13° N (no sidereal time in the scene).
  const objs = [
    { name: 'Andromeda galaxy (M31)', az: 18, el: 42, w: 3.2, h: 1.0, rot: 0.6, t: tex.spiral, o: 0.55 },
    { name: 'Large Magellanic Cloud', az: 182, el: 7, w: 9, h: 7, rot: 0.3, t: tex.cloud, o: 0.2 },
    { name: 'Small Magellanic Cloud', az: 166, el: 5, w: 4, h: 3, rot: 0.1, t: tex.cloud, o: 0.16 },
  ];
  return (
    <group ref={group}>
      {objs.map((o) => {
        const p = azElVec(o.az, o.el, R);
        const size = (o.w * Math.PI) / 180 * R;
        return (
          <mesh
            key={o.name}
            position={p}
            renderOrder={-9}
            frustumCulled={false}
            onUpdate={(mm) => {
              mm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.clone().negate().normalize());
              mm.rotateZ(o.rot);
            }}
          >
            <planeGeometry args={[size, (size * o.h) / o.w]} />
            <meshBasicMaterial map={o.t} transparent opacity={o.o} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ---------------------------------------------------------------- root ---- */

export function SpaceEnvironment() {
  const on = useApp((s) => s.overlays.space);
  const m = useMemo(makeMaterials, []);
  const x = useExtraMaterials();
  if (!on) {
    for (const k of Object.keys(anchorOn)) anchorOn[k] = false;
    return null;
  }
  return (
    <group>
      <ISS m={m} x={x} />
      <EOSat m={m} />
      <RelaySat m={m} />
      <Meteors />
      <Aurora />
      <DeepSky />
    </group>
  );
}
