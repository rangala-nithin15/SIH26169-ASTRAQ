/**
 * The 3D stage: one R3F canvas holding the Earth, sky, terminal, satellite and the
 * optical overlays. Quality presets trade effects for frame rate.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer, SMAA, Vignette } from '@react-three/postprocessing';
import { Earth, GroundSite } from './earth/Earth';
import { Sky, Moon, MOON_AZ, MOON_EL } from './sky/Sky';
import { GroundTerminal } from './models/GroundTerminal';
import { Satellite, SUN_DIR } from './models/Satellite';
import { Optics } from './overlays/Optics';
import { SpaceEnvironment } from './space/SpaceObjects';
import { LabelProjector } from './Labels';
import { CameraRig } from './CameraRig';
import { VisBus } from './VisBus';
import { live, useApp } from '../state/store';
import { azElVec, MOON_DISTANCE_KM } from './world';

function Lights({ sunDir }: { sunDir: THREE.Vector3 }) {
  const quality = useApp((s) => s.quality);
  const sunEl = useApp((s) => s.config.scene.sunElDeg);
  const warm = useMemo(() => new THREE.Color().lerpColors(new THREE.Color('#ffd9b8'), new THREE.Color('#fff6ec'), THREE.MathUtils.clamp((sunEl + 2) / 25, 0, 1)), [sunEl]);
  const light = useMemo(() => {
    // Sunlight. At twilight the ground is in the Earth's shadow while the spacecraft is
    // still sunlit by an unreddened Sun above its own horizon, so the tint stays mild.
    const l = new THREE.DirectionalLight(warm, 2.4);
    l.position.copy(sunDir).multiplyScalar(0.05);
    l.target.position.set(0, 0.003, 0);
    l.castShadow = quality === 'high';
    l.shadow.mapSize.set(2048, 2048);
    const c = l.shadow.camera as THREE.OrthographicCamera;
    c.left = c.bottom = -0.009;
    c.right = c.top = 0.009;
    c.near = 0.001;
    c.far = 0.12;
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 0.00002;
    return l;
  }, [sunDir, quality, warm]);
  return (
    <>
      <primitive object={light} />
      <primitive object={light.target} />
      <hemisphereLight args={['#3a5584', '#221c16', 0.7]} />
      {/* Moon / night-sky fill so the terminal reads at twilight. */}
      <directionalLight position={[0.35, 0.8, -0.45]} intensity={0.55} color="#c9d6ff" />
      {/* Earthshine on the spacecraft's nadir side. */}
      <directionalLight position={[0, -1, 0]} intensity={0.25} color="#5b86c9" />
    </>
  );
}

function Env() {
  return (
    <Environment resolution={128} frames={1} background={false}>
      <Lightformer form="rect" intensity={2.2} color="#ffb070" position={[6, 0.6, -2]} scale={[12, 1.2, 1]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={0.8} color="#6d8fd6" position={[0, 6, 0]} scale={[14, 14, 1]} target={[0, 0, 0]} />
      <Lightformer form="ring" intensity={1.4} color="#e8f0ff" position={[-5, 2, 4]} scale={2} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={0.3} color="#2a2018" position={[0, -5, 0]} scale={[14, 14, 1]} target={[0, 0, 0]} />
    </Environment>
  );
}

function Effects() {
  const quality = useApp((s) => s.quality);
  if (quality === 'low') return null;
  return (
    // No MSAA in the composer: multisampled half-float targets render black on some
    // Intel/AMD drivers (ANGLE/D3D11). SMAA gives the anti-aliasing on every GPU.
    quality === 'high' ? (
      <EffectComposer key="hi" multisampling={0} enableNormalPass={false}>
        <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.82} luminanceSmoothing={0.2} radius={0.72} />
        <Vignette offset={0.28} darkness={0.55} />
        <SMAA />
      </EffectComposer>
    ) : (
      <EffectComposer key="md" multisampling={0} enableNormalPass={false}>
        <Bloom mipmapBlur intensity={0.75} luminanceThreshold={0.82} luminanceSmoothing={0.2} radius={0.72} />
        <Vignette offset={0.28} darkness={0.55} />
      </EffectComposer>
    )
  );
}

/**
 * Render guard. If the GPU cannot cope with the current quality (a black frame or a
 * very low frame rate), drop one quality level and tell the user, instead of leaving
 * a black 3D view.
 */
function RenderGuard() {
  const quality = useApp((s) => s.quality);
  const gl = useThree((s) => s.gl);
  const st = useRef({ t0: -1, frames: 0, checked: false, w0: -1, wf: 0, fpsDone: false, buf: new Uint8Array(4 * 256) });
  useEffect(() => {
    st.current.t0 = -1;
    st.current.frames = 0;
    st.current.checked = false;
    st.current.w0 = -1;
    st.current.fpsDone = false;
  }, [quality]);
  useFrame((state) => {
    const g = st.current;
    const t = state.clock.elapsedTime;
    if (g.t0 < 0) g.t0 = t;
    g.frames++;
    const age = t - g.t0;
    // 1) Black-frame check, once, 3 s after a quality change (runs after the composer).
    if (!g.checked && age > 3) {
      g.checked = true;
      gl.setRenderTarget(null);
      const ctx = gl.getContext();
      const w = ctx.drawingBufferWidth;
      const h = ctx.drawingBufferHeight;
      const n = Math.min(256, w);
      let max = 0;
      for (const fy of [0.3, 0.55, 0.8]) {
        ctx.readPixels(Math.floor((w - n) / 2), Math.floor(h * fy), n, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, g.buf);
        for (let i = 0; i < n * 4; i += 4) max = Math.max(max, g.buf[i], g.buf[i + 1], g.buf[i + 2]);
      }
      if (max === 0) downgrade(quality, 'the 3D view rendered black on this graphics card');
    }
    // 2) Frame-rate check at High, measured 3–9 s after the switch (after shader compilation).
    if (quality === 'high') {
      if (age > 3 && g.w0 < 0) {
        g.w0 = t;
        g.wf = g.frames;
      }
      if (g.w0 > 0 && t - g.w0 > 6 && !g.fpsDone) {
        g.fpsDone = true;
        const fps = (g.frames - g.wf) / (t - g.w0);
        if (fps < 6) downgrade(quality, `High ran at ${fps.toFixed(1)} fps on this graphics card`);
      }
    }
  }, 10);
  return null;
}

/** `?guard=0` disables the automatic fallback (used by automated screenshots on software GL). */
const GUARD_ON = typeof window === 'undefined' || new URLSearchParams(window.location.search).get('guard') !== '0';

function downgrade(q: string, why: string) {
  const st = useApp.getState();
  const next = q === 'high' ? 'medium' : 'low';
  console.warn(`ASTRAQ render guard: ${why}; switching to ${next}.`);
  st.setQuality(next);
  st.notify(`Render quality set to ${next === 'medium' ? 'Medium' : 'Low'}: ${why}. You can switch back in View ▸ Render quality.`, 9000);
}

/** Pixel-ratio cap: high-DPI screens at 2× can exceed the GPU's memory for the post chain. */
function dprFor(quality: string): [number, number] {
  if (quality === 'low') return [1, 1];
  const dev = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const px = typeof window !== 'undefined' ? window.innerWidth * window.innerHeight : 1920 * 1080;
  const budget = quality === 'high' ? 6.0e6 : 3.2e6; // rendered pixels
  const cap = Math.max(1, Math.min(dev, quality === 'high' ? 2 : 1.5, Math.sqrt(budget / px)));
  return [1, cap];
}

function Picker() {
  const measure = useApp((s) => s.measure);
  const gl = useThree((s) => s.gl);
  gl.domElement.style.cursor = measure.enabled ? 'crosshair' : '';
  return null;
}

function addPick(id: string, name: string, pos: [number, number, number]) {
  const st = useApp.getState();
  if (!st.measure.enabled) return;
  const picks = [...st.measure.picks, { id, name, pos }].slice(-2);
  st.set({ measure: { ...st.measure, picks } });
}

export function Stage() {
  const quality = useApp((s) => s.quality);
  // The 3D view is hidden behind the video-benchmark panel: stop rendering it so the
  // analysis gets the whole CPU/GPU budget.
  const paused = useApp((s) => s.videoOpen);
  const sunAz = useApp((s) => s.config.scene.sunAzDeg);
  const sunEl = useApp((s) => s.config.scene.sunElDeg);
  const sunDir = useMemo(() => azElVec(sunAz, sunEl).normalize(), [sunAz, sunEl]);
  SUN_DIR.copy(sunDir);
  const dpr = useMemo(() => dprFor(quality), [quality]);
  // A lost WebGL context (driver reset, out of GPU memory) would leave the view black:
  // remount the canvas one quality level lower.
  const [epoch, setEpoch] = useState(0);
  const onCreated = (gl: THREE.WebGLRenderer) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    gl.domElement.addEventListener(
      'webglcontextlost',
      (ev) => {
        ev.preventDefault();
        const q = useApp.getState().quality;
        downgrade(q === 'low' ? 'medium' : q, 'the graphics driver reset the 3D view');
        setTimeout(() => setEpoch((e) => e + 1), 300);
      },
      { once: true },
    );
  };

  const onPick = (e: ThreeEvent<MouseEvent>) => {
    if (!useApp.getState().measure.enabled) return;
    e.stopPropagation();
    let o: THREE.Object3D | null = e.object;
    while (o && !o.userData.measure) o = o.parent;
    const id = o?.userData.measure as string | undefined;
    if (o && id?.startsWith('obj:')) {
      const p = o.getWorldPosition(new THREE.Vector3());
      addPick(id, (o.userData.measureName as string) ?? id, [p.x, p.y, p.z]);
    } else if (id === 'terminal') addPick('terminal', 'Ground terminal', [0, 0, 0]);
    else if (id === 'satellite') addPick('satellite', 'Remote terminal', (live.snap?.target.posKm ?? [0, 0, 0]) as [number, number, number]);
    else if (id === 'moon') {
      const p = azElVec(MOON_AZ, MOON_EL, MOON_DISTANCE_KM);
      addPick('moon', 'Moon', [p.x, p.y, p.z]);
    } else addPick(`ground-${Date.now()}`, 'Surface point', [e.point.x, e.point.y, e.point.z]);
  };

  return (
    <Canvas
      key={epoch}
      frameloop={paused ? 'never' : 'always'}
      className="stage-canvas"
      dpr={dpr}
      shadows={quality === 'high' ? { type: THREE.PCFShadowMap } : false}
      gl={{ logarithmicDepthBuffer: true, antialias: quality !== 'low', powerPreference: 'high-performance', preserveDrawingBuffer: false }}
      camera={{ fov: 42, near: 0.0002, far: 3e6, position: [300, 250, 200] }}
      onCreated={({ gl }) => onCreated(gl)}
    >
      <color attach="background" args={['#020409']} />
      <VisBus />
      <Picker />
      <Suspense fallback={null}>
        <Env />
      </Suspense>
      <Lights sunDir={sunDir} />
      <Sky sunDir={sunDir} />
      <group onClick={onPick}>
        <Earth sunDir={sunDir} />
        <Moon sunDir={sunDir} />
        <GroundSite />
        <GroundTerminal />
        <Satellite />
        <SpaceEnvironment />
      </group>
      <Optics />
      <LabelProjector />
      <CameraRig />
      <Effects />
      {/* Mounted only with the composer: a positive-priority frame hook disables R3F's own render call. */}
      {quality !== 'low' && GUARD_ON && <RenderGuard />}
    </Canvas>
  );
}
