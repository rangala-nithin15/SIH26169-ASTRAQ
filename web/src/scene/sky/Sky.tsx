/**
 * Deep-space background: the shared star catalogue (same stars the sensor can see),
 * a faint galactic band, the Sun with a restrained screen-space flare, and the Moon.
 */
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { makeStarCatalog } from '../../core/optics/stars';
import { NOISE_GLSL } from '../shaders/noise';
import { EARTH_CENTER, EARTH_R, MOON_DISTANCE_KM, MOON_RADIUS_KM, azElVec } from '../world';
import { useApp } from '../../state/store';

export const STAR_CATALOG = makeStarCatalog();
const SKY_R = 1.0e5;

const starVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float mag;
attribute float temp;
uniform float pxScale;
uniform float time;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float b = pow(10.0, -0.4 * (mag - 1.0));
  float tw = 0.85 + 0.15 * sin(time * (1.3 + fract(position.x * 0.013) * 3.0) + position.y);
  gl_PointSize = clamp(1.2 + 2.6 * sqrt(b), 1.0, 5.5) * pxScale;
  vAlpha = clamp(0.18 + 0.9 * sqrt(b), 0.12, 1.0) * tw;
  vColor = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.84, 0.66), temp);
  #include <logdepthbuf_vertex>
}`;
const starFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a;
  gl_FragColor = vec4(vColor * 1.4, a * vAlpha);
}`;

const milkyFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vDir;
uniform vec3 pole;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float b = asin(clamp(dot(d, pole), -1.0, 1.0));
  float band = exp(-pow(b / 0.2, 2.0));
  float n = aq_fbm(d * 6.0, 5);
  float n2 = aq_fbm(d * 18.0 + 4.0, 4);
  float glow = band * (0.35 + 0.65 * n) * (0.6 + 0.4 * n2);
  float dust = smoothstep(0.55, 0.75, n2) * band;
  vec3 col = vec3(0.30, 0.36, 0.52) * glow * 0.13 - vec3(0.012) * dust;
  // warm core toward the galactic centre, faint emission-nebula tints elsewhere
  col += vec3(0.30, 0.22, 0.14) * band * pow(n, 2.0) * 0.06;
  col += vec3(0.20, 0.07, 0.18) * pow(aq_fbm(d * 3.0 + 11.0, 4), 3.0) * 0.09;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;
const milkyVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const moonFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 sunDir;
varying vec3 vN;
varying vec3 vObj;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObj);
  float maria = smoothstep(0.45, 0.62, aq_fbm(p * 2.2 + 5.0, 5));
  float craters = aq_fbm(p * 24.0, 5);
  float fine = aq_fbm(p * 90.0, 3);
  vec3 alb = mix(vec3(0.62, 0.61, 0.58), vec3(0.34, 0.34, 0.35), maria) * (0.8 + 0.3 * craters) * (0.9 + 0.15 * fine);
  float ndl = max(dot(normalize(vN), sunDir), 0.0);
  gl_FragColor = vec4(alb * (ndl * 1.25 + 0.01), 1.0);
  #include <colorspace_fragment>
}`;
const moonVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vObj;
void main() {
  vObj = position;
  vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

function glowTexture(inner: string, outer: string, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.12, inner);
  g.addColorStop(0.35, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const MOON_AZ = 112;
export const MOON_EL = 27;

export function Sky({ sunDir }: { sunDir: THREE.Vector3 }) {
  const quality = useApp((s) => s.quality);
  const group = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const stars = useMemo(() => {
    const n = quality === 'low' ? 2500 : STAR_CATALOG.count;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = STAR_CATALOG.dirs[i] * SKY_R;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(STAR_CATALOG.mags.slice(0, n), 1));
    g.setAttribute('temp', new THREE.BufferAttribute(STAR_CATALOG.temps.slice(0, n), 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { pxScale: { value: 1 }, time: { value: 0 } },
    });
    return { g, m };
  }, [quality]);

  const milky = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: milkyVertex,
        fragmentShader: milkyFragment,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { pole: { value: new THREE.Vector3(0.35, 0.55, 0.76).normalize() } },
      }),
    [],
  );

  const sunTex = useMemo(() => glowTexture('rgba(255,250,235,1)', 'rgba(255,190,110,0.35)'), []);
  const flareTex = useMemo(() => glowTexture('rgba(150,200,255,0.5)', 'rgba(120,160,255,0.08)', 128), []);
  const sunSprite = useRef<THREE.Sprite>(null);
  const flares = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (group.current) group.current.position.copy(camera.position);
    stars.m.uniforms.time.value = state.clock.elapsedTime;
    stars.m.uniforms.pxScale.value = dpr;
    if (sunSprite.current) sunSprite.current.position.copy(sunDir).multiplyScalar(SKY_R * 0.9);
    // Screen-space flare ghosts along the sun → centre axis, hidden when the Earth occludes the Sun.
    if (flares.current) {
      const sunWorld = camera.position.clone().addScaledVector(sunDir, SKY_R);
      const ndc = sunWorld.clone().project(camera);
      const onScreen = ndc.z < 1 && Math.abs(ndc.x) < 1.2 && Math.abs(ndc.y) < 1.2;
      const oc = camera.position.clone().sub(EARTH_CENTER);
      const b = oc.dot(sunDir);
      const c = oc.lengthSq() - EARTH_R * EARTH_R;
      const occluded = b * b - c > 0 && -b - Math.sqrt(b * b - c) > 0;
      const visible = quality !== 'low' && onScreen && !occluded;
      flares.current.visible = visible;
      if (visible) {
        const kids = flares.current.children;
        const dist = 60;
        kids.forEach((k, i) => {
          const f = [0.55, 0.2, -0.25, -0.6, -1.05][i] ?? 0;
          const p = new THREE.Vector3(ndc.x * f, ndc.y * f, 0.5).unproject(camera);
          const dir = p.sub(camera.position).normalize();
          k.position.copy(dir.multiplyScalar(dist));
          const s = [1.4, 0.7, 2.2, 1.0, 3.2][i] * dist * 0.02;
          k.scale.setScalar(s);
        });
      }
    }
    void size;
  });

  return (
    <>
      <group ref={group} renderOrder={-10}>
        <mesh material={milky} renderOrder={-11}>
          <sphereGeometry args={[SKY_R * 1.2, 48, 24]} />
        </mesh>
        <points geometry={stars.g} material={stars.m} renderOrder={-10} frustumCulled={false} />
        <sprite ref={sunSprite} scale={[SKY_R * 0.05, SKY_R * 0.05, 1]} renderOrder={-9}>
          <spriteMaterial map={sunTex} color={[4, 3.6, 3.1]} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
      </group>
      <group ref={flares} renderOrder={20}>
        {[0, 1, 2, 3, 4].map((i) => (
          <sprite key={i}>
            <spriteMaterial map={flareTex} opacity={[0.16, 0.1, 0.07, 0.12, 0.05][i]} transparent blending={THREE.AdditiveBlending} depthTest={false} depthWrite={false} />
          </sprite>
        ))}
      </group>
    </>
  );
}

/** Moon at its true direction and distance; radius ×3 for visibility (not to scale). */
export function Moon({ sunDir }: { sunDir: THREE.Vector3 }) {
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: moonVertex, fragmentShader: moonFragment, uniforms: { sunDir: { value: new THREE.Vector3() } } }),
    [],
  );
  const pos = useMemo(() => azElVec(MOON_AZ, MOON_EL, MOON_DISTANCE_KM), []);
  useFrame(() => mat.uniforms.sunDir.value.copy(sunDir));
  return (
    <mesh position={pos} material={mat} userData={{ measure: 'moon' }}>
      <sphereGeometry args={[MOON_RADIUS_KM * 3, 64, 32]} />
    </mesh>
  );
}
