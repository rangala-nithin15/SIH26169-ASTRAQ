/**
 * Earth: real coastlines (Natural Earth via world-atlas), procedural biomes, ocean
 * glint, terminator, illustrative night-side lights, cloud layer, and a
 * ray-marched-free analytic atmosphere that works from space and from the ground.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { NOISE_GLSL } from '../shaders/noise';
import { buildLandTexture } from './landMask';
import { EARTH_CENTER, EARTH_R, earthQuaternion } from '../world';
import { useApp } from '../../state/store';

const LOG_V_PARS = /* glsl */ `#include <common>\n#include <logdepthbuf_pars_vertex>`;
const LOG_F_PARS = /* glsl */ `#include <logdepthbuf_pars_fragment>`;

const earthVertex = /* glsl */ `
${LOG_V_PARS}
varying vec3 vObjN;
varying vec3 vWorldN;
varying vec3 vWorldPos;
void main() {
  vObjN = normal;
  vWorldN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const earthFragment = /* glsl */ `
${LOG_F_PARS}
uniform sampler2D landTex;
uniform float hasLand;
uniform vec3 sunDir;
uniform float grid;
uniform float cutRadius;
uniform float octaves;
varying vec3 vObjN;
varying vec3 vWorldN;
varying vec3 vWorldPos;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  if (cutRadius > 0.0 && length(vWorldPos) < cutRadius) discard;
  vec3 n = normalize(vObjN);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.x, n.z);
  vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5);
  vec4 m = hasLand > 0.5 ? texture2D(landTex, uv) : vec4(step(0.55, aq_fbm(n * 3.0, 4)), 0.3, 0.0, 1.0);
  float land = smoothstep(0.3, 0.7, m.r);
  float coast = m.g;
  int oct = int(octaves);
  float nz = aq_fbm(n * 55.0, oct);
  float nz2 = aq_fbm(n * 700.0, oct);
  float alat = abs(lat) * 57.29578;

  vec3 forest = vec3(0.06, 0.10, 0.05);
  vec3 grass = vec3(0.17, 0.20, 0.10);
  vec3 desert = vec3(0.46, 0.37, 0.24);
  vec3 tundra = vec3(0.27, 0.27, 0.22);
  vec3 ice = vec3(0.86, 0.90, 0.95);
  float aridNoise = aq_fbm(n * 5.0 + 3.0, 4);
  float arid = smoothstep(0.42, 0.62, aridNoise) * (1.0 - smoothstep(6.0, 20.0, abs(alat - 24.0)));
  arid = max(arid, smoothstep(0.62, 0.72, aridNoise) * (1.0 - smoothstep(20.0, 40.0, abs(alat - 35.0))));
  vec3 landCol = mix(forest, grass, smoothstep(0.35, 0.7, nz));
  landCol = mix(landCol, desert, arid);
  landCol = mix(landCol, tundra, smoothstep(52.0, 62.0, alat));
  float iceLand = smoothstep(64.0 + 6.0 * nz, 70.0 + 6.0 * nz, alat);
  landCol = mix(landCol, ice, iceLand);
  landCol *= 0.86 + 0.26 * nz2;

  vec3 deep = vec3(0.008, 0.035, 0.075);
  vec3 shallow = vec3(0.02, 0.11, 0.15);
  vec3 ocean = mix(deep, shallow, smoothstep(0.15, 0.7, coast));
  ocean = mix(ocean, ice * 0.9, smoothstep(74.0, 80.0, alat + 4.0 * nz));
  vec3 albedo = mix(ocean, landCol, land);

  vec3 N = normalize(vWorldN);
  float ndl = dot(N, sunDir);
  float day = smoothstep(-0.10, 0.20, ndl);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(sunDir + V);
  float water = (1.0 - land) * (1.0 - smoothstep(74.0, 80.0, alat));
  float spec = pow(max(dot(N, H), 0.0), 80.0) * water * day;
  vec3 warm = mix(vec3(1.0, 0.5, 0.28), vec3(1.0), smoothstep(0.0, 0.3, ndl));
  vec3 col = albedo * warm * (1.35 * max(ndl, 0.0) + 0.012) + spec * vec3(1.0, 0.86, 0.66) * 0.9;

  // Night-side lights: procedural, clustered, denser near coasts (illustrative).
  float cityN = aq_fbm(n * 320.0, 4);
  float cityM = aq_fbm(n * 42.0 + 7.0, 3);
  float city = smoothstep(0.60, 0.82, cityN) * smoothstep(0.44, 0.70, cityM) * land * (1.0 - iceLand) * (1.0 - smoothstep(58.0, 66.0, alat));
  city *= 0.45 + 0.9 * smoothstep(0.5, 0.95, coast);
  col += vec3(1.0, 0.70, 0.38) * city * 1.4 * (1.0 - day);

  // Limb haze.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.22, 0.48, 0.95) * fres * 0.45 * smoothstep(-0.25, 0.35, ndl);

  if (grid > 0.5) {
    float d = 15.0;
    float la = abs(fract(lat * 57.29578 / d + 0.5) - 0.5) * d;
    float lo = abs(fract(lon * 57.29578 / d + 0.5) - 0.5) * d;
    float w = fwidth(lat * 57.29578) * 1.2;
    float gl = 1.0 - smoothstep(0.0, w, min(la, lo * cos(lat)));
    col = mix(col, vec3(0.45, 0.75, 1.0), gl * 0.35);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const cloudFragment = /* glsl */ `
${LOG_F_PARS}
uniform vec3 sunDir;
uniform float time;
varying vec3 vObjN;
varying vec3 vWorldN;
varying vec3 vWorldPos;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vObjN);
  vec3 q = n * 7.0 + vec3(time * 0.004, 0.0, time * 0.002);
  float warp = aq_fbm(q * 0.8, 3);
  float d = aq_fbm(q + warp * 1.6, 6);
  float lat = abs(asin(n.y)) * 57.29578;
  float band = 0.75 + 0.35 * smoothstep(40.0, 60.0, lat) - 0.25 * (1.0 - smoothstep(10.0, 28.0, abs(lat - 22.0)));
  float dens = smoothstep(0.52, 0.78, d * band);
  // Clear sky over the ground station (it would not be an operational window otherwise).
  dens *= smoothstep(250.0, 1400.0, length(vWorldPos));
  float ndl = dot(normalize(vWorldN), sunDir);
  float day = smoothstep(-0.12, 0.25, ndl);
  vec3 lit = mix(vec3(0.02, 0.025, 0.035), mix(vec3(1.0, 0.62, 0.42), vec3(1.0), smoothstep(0.0, 0.35, ndl)), day);
  gl_FragColor = vec4(lit, dens * 0.9);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const atmoVertex = /* glsl */ `
${LOG_V_PARS}
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const atmoFragment = /* glsl */ `
${LOG_F_PARS}
uniform vec3 sunDir;
uniform vec3 center;
uniform float Rp;
uniform float Ra;
uniform float strength;
varying vec3 vWorldPos;
// Single-sample twilight atmosphere: path length through the shell sets the optical
// depth; whether the path's mid-point sees the Sun over the Earth's limb sets the
// illumination (this produces the Earth-shadow / twilight glow from the ground).
void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - Ra * Ra;
  float h = b * b - c;
  if (h < 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0);
  float t1 = -b + h;
  float cp = dot(oc, oc) - Rp * Rp;
  float hp = b * b - cp;
  if (hp > 0.0) {
    float tp = -b - sqrt(hp);
    if (tp > 0.0) t1 = min(t1, tp);
  }
  float len = max(t1 - t0, 0.0);
  vec3 col = vec3(0.0);
  float total = 0.0;
  // Three samples along the path.
  for (int i = 0; i < 3; i++) {
    float f = (float(i) + 0.5) / 3.0;
    vec3 p = ro + rd * (t0 + f * len);
    float r = length(p - center);
    vec3 up = (p - center) / r;
    float sunEl = asin(clamp(dot(up, sunDir), -1.0, 1.0));
    float dip = acos(clamp(Rp / r, 0.0, 1.0));
    float lit = smoothstep(-0.015, 0.06, sunEl + dip);
    float dens = exp(-(r - Rp) / 18.0);
    float redden = smoothstep(-0.02, 0.25, sunEl);
    vec3 scat = mix(vec3(1.0, 0.38, 0.12), vec3(0.20, 0.45, 1.0), redden);
    col += scat * lit * dens;
    total += dens;
  }
  float depth = len * total / 3.0 / 30.0;
  float mu = dot(rd, sunDir);
  float phase = 0.75 + 0.25 * mu * mu + 0.5 * pow(max(mu, 0.0), 24.0);
  float a = 1.0 - exp(-depth * 0.35);
  vec3 outc = col / 3.0 * phase * a * strength * 1.4;
  gl_FragColor = vec4(outc, 1.0);
  #include <colorspace_fragment>
}`;

export function Earth({ sunDir }: { sunDir: THREE.Vector3 }) {
  const cfg = useApp((s) => s.config.scene);
  const quality = useApp((s) => s.quality);
  const grid = useApp((s) => s.overlays.grid);
  const [land, setLand] = useState<THREE.Texture | null>(null);
  const q = useMemo(() => earthQuaternion(cfg.siteLatDeg, cfg.siteLonDeg), [cfg.siteLatDeg, cfg.siteLonDeg]);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    let alive = true;
    const width = quality === 'low' ? 2048 : 4096;
    buildLandTexture(width)
      .then((t) => {
        if (!alive) return;
        t.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        setLand(t);
      })
      .catch((e) => console.warn('ASTRAQ: land texture unavailable, using procedural fallback', e));
    return () => {
      alive = false;
    };
  }, [quality, gl]);

  const earthMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          landTex: { value: null },
          hasLand: { value: 0 },
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          grid: { value: 0 },
          cutRadius: { value: 2.6 },
          octaves: { value: 5 },
        },
      }),
    [],
  );
  const cloudMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: cloudFragment,
        transparent: true,
        depthWrite: false,
        uniforms: { sunDir: { value: new THREE.Vector3(0, 1, 0) }, time: { value: 0 } },
      }),
    [],
  );
  const atmoMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: atmoVertex,
        fragmentShader: atmoFragment,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          center: { value: EARTH_CENTER.clone() },
          Rp: { value: EARTH_R },
          Ra: { value: EARTH_R + 100 },
          strength: { value: 1.0 },
        },
      }),
    [],
  );

  useEffect(() => {
    earthMat.uniforms.landTex.value = land;
    earthMat.uniforms.hasLand.value = land ? 1 : 0;
  }, [land, earthMat]);
  useEffect(() => {
    earthMat.uniforms.grid.value = grid ? 1 : 0;
    earthMat.uniforms.octaves.value = quality === 'low' ? 3 : quality === 'medium' ? 4 : 5;
  }, [grid, quality, earthMat]);

  const cloudRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    earthMat.uniforms.sunDir.value.copy(sunDir);
    cloudMat.uniforms.sunDir.value.copy(sunDir);
    atmoMat.uniforms.sunDir.value.copy(sunDir);
    cloudMat.uniforms.time.value = state.clock.elapsedTime;
  });

  const seg = quality === 'low' ? 128 : 256;
  return (
    <group position={EARTH_CENTER} quaternion={q}>
      <mesh material={earthMat} renderOrder={0}>
        <sphereGeometry args={[EARTH_R, seg, seg / 2]} />
      </mesh>
      {quality !== 'low' && (
        <mesh ref={cloudRef} material={cloudMat} renderOrder={1} raycast={() => null}>
          <sphereGeometry args={[EARTH_R + 9, seg, seg / 2]} />
        </mesh>
      )}
      <mesh material={atmoMat} renderOrder={2} raycast={() => null}>
        <sphereGeometry args={[EARTH_R + 100, 128, 64]} />
      </mesh>
    </group>
  );
}

/** High-precision ground patch around the terminal (the global sphere is cut out here). */
export function GroundSite() {
  const quality = useApp((s) => s.quality);
  const { geo, mat, padMat } = useMemo(() => {
    const R = 3.0; // km
    // Ring with radial subdivision so the Earth's curvature can be applied.
    const refined = new THREE.RingGeometry(0.0005, R, 160, 48);
    refined.rotateX(-Math.PI / 2);
    const rp = refined.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i);
      const z = rp.getZ(i);
      rp.setY(i, -(x * x + z * z) / (2 * EARTH_R));
    }
    refined.computeVertexNormals();
    const tex = groundTexture();
    tex.repeat.set(220, 220);
    const alpha = radialAlpha();
    const m = new THREE.MeshStandardMaterial({
      map: tex,
      color: new THREE.Color('#8a8a78'),
      roughness: 0.96,
      metalness: 0,
      alphaMap: alpha,
      transparent: true,
      depthWrite: true,
    });
    const pm = new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.85, metalness: 0.05, color: '#b9bcc0' });
    return { geo: refined, mat: m, padMat: pm };
  }, []);
  return (
    <group>
      <mesh geometry={geo} material={mat} receiveShadow={quality === 'high'} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.00002, 0]} material={padMat} receiveShadow={quality === 'high'}>
        <circleGeometry args={[0.014, 64]} />
      </mesh>
    </group>
  );
}

function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#4b4a3a';
  x.fillRect(0, 0, 512, 512);
  let s = 12345;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const g = 50 + r() * 60;
    x.fillStyle = `rgba(${g + 20},${g + 18},${g - 5},${0.18 + r() * 0.25})`;
    const w = 1 + r() * 5;
    x.fillRect(r() * 512, r() * 512, w, w);
  }
  for (let i = 0; i < 400; i++) {
    x.fillStyle = `rgba(60,72,38,${0.25 + r() * 0.3})`;
    x.beginPath();
    x.arc(r() * 512, r() * 512, 3 + r() * 14, 0, Math.PI * 2);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function radialAlpha(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.86, '#fff');
  g.addColorStop(1, '#000');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function padTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d')!;
  x.fillStyle = '#7d8084';
  x.fillRect(0, 0, 1024, 1024);
  let s = 99;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14000; i++) {
    const g = 100 + r() * 40;
    x.fillStyle = `rgba(${g},${g},${g + 4},0.25)`;
    x.fillRect(r() * 1024, r() * 1024, 2, 2);
  }
  x.strokeStyle = 'rgba(40,42,46,0.35)';
  x.lineWidth = 2;
  for (let k = 128; k < 1024; k += 256) {
    x.beginPath();
    x.moveTo(k, 0);
    x.lineTo(k, 1024);
    x.moveTo(0, k);
    x.lineTo(1024, k);
    x.stroke();
  }
  // Survey marker + north arrow painted on the pad.
  x.strokeStyle = 'rgba(230,190,90,0.32)';
  x.lineWidth = 6;
  x.beginPath();
  x.arc(512, 512, 300, 0, Math.PI * 2);
  x.stroke();
  x.fillStyle = 'rgba(230,190,90,0.5)';
  x.beginPath();
  x.moveTo(512, 150);
  x.lineTo(482, 230);
  x.lineTo(542, 230);
  x.fill();
  x.font = 'bold 60px sans-serif';
  x.textAlign = 'center';
  x.fillText('N', 512, 130);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  // CircleGeometry UVs map the disc into the unit square with v up; north is −z → rotate so "N" faces north.
  t.center.set(0.5, 0.5);
  t.rotation = 0;
  return t;
}
