/**
 * Transportable FSOC ground terminal (modelled in metres, rendered in km).
 *
 * Form follows real transportable optical ground stations: a 6×6 truck carries an
 * ISO-style shelter whose roof opens; inside, a pier lifts the telescope's
 * azimuth-over-elevation fork mount above the roof line. Stabiliser jacks are down,
 * a diesel generator powers the site and a floodlight lights the pad.
 *
 * Gimbal hierarchy (what the simulation drives):
 *   VEHICLE BASE (heading 150°)
 *     └─ PIER TOP MOUNT (north-referenced after levelling; platform disturbance)
 *          └─ PAN AXIS  (rotation about local up  = −azimuth)
 *               └─ TILT AXIS (rotation about local east = +elevation)
 *                    └─ OPTICAL PAYLOAD: telescope, acquisition camera, red beacon laser
 */
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { makeMaterials } from './materials';
import { TERMINAL_HEADING_DEG, vis } from '../vis';
import { STATE_HEX, useApp } from '../../state/store';

type M = ReturnType<typeof makeMaterials>;

const PIER_TOP = 4.05; // m above ground
const TILT_AXIS_UP = 0.62; // m above the pan turntable
const ROOF_Y = 3.6;
const CONT_Z = 1.05;
const CONT_L = 4.7;
const CONT_W = 2.44;
const CONT_BOTTOM = 1.25;

function Wheel({ x, z, m }: { x: number; z: number; m: M }) {
  const sx = Math.sign(x);
  return (
    <group position={[x, 0.55, z]} rotation={[0, 0, Math.PI / 2]}>
      <mesh material={m.tyre} castShadow>
        <cylinderGeometry args={[0.55, 0.55, 0.42, 40]} />
      </mesh>
      <mesh material={m.tyre} position={[0, sx * 0.212, 0]}>
        <torusGeometry args={[0.45, 0.07, 10, 40]} />
      </mesh>
      <mesh material={m.rim} position={[0, sx * 0.2, 0]}>
        <cylinderGeometry args={[0.33, 0.35, 0.05, 28]} />
      </mesh>
      <mesh material={m.chassis} position={[0, sx * 0.23, 0]}>
        <cylinderGeometry args={[0.13, 0.15, 0.06, 18]} />
      </mesh>
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i} material={m.silver} position={[Math.cos((i / 8) * Math.PI * 2) * 0.22, sx * 0.235, Math.sin((i / 8) * Math.PI * 2) * 0.22]}>
          <cylinderGeometry args={[0.022, 0.022, 0.04, 8]} />
        </mesh>
      ))}
    </group>
  );
}

function Fender({ x, z, m }: { x: number; z: number; m: M }) {
  return (
    <mesh material={m.trim} position={[x, 0.55, z]} rotation={[0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[0.66, 0.66, 0.5, 24, 1, true, -Math.PI / 2 + 0.25, Math.PI - 0.5]} />
    </mesh>
  );
}

function Jack({ x, z, m }: { x: number; z: number; m: M }) {
  const sx = Math.sign(x);
  return (
    <group position={[x, 0, z]}>
      <mesh material={m.chassis} position={[-sx * 0.3, 1.18, 0]}>
        <boxGeometry args={[0.7, 0.14, 0.16]} />
      </mesh>
      <mesh material={m.orange} position={[0, 0.8, 0]}>
        <boxGeometry args={[0.14, 0.7, 0.14]} />
      </mesh>
      <mesh material={m.silver} position={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.6, 12]} />
      </mesh>
      <mesh material={m.chassis} position={[0, 0.025, 0]} receiveShadow>
        <boxGeometry args={[0.36, 0.05, 0.36]} />
      </mesh>
    </group>
  );
}

function Cone({ x, z, m }: { x: number; z: number; m: M }) {
  return (
    <group position={[x, 0, z]}>
      <mesh material={m.trim} position={[0, 0.015, 0]}>
        <boxGeometry args={[0.38, 0.03, 0.38]} />
      </mesh>
      <mesh material={m.orange} position={[0, 0.37, 0]}>
        <cylinderGeometry args={[0.03, 0.15, 0.7, 20]} />
      </mesh>
      <mesh material={m.reflect} position={[0, 0.42, 0]}>
        <cylinderGeometry args={[0.078, 0.095, 0.12, 20, 1, true]} />
      </mesh>
    </group>
  );
}

/** Roof panel hinged along a long edge of the shelter, swung open. */
function RoofPanel({ side, m }: { side: 1 | -1; m: M }) {
  return (
    <group position={[side * CONT_W / 2, ROOF_Y, CONT_Z]} rotation={[0, 0, -side * 1.95]}>
      <mesh material={m.container} position={[-side * CONT_W / 4, 0.03, 0]} castShadow>
        <boxGeometry args={[CONT_W / 2, 0.06, CONT_L - 0.05]} />
      </mesh>
      <mesh material={m.frame} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.04, 0.04, CONT_L - 0.1, 10]} />
      </mesh>
      {/* hydraulic strut */}
      <mesh material={m.silver} position={[-side * 0.4, -0.25, CONT_L / 2 - 0.4]} rotation={[0, 0, side * 0.8]}>
        <cylinderGeometry args={[0.025, 0.025, 0.8, 8]} />
      </mesh>
    </group>
  );
}

export function GroundTerminal() {
  const m = useMemo(makeMaterials, []);
  const quality = useApp((s) => s.quality);
  const root = useRef<THREE.Group>(null);
  const mount = useRef<THREE.Group>(null);
  const pan = useRef<THREE.Group>(null);
  const tilt = useRef<THREE.Group>(null);
  const lensAnchor = useRef<THREE.Object3D>(null);
  const status = useRef<THREE.MeshStandardMaterial>(null);
  const beaconLamp = useRef<THREE.MeshStandardMaterial>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  // Container walls: outer face textured, inner face dark (the roof is open).
  const wallMats = useMemo(() => {
    const out = m.container;
    const inn = m.interior;
    return {
      side: (s: 1 | -1) => (s > 0 ? [out, inn, out, out, out, out] : [inn, out, out, out, out, out]),
      end: (s: 1 | -1) => (s > 0 ? [out, out, out, out, out, inn] : [out, out, out, out, inn, out]),
    };
  }, [m]);

  const cable = useMemo(() => {
    const pts = [new THREE.Vector3(-1.25, 1.7, 3.0), new THREE.Vector3(-1.5, 1.0, 3.2), new THREE.Vector3(-1.9, 0.2, 3.3), new THREE.Vector3(-2.6, 0.03, 3.0), new THREE.Vector3(-3.3, 0.03, 2.3)];
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.03, 8, false);
  }, []);
  const pierCable = useMemo(() => {
    const pts = [new THREE.Vector3(0.18, 1.6, CONT_Z + 0.4), new THREE.Vector3(0.24, 2.6, CONT_Z + 0.3), new THREE.Vector3(0.24, 3.6, CONT_Z + 0.3), new THREE.Vector3(0.16, 4.1, CONT_Z + 0.2)];
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.025, 8, false);
  }, []);

  useFrame(() => {
    if (!root.current || !pan.current || !tilt.current || !mount.current) return;
    root.current.scale.setScalar(0.001 * vis.terminalScale);
    pan.current.rotation.y = -THREE.MathUtils.degToRad(vis.pan);
    tilt.current.rotation.x = THREE.MathUtils.degToRad(vis.tilt);
    // Platform disturbance (what the encoders cannot see) tilts the pier top slightly.
    mount.current.rotation.set(THREE.MathUtils.degToRad(vis.dTilt), THREE.MathUtils.degToRad(TERMINAL_HEADING_DEG) - THREE.MathUtils.degToRad(vis.dPan), 0);
    if (lensAnchor.current) {
      lensAnchor.current.getWorldPosition(tmp);
      vis.lens.copy(tmp);
    }
    const col = STATE_HEX[vis.state];
    if (status.current) {
      status.current.emissive.set(col);
      const blink = vis.state === 'SEARCHING' || vis.state === 'REACQUIRING' ? 0.4 + 0.6 * Math.abs(Math.sin(vis.time * 4)) : 1;
      status.current.emissiveIntensity = 3 * blink;
    }
    if (beaconLamp.current) beaconLamp.current.emissiveIntensity = vis.state === 'LOCKED' ? 5 + 1.5 * Math.sin(vis.time * 10) : 1.2;
  });

  const heading = -THREE.MathUtils.degToRad(TERMINAL_HEADING_DEG);
  const shadows = quality === 'high';
  const lights = quality !== 'low';

  return (
    <group ref={root} userData={{ measure: 'terminal' }}>
      <group rotation={[0, heading, 0]}>
        {/* ── Chassis & running gear ──────────────────────────── */}
        {[-1.02, 1.02].map((x) => [-2.35, 1.2, 2.55].map((z) => <Wheel key={`${x}${z}`} x={x} z={z} m={m} />))}
        {[-1.02, 1.02].map((x) => [-2.35, 1.2, 2.55].map((z) => <Fender key={`f${x}${z}`} x={x} z={z} m={m} />))}
        {[-0.48, 0.48].map((x) => (
          <mesh key={x} material={m.chassis} position={[x, 0.98, 0.1]} castShadow={shadows}>
            <boxGeometry args={[0.18, 0.28, 6.7]} />
          </mesh>
        ))}
        {[-2.3, -0.6, 1.2, 2.6].map((z) => (
          <mesh key={z} material={m.chassis} position={[0, 0.98, z]}>
            <boxGeometry args={[1.0, 0.12, 0.12]} />
          </mesh>
        ))}
        {/* fuel tank + tool box */}
        <mesh material={m.frame} position={[-1.0, 0.8, -0.55]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.28, 0.28, 1.1, 24]} />
        </mesh>
        <mesh material={m.trim} position={[1.0, 0.85, -0.5]}>
          <boxGeometry args={[0.4, 0.45, 1.0]} />
        </mesh>

        {/* ── Cab ────────────────────────────────────────────── */}
        <group position={[0, 0, -2.55]}>
          <RoundedBox args={[2.45, 1.75, 1.9]} radius={0.12} smoothness={3} position={[0, 2.05, 0]} material={m.paint} castShadow={shadows} />
          <RoundedBox args={[2.5, 0.55, 1.95]} radius={0.08} smoothness={2} position={[0, 1.2, -0.05]} material={m.paint} />
          {/* windscreen + side windows */}
          <mesh material={m.glass} position={[0, 2.45, -0.962]} rotation={[-0.08, 0, 0]}>
            <planeGeometry args={[2.15, 0.82]} />
          </mesh>
          {[-1, 1].map((sx) => (
            <mesh key={sx} material={m.glass} position={[sx * 1.228, 2.45, -0.15]} rotation={[0, (sx * Math.PI) / 2, 0]}>
              <planeGeometry args={[1.1, 0.7]} />
            </mesh>
          ))}
          {/* door seams + handles */}
          {[-1, 1].map((sx) => (
            <group key={`d${sx}`}>
              <mesh material={m.trim} position={[sx * 1.229, 1.75, 0.45]}>
                <boxGeometry args={[0.01, 1.4, 0.02]} />
              </mesh>
              <mesh material={m.frame} position={[sx * 1.24, 1.85, 0.3]}>
                <boxGeometry args={[0.03, 0.04, 0.18]} />
              </mesh>
              <mesh material={m.trim} position={[sx * 1.1, 0.72, -0.1]}>
                <boxGeometry args={[0.3, 0.05, 0.6]} />
              </mesh>
            </group>
          ))}
          {/* grille, bumper, lights */}
          <mesh material={m.trim} position={[0, 1.35, -0.99]}>
            <boxGeometry args={[1.5, 0.5, 0.04]} />
          </mesh>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh key={i} material={m.frame} position={[0, 1.16 + i * 0.09, -1.015]}>
              <boxGeometry args={[1.45, 0.018, 0.02]} />
            </mesh>
          ))}
          <RoundedBox args={[2.6, 0.32, 0.32]} radius={0.05} smoothness={2} position={[0, 0.82, -1.05]} material={m.trim} />
          {[-1, 1].map((sx) => (
            <mesh key={`h${sx}`} material={m.headlight} position={[sx * 0.95, 1.3, -1.0]}>
              <boxGeometry args={[0.32, 0.16, 0.03]} />
            </mesh>
          ))}
          <mesh material={m.amber} position={[0, 2.97, -0.2]}>
            <boxGeometry args={[1.2, 0.08, 0.18]} />
          </mesh>
          {/* mirrors */}
          {[-1, 1].map((sx) => (
            <group key={`m${sx}`} position={[sx * 1.4, 2.35, -0.75]}>
              <mesh material={m.trim} position={[-sx * 0.1, 0, 0]}>
                <boxGeometry args={[0.2, 0.03, 0.03]} />
              </mesh>
              <mesh material={m.trim}>
                <boxGeometry args={[0.06, 0.42, 0.22]} />
              </mesh>
            </group>
          ))}
          {/* exhaust stack */}
          <mesh material={m.chassis} position={[1.05, 2.4, 1.05]}>
            <cylinderGeometry args={[0.07, 0.07, 2.2, 12]} />
          </mesh>
        </group>

        {/* ── Shelter (ISO container, roof open) ─────────────── */}
        <mesh material={m.chassis} position={[0, CONT_BOTTOM - 0.08, CONT_Z]}>
          <boxGeometry args={[CONT_W, 0.16, CONT_L]} />
        </mesh>
        {([-1, 1] as const).map((sx) => (
          <mesh key={`w${sx}`} material={wallMats.side(sx)} position={[sx * (CONT_W / 2 - 0.03), (CONT_BOTTOM + ROOF_Y) / 2, CONT_Z]} castShadow={shadows} receiveShadow={shadows}>
            <boxGeometry args={[0.06, ROOF_Y - CONT_BOTTOM, CONT_L]} />
          </mesh>
        ))}
        {([-1, 1] as const).map((sz) => (
          <mesh key={`e${sz}`} material={wallMats.end(sz)} position={[0, (CONT_BOTTOM + ROOF_Y) / 2, CONT_Z + sz * (CONT_L / 2 - 0.03)]} castShadow={shadows}>
            <boxGeometry args={[CONT_W - 0.12, ROOF_Y - CONT_BOTTOM, 0.06]} />
          </mesh>
        ))}
        {/* raised floor + equipment racks visible through the open roof */}
        <mesh material={m.interior} position={[0, 1.55, CONT_Z]}>
          <boxGeometry args={[CONT_W - 0.14, 0.05, CONT_L - 0.14]} />
        </mesh>
        {[-0.8, 0.8].map((x) =>
          [-1.5, 2.0].map((dz) => (
            <group key={`r${x}${dz}`} position={[x, 2.3, CONT_Z + dz * 0.8]}>
              <mesh material={m.chassis}>
                <boxGeometry args={[0.6, 1.5, 0.7]} />
              </mesh>
              {[0.4, 0.2, 0, -0.2].map((y, i) => (
                <mesh key={y} position={[-Math.sign(x) * 0.301, y, 0.2 - i * 0.1]}>
                  <boxGeometry args={[0.005, 0.03, 0.05]} />
                  <meshStandardMaterial color="#111" emissive={['#9cf5c8', '#8fdcff', '#ffb547', '#9cf5c8'][i]} emissiveIntensity={2.5} toneMapped={false} />
                </mesh>
              ))}
            </group>
          )),
        )}
        {/* top rails + corner castings */}
        {[-1, 1].map((sx) => (
          <mesh key={`tr${sx}`} material={m.frame} position={[sx * (CONT_W / 2 - 0.03), ROOF_Y + 0.02, CONT_Z]}>
            <boxGeometry args={[0.1, 0.05, CONT_L]} />
          </mesh>
        ))}
        {[-1, 1].map((sx) =>
          [-1, 1].map((sz) =>
            [CONT_BOTTOM + 0.05, ROOF_Y - 0.03].map((y) => (
              <mesh key={`c${sx}${sz}${y}`} material={m.trim} position={[sx * (CONT_W / 2 - 0.02), y, CONT_Z + sz * (CONT_L / 2 - 0.02)]}>
                <boxGeometry args={[0.18, 0.12, 0.18]} />
              </mesh>
            )),
          ),
        )}
        <RoofPanel side={1} m={m} />
        <RoofPanel side={-1} m={m} />
        {/* status strip + AC unit + ladder + antennas */}
        <mesh position={[CONT_W / 2 + 0.005, 3.2, CONT_Z - 1.6]}>
          <boxGeometry args={[0.02, 0.07, 0.6]} />
          <meshStandardMaterial ref={status} color="#111" emissive="#ffb547" emissiveIntensity={3} toneMapped={false} />
        </mesh>
        <mesh material={m.trim} position={[0, 2.75, CONT_Z - CONT_L / 2 - 0.15]}>
          <boxGeometry args={[1.2, 0.8, 0.28]} />
        </mesh>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <mesh key={`ac${i}`} material={m.frame} position={[0, 2.45 + i * 0.1, CONT_Z - CONT_L / 2 - 0.3]}>
            <boxGeometry args={[1.1, 0.02, 0.02]} />
          </mesh>
        ))}
        {[-0.2, 0.2].map((x) => (
          <mesh key={`l${x}`} material={m.frame} position={[x + 0.7, 2.4, CONT_Z + CONT_L / 2 + 0.08]}>
            <boxGeometry args={[0.04, 2.3, 0.04]} />
          </mesh>
        ))}
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <mesh key={`lr${i}`} material={m.frame} position={[0.7, 1.4 + i * 0.3, CONT_Z + CONT_L / 2 + 0.08]}>
            <boxGeometry args={[0.44, 0.03, 0.03]} />
          </mesh>
        ))}
        <mesh material={m.blackAnod} position={[-1.05, 4.2, CONT_Z + 2.1]}>
          <cylinderGeometry args={[0.012, 0.02, 1.2, 6]} />
        </mesh>
        <mesh material={m.whitePaint} position={[-0.95, ROOF_Y + 0.08, CONT_Z - 2.0]}>
          <cylinderGeometry args={[0.09, 0.1, 0.07, 20]} />
        </mesh>
        {[-1.35, 1.35].map((x) => [CONT_Z - 2.1, CONT_Z + 2.1].map((z) => <Jack key={`j${x}${z}`} x={x} z={z} m={m} />))}

        {/* ── Telescope pier (rises through the open roof) ───── */}
        <group position={[0, 0, CONT_Z + 0.2]}>
          <mesh material={m.whitePaint} position={[0, (1.58 + PIER_TOP) / 2, 0]} castShadow={shadows}>
            <cylinderGeometry args={[0.2, 0.26, PIER_TOP - 1.58, 28]} />
          </mesh>
          <mesh material={m.frame} position={[0, 1.62, 0]}>
            <cylinderGeometry args={[0.42, 0.46, 0.08, 28]} />
          </mesh>
          <mesh material={m.frame} position={[0, PIER_TOP - 0.03, 0]}>
            <cylinderGeometry args={[0.3, 0.3, 0.06, 28]} />
          </mesh>
        </group>
        <mesh geometry={pierCable} material={m.cable} />

        {/* ── Gimbal: pier-top mount (north-referenced) ──────── */}
        <group position={[0, PIER_TOP, CONT_Z + 0.2]}>
          <group ref={mount}>
            <mesh material={m.blackAnod} position={[0, 0.03, 0]}>
              <cylinderGeometry args={[0.26, 0.26, 0.06, 32]} />
            </mesh>
            {/* PAN AXIS */}
            <group ref={pan}>
              <mesh material={m.blackAnod} position={[0, 0.13, 0]} castShadow={shadows}>
                <cylinderGeometry args={[0.32, 0.32, 0.14, 40]} />
              </mesh>
              <mesh material={m.silver} position={[0, 0.13, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[0.325, 0.012, 8, 64]} />
              </mesh>
              <mesh material={m.darkMetal} position={[0.36, 0.12, 0.06]}>
                <cylinderGeometry args={[0.08, 0.08, 0.18, 16]} />
              </mesh>
              <mesh material={m.whitePaint} position={[0, 0.24, 0]}>
                <boxGeometry args={[1.06, 0.07, 0.3]} />
              </mesh>
              {/* fork arms */}
              {[-1, 1].map((sx) => (
                <mesh key={sx} material={m.whitePaint} position={[sx * 0.5, 0.55, 0]} castShadow={shadows}>
                  <boxGeometry args={[0.08, 0.66, 0.26]} />
                </mesh>
              ))}
              {/* TILT AXIS */}
              <group ref={tilt} position={[0, TILT_AXIS_UP + 0.22, 0]}>
                <mesh material={m.silver} rotation={[0, 0, Math.PI / 2]}>
                  <cylinderGeometry args={[0.04, 0.04, 1.1, 12]} />
                </mesh>
                {[-1, 1].map((sx) => (
                  <group key={sx} position={[sx * 0.58, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                    <mesh material={m.darkMetal}>
                      <cylinderGeometry args={[0.11, 0.11, 0.1, 24]} />
                    </mesh>
                    <mesh position={[0, sx * 0.055, 0]}>
                      <cylinderGeometry args={[0.08, 0.08, 0.012, 24]} />
                      <meshStandardMaterial color="#3aa6d6" emissive="#1f7fa8" emissiveIntensity={0.6} metalness={0.5} roughness={0.3} />
                    </mesh>
                  </group>
                ))}
                {/* OPTICAL PAYLOAD (points along −z) */}
                <mesh material={m.whitePaint} position={[0, 0, -0.05]} rotation={[Math.PI / 2, 0, 0]} castShadow={shadows}>
                  <cylinderGeometry args={[0.24, 0.24, 1.0, 48]} />
                </mesh>
                {[-0.35, 0.25].map((z) => (
                  <mesh key={z} material={m.frame} position={[0, 0, z]} rotation={[Math.PI / 2, 0, 0]}>
                    <torusGeometry args={[0.245, 0.012, 8, 48]} />
                  </mesh>
                ))}
                <mesh material={m.blackAnod} position={[0, 0, -0.72]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.265, 0.25, 0.36, 48, 1, true]} />
                </mesh>
                <mesh material={m.lens} position={[0, 0, -0.57]}>
                  <circleGeometry args={[0.22, 48]} />
                </mesh>
                <object3D ref={lensAnchor} position={[0, 0, -0.6]} />
                <mesh material={m.blackAnod} position={[0, 0, -0.585]}>
                  <cylinderGeometry args={[0.06, 0.06, 0.03, 16]} />
                </mesh>
                {[0, 1, 2].map((i) => (
                  <mesh key={i} material={m.blackAnod} position={[0, 0, -0.585]} rotation={[0, 0, (i * Math.PI) / 3]}>
                    <boxGeometry args={[0.44, 0.008, 0.01]} />
                  </mesh>
                ))}
                {/* rear cell + electronics + counterweight */}
                <mesh material={m.darkMetal} position={[0, 0, 0.5]}>
                  <cylinderGeometry args={[0.2, 0.24, 0.12, 32]} />
                </mesh>
                <mesh material={m.darkMetal} position={[0, -0.05, 0.62]}>
                  <boxGeometry args={[0.32, 0.28, 0.2]} />
                </mesh>
                <mesh material={m.blackAnod} position={[0, -0.3, 0.3]}>
                  <boxGeometry args={[0.22, 0.12, 0.34]} />
                </mesh>
                {/* acquisition camera (the simulated sensor) */}
                <group position={[0, 0.33, -0.15]}>
                  <mesh material={m.blackAnod}>
                    <boxGeometry args={[0.14, 0.13, 0.3]} />
                  </mesh>
                  <mesh material={m.blackAnod} position={[0, 0, -0.2]} rotation={[Math.PI / 2, 0, 0]}>
                    <cylinderGeometry args={[0.055, 0.05, 0.12, 20]} />
                  </mesh>
                  <mesh material={m.lens} position={[0, 0, -0.262]}>
                    <circleGeometry args={[0.045, 24]} />
                  </mesh>
                  <mesh material={m.darkMetal} position={[0, -0.09, 0]}>
                    <boxGeometry args={[0.06, 0.06, 0.12]} />
                  </mesh>
                </group>
                {/* uplink beacon laser (red) on the side */}
                <group position={[0.34, 0.1, -0.25]} rotation={[Math.PI / 2, 0, 0]}>
                  <mesh material={m.silver}>
                    <cylinderGeometry args={[0.045, 0.045, 0.36, 16]} />
                  </mesh>
                  <mesh position={[0, -0.185, 0]}>
                    <circleGeometry args={[0.035, 16]} />
                    <meshStandardMaterial ref={beaconLamp} color="#ff3030" emissive="#ff2020" emissiveIntensity={1.2} toneMapped={false} side={THREE.DoubleSide} />
                  </mesh>
                </group>
                {[-0.07, 0, 0.07].map((x, i) => (
                  <mesh key={x} position={[x, 0.07, 0.725]}>
                    <sphereGeometry args={[0.014, 8, 8]} />
                    <meshStandardMaterial color="#111" emissive={['#9cf5c8', '#8fdcff', '#ffb547'][i]} emissiveIntensity={2} toneMapped={false} />
                  </mesh>
                ))}
              </group>
            </group>
          </group>
        </group>

        {/* ── Site: generator, cable, floodlight, cones ──────── */}
        <group position={[-3.6, 0, 1.8]} rotation={[0, 0.3, 0]}>
          <RoundedBox args={[1.1, 1.0, 1.8]} radius={0.06} smoothness={2} position={[0, 0.62, 0]} material={m.paint} castShadow={shadows} />
          <mesh material={m.trim} position={[0, 0.08, 0]}>
            <boxGeometry args={[1.15, 0.16, 1.9]} />
          </mesh>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh key={i} material={m.trim} position={[0.556, 0.5 + i * 0.1, 0.3]}>
              <boxGeometry args={[0.01, 0.04, 0.7]} />
            </mesh>
          ))}
          <mesh material={m.chassis} position={[-0.3, 1.25, -0.6]}>
            <cylinderGeometry args={[0.04, 0.04, 0.3, 10]} />
          </mesh>
        </group>
        <mesh geometry={cable} material={m.cable} />
        <group position={[3.3, 0, -1.2]}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} material={m.trim} position={[Math.cos((i * 2 * Math.PI) / 3) * 0.45, 0.75, Math.sin((i * 2 * Math.PI) / 3) * 0.45]} rotation={[Math.sin((i * 2 * Math.PI) / 3) * 0.55, 0, -Math.cos((i * 2 * Math.PI) / 3) * 0.55]}>
              <cylinderGeometry args={[0.025, 0.025, 1.7, 8]} />
            </mesh>
          ))}
          <mesh material={m.silver} position={[0, 2.2, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 1.6, 8]} />
          </mesh>
          <group position={[0, 3.0, 0]} rotation={[0.35, -0.9, 0]}>
            <mesh material={m.trim}>
              <boxGeometry args={[0.5, 0.35, 0.15]} />
            </mesh>
            <mesh material={m.headlight} position={[0, 0, -0.08]}>
              <planeGeometry args={[0.44, 0.29]} />
            </mesh>
          </group>
          {lights && <pointLight position={[-0.6, 2.8, 0.4]} color="#ffe0b0" intensity={6e-5} distance={0.04} decay={2} />}
        </group>
        {lights && <pointLight position={[0, 5.2, -4.5]} color="#ffd9a8" intensity={3.5e-5} distance={0.03} decay={2} />}
        {lights && <pointLight position={[2.5, 6.5, 5.5]} color="#cfe0ff" intensity={2.5e-5} distance={0.03} decay={2} />}
        {[
          [-3.2, -4.5],
          [3.2, -4.5],
          [4.2, 3.8],
          [-4.6, 4.4],
          [0, 6.0],
          [4.6, 0.8],
        ].map(([x, z]) => (
          <Cone key={`${x}${z}`} x={x} z={z} m={m} />
        ))}
      </group>
    </group>
  );
}
