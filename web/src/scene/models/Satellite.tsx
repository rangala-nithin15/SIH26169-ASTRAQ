/**
 * Remote terminal: a LEO spacecraft carrying an optical communication terminal and
 * the acquisition beacon (modelled in metres, rendered in km with iconic scaling).
 *
 * Layout follows a typical small LEO bus: a box bus wrapped in crinkled gold MLI,
 * white radiators on the anti-sun sides, two deployable solar-array wings (yoke +
 * three hinged panels each) on sun-tracking drives, star trackers, GNSS, an RF dish
 * and, on the nadir deck, the optical head on a two-axis coarse-pointing mount with
 * its red beacon laser.
 *
 * Meaningful animation only: the body stays nadir-pointed, the array drives track the
 * Sun, and the optical head points at the ground terminal.
 */
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { makeMaterials } from './materials';
import { vis } from '../vis';
import { EARTH_CENTER } from '../world';

type M = ReturnType<typeof makeMaterials>;

const PANEL_W = 1.6; // m along the wing
const PANEL_H = 1.15;
const PANELS = 3;

function Wing({ side, m, wingRef }: { side: 1 | -1; m: M; wingRef: React.RefObject<THREE.Group | null> }) {
  return (
    <group position={[side * 0.66, 0.05, 0]}>
      {/* solar array drive */}
      <mesh material={m.darkMetal} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.1, 0.12, 0.14, 20]} />
      </mesh>
      <group ref={wingRef}>
        {/* boom + yoke */}
        <mesh material={m.frame} position={[side * 0.35, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 0.6, 10]} />
        </mesh>
        {[-1, 1].map((sz) => (
          <mesh key={sz} material={m.frame} position={[side * 0.82, 0, sz * 0.28]} rotation={[0, sz * side * 0.55, Math.PI / 2]}>
            <cylinderGeometry args={[0.018, 0.018, 0.72, 8]} />
          </mesh>
        ))}
        {Array.from({ length: PANELS }, (_, i) => {
          const cx = side * (1.12 + PANEL_W / 2 + i * (PANEL_W + 0.06));
          return (
            <group key={i} position={[cx, 0, 0]}>
              <mesh material={m.cells2} position={[0, 0.012, 0]}>
                <boxGeometry args={[PANEL_W, 0.012, PANEL_H]} />
              </mesh>
              <mesh material={m.panelBack2} position={[0, -0.006, 0]}>
                <boxGeometry args={[PANEL_W, 0.02, PANEL_H]} />
              </mesh>
              {/* frame rails */}
              {[-1, 1].map((sz) => (
                <mesh key={sz} material={m.frame} position={[0, 0.005, sz * (PANEL_H / 2)]}>
                  <boxGeometry args={[PANEL_W, 0.035, 0.03]} />
                </mesh>
              ))}
              {/* hinge to the next panel */}
              {i < PANELS - 1 &&
                [-0.4, 0.4].map((z) => (
                  <mesh key={z} material={m.darkMetal} position={[side * (PANEL_W / 2 + 0.03), 0, z]}>
                    <boxGeometry args={[0.07, 0.04, 0.1]} />
                  </mesh>
                ))}
            </group>
          );
        })}
      </group>
    </group>
  );
}

export function Satellite() {
  const m = useMemo(makeMaterials, []);
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const wingL = useRef<THREE.Group>(null);
  const wingR = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.Sprite>(null);
  const halo = useRef<THREE.Sprite>(null);
  const beaconAnchor = useRef<THREE.Object3D>(null);
  const tmp = useMemo(
    () => ({ x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), mat: new THREE.Matrix4(), q: new THREE.Quaternion(), d: new THREE.Vector3() }),
    [],
  );
  const glow = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d')!;
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,190,190,0.95)');
    g.addColorStop(0.35, 'rgba(255,40,40,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);

  const flag = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 180;
    c.height = 120;
    const x = c.getContext('2d')!;
    x.fillStyle = '#ff9933';
    x.fillRect(0, 0, 180, 40);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 40, 180, 40);
    x.fillStyle = '#138808';
    x.fillRect(0, 80, 180, 40);
    x.strokeStyle = '#000080';
    x.lineWidth = 2;
    x.beginPath();
    x.arc(90, 60, 15, 0, Math.PI * 2);
    x.stroke();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      x.beginPath();
      x.moveTo(90, 60);
      x.lineTo(90 + Math.cos(a) * 15, 60 + Math.sin(a) * 15);
      x.lineWidth = 0.8;
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  const horn = useMemo(() => new THREE.CylinderGeometry(0.03, 0.11, 0.22, 4, 1, true), []);

  const dish = useMemo(() => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const r = (i / 16) * 0.42;
      pts.push(new THREE.Vector2(r, (r * r) / 0.5));
    }
    return new THREE.LatheGeometry(pts, 40);
  }, []);

  useFrame(() => {
    if (!root.current || !body.current) return;
    root.current.position.copy(vis.sat);
    root.current.scale.setScalar(0.001 * vis.satScale);
    // Nadir pointing: body +y = radial (zenith), body +z roughly along-track.
    tmp.y.copy(vis.sat).sub(EARTH_CENTER).normalize();
    tmp.z.set(0, 0, -1);
    if (vis.satVel.lengthSq() > 1e-8) tmp.z.copy(vis.satVel).normalize();
    tmp.x.crossVectors(tmp.y, tmp.z);
    if (tmp.x.lengthSq() < 1e-6) tmp.x.set(1, 0, 0);
    tmp.x.normalize();
    tmp.z.crossVectors(tmp.x, tmp.y).normalize();
    tmp.mat.makeBasis(tmp.x, tmp.y, tmp.z);
    body.current.quaternion.setFromRotationMatrix(tmp.mat);
    // Solar array drives: rotate each wing about body x so the cells face the Sun.
    const sunLocal = SUN_DIR.clone().applyQuaternion(body.current.quaternion.clone().invert());
    const ang = Math.atan2(sunLocal.z, sunLocal.y);
    if (wingL.current) wingL.current.rotation.x = ang;
    if (wingR.current) wingR.current.rotation.x = ang;
    // Optical head: point the telescope (local −z) at the ground terminal.
    if (head.current) {
      tmp.d.copy(vis.lens).sub(vis.sat).normalize().applyQuaternion(body.current.quaternion.clone().invert());
      tmp.q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), tmp.d);
      head.current.quaternion.slerp(tmp.q, 0.2);
    }
    if (beacon.current && beaconAnchor.current) {
      beaconAnchor.current.getWorldPosition(beacon.current.position);
      vis.beacon.copy(beacon.current.position);
      const locked = vis.state === 'LOCKED';
      const s = (locked ? 0.05 : 0.036 + 0.012 * Math.sin(vis.time * 6)) * (vis.pov ? 0.08 : 1) * (vis.view === 'link' ? 0.5 : vis.view === 'orbit' ? 0.45 : 1);
      beacon.current.scale.set(s, s, 1);
      if (halo.current) {
        halo.current.position.copy(beacon.current.position);
        const h = s * (locked ? 1.7 : 1.4);
        halo.current.scale.set(h, h, 1);
        (halo.current.material as THREE.SpriteMaterial).opacity = locked ? 0.3 : 0.2;
      }
    }
  });

  return (
    <>
      <group ref={root} userData={{ measure: 'satellite' }}>
        <group ref={body}>
          {/* bus: gold MLI, white radiators, dark decks */}
          <RoundedBox args={[1.2, 1.2, 1.6]} radius={0.04} smoothness={2} material={m.gold} />
          {[-1, 1].map((sz) => (
            <mesh key={`r${sz}`} material={m.radiator} position={[0, 0.02, sz * 0.805]} rotation={[0, sz > 0 ? 0 : Math.PI, 0]}>
              <planeGeometry args={[1.0, 1.0]} />
            </mesh>
          ))}
          <mesh material={m.silverFoil} position={[0, 0.605, 0]}>
            <boxGeometry args={[1.16, 0.02, 1.56]} />
          </mesh>
          <mesh material={m.darkMetal} position={[0, -0.61, 0]}>
            <boxGeometry args={[1.22, 0.04, 1.62]} />
          </mesh>
          {/* launch-adapter ring on the zenith deck */}
          <mesh material={m.frame} position={[0, 0.66, 0]}>
            <cylinderGeometry args={[0.36, 0.38, 0.08, 40, 1, true]} />
          </mesh>
          {/* solar wings on ±x */}
          <Wing side={1} m={m} wingRef={wingR} />
          <Wing side={-1} m={m} wingRef={wingL} />
          {/* star trackers (zenith side, baffled) */}
          {[-0.3, 0.3].map((x) => (
            <group key={x} position={[x, 0.78, 0.5]} rotation={[0.5, 0, x]}>
              <mesh material={m.blackAnod}>
                <cylinderGeometry args={[0.07, 0.09, 0.26, 16, 1, true]} />
              </mesh>
              <mesh material={m.silver} position={[0, -0.14, 0]}>
                <boxGeometry args={[0.16, 0.06, 0.16]} />
              </mesh>
            </group>
          ))}
          {/* GNSS patch, S-band patches, magnetorquers */}
          <mesh material={m.whitePaint} position={[0.25, 0.63, -0.5]}>
            <cylinderGeometry args={[0.1, 0.1, 0.03, 20]} />
          </mesh>
          {[-0.4, 0.4].map((x) => (
            <mesh key={`s${x}`} material={m.whitePaint} position={[x, -0.64, 0.6]}>
              <boxGeometry args={[0.16, 0.02, 0.16]} />
            </mesh>
          ))}
          {[-0.45, 0.45].map((x) => (
            <mesh key={x} material={m.darkMetal} position={[x, 0.42, 0.83]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.025, 0.025, 0.5, 8]} />
            </mesh>
          ))}
          {/* thrusters */}
          {[
            [-0.45, -0.45],
            [0.45, -0.45],
            [-0.45, 0.45],
            [0.45, 0.45],
          ].map(([x, y]) => (
            <mesh key={`${x}${y}`} material={m.silver} position={[x, y, -0.85]} rotation={[-Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.03, 0.06, 0.1, 12, 1, true]} />
            </mesh>
          ))}
          {/* RF high-gain antenna on a boom */}
          <group position={[0.38, -0.62, 0.95]}>
            <mesh material={m.frame} position={[0, -0.25, 0]}>
              <cylinderGeometry args={[0.025, 0.025, 0.5, 8]} />
            </mesh>
            <mesh geometry={dish} material={m.whitePaint} position={[0, -0.72, 0]} rotation={[Math.PI, 0, 0]} />
            <mesh material={m.darkMetal} position={[0, -0.55, 0]}>
              <cylinderGeometry args={[0.02, 0.02, 0.3, 6]} />
            </mesh>
          </group>
          {/* optical communication terminal on the nadir deck, on a 2-axis coarse pointing mount */}
          <group position={[-0.22, -0.75, -0.3]}>
            <mesh material={m.blackAnod}>
              <cylinderGeometry args={[0.2, 0.22, 0.14, 24]} />
            </mesh>
            <group ref={head} position={[0, -0.18, 0]}>
              {[-1, 1].map((sx) => (
                <mesh key={sx} material={m.blackAnod} position={[sx * 0.17, 0.02, 0]}>
                  <boxGeometry args={[0.04, 0.22, 0.1]} />
                </mesh>
              ))}
              <mesh material={m.whitePaint} position={[0, 0, -0.05]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.13, 0.13, 0.45, 28]} />
              </mesh>
              <mesh material={m.blackAnod} position={[0, 0, -0.33]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.14, 0.135, 0.14, 28, 1, true]} />
              </mesh>
              <mesh material={m.lens} position={[0, 0, -0.28]}>
                <circleGeometry args={[0.115, 32]} />
              </mesh>
              {/* red beacon laser emitter */}
              <mesh material={m.silver} position={[0.1, 0.12, -0.22]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.035, 0.035, 0.16, 12]} />
              </mesh>
              <mesh material={m.redLaser} position={[0.1, 0.12, -0.3]}>
                <sphereGeometry args={[0.03, 12, 12]} />
              </mesh>
              <object3D ref={beaconAnchor} position={[0.1, 0.12, -0.34]} />
            </group>
          </group>
          {/* satellite-laser-ranging retroreflector array (nadir): corner cubes on a plate */}
          <group position={[0.32, -0.64, -0.42]}>
            <mesh material={m.darkMetal}>
              <boxGeometry args={[0.3, 0.03, 0.3]} />
            </mesh>
            {[-1, 0, 1].flatMap((i) =>
              [-1, 0, 1].map((j) => (
                <mesh key={`${i}${j}`} material={m.lens} position={[i * 0.085, -0.03, j * 0.085]}>
                  <cylinderGeometry args={[0.035, 0.035, 0.035, 6]} />
                </mesh>
              )),
            )}
          </group>
          {/* X-band horn antenna (nadir) */}
          <mesh geometry={horn} material={m.silver} position={[-0.42, -0.74, 0.42]} rotation={[Math.PI, Math.PI / 4, 0]} />
          {/* UHF whip antennas at the nadir corners */}
          {[
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ].map(([sx, sz]) => (
            <mesh key={`w${sx}${sz}`} material={m.frame} position={[sx * 0.72, -0.9, sz * 0.92]} rotation={[sz * 0.5, 0, -sx * 0.5]}>
              <cylinderGeometry args={[0.007, 0.007, 0.8, 5]} />
            </mesh>
          ))}
          {/* magnetometer on a deployable boom (+z, away from the bus's magnetic field) */}
          <group position={[-0.35, 0.45, 0.82]} rotation={[0.5, 0, 0]}>
            <mesh material={m.frame} position={[0, 0, 0.65]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.015, 0.015, 1.3, 6]} />
            </mesh>
            <mesh material={m.whitePaint} position={[0, 0, 1.33]}>
              <boxGeometry args={[0.09, 0.09, 0.12]} />
            </mesh>
          </group>
          {/* coarse sun sensors on the zenith corners */}
          {[
            [-0.52, -0.72],
            [0.52, -0.72],
            [-0.52, 0.72],
            [0.52, 0.72],
          ].map(([x, z]) => (
            <group key={`css${x}${z}`} position={[x, 0.63, z]}>
              <mesh material={m.blackAnod}>
                <boxGeometry args={[0.07, 0.035, 0.07]} />
              </mesh>
              <mesh material={m.lens} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[0.022, 12]} />
              </mesh>
            </group>
          ))}
          {/* inter-satellite optical terminal on the zenith deck */}
          <group position={[-0.3, 0.72, -0.42]}>
            <mesh material={m.blackAnod}>
              <cylinderGeometry args={[0.13, 0.14, 0.12, 20]} />
            </mesh>
            <mesh material={m.whitePaint} position={[0, 0.15, 0.04]} rotation={[0.5, 0, 0]}>
              <cylinderGeometry args={[0.08, 0.08, 0.22, 20]} />
            </mesh>
            <mesh material={m.lens} position={[0, 0.25, 0.1]} rotation={[0.5 - Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.07, 20]} />
            </mesh>
          </group>
          {/* national flag decal on the anti-velocity radiator */}
          <mesh position={[0, 0.3, -0.812]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[0.36, 0.24]} />
            <meshStandardMaterial map={flag} roughness={0.6} metalness={0} />
          </mesh>
        </group>
      </group>
      {/* Beacon glow lives outside the scaled model so its screen size is constant. */}
      <sprite ref={halo} renderOrder={4}>
        <spriteMaterial map={glow} color={[3, 0.25, 0.2]} sizeAttenuation={false} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} transparent opacity={0.3} />
      </sprite>
      <sprite ref={beacon} renderOrder={5}>
        <spriteMaterial map={glow} color={[5, 1.1, 0.9]} sizeAttenuation={false} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
    </>
  );
}

/** Sun direction shared with the satellite (set by the stage). */
export const SUN_DIR = new THREE.Vector3(0, 1, 0);
