/**
 * Minimal scene labels. The label DOM lives outside the canvas (<SceneLabels/>); an
 * in-scene projector moves it every frame. No extra React roots are created.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { vis } from './vis';
import { useApp } from '../state/store';
import { SPACE_TAGS, anchorOn, spaceAnchors } from './space/SpaceObjects';

const IDS = ['aq-label-terminal', 'aq-label-remote', 'aq-label-link'] as const;

function Tag({ id, title, sub, tone }: { id: string; title: string; sub?: string; tone?: 'ice' | 'lock' | 'dim' }) {
  return (
    <div id={id} className={`scene-tag ${tone ?? ''}`} style={{ position: 'absolute', left: 0, top: 0, display: 'none' }}>
      <span className="scene-tag-rule" />
      <span className="scene-tag-text">
        <b>{title}</b>
        {sub && <i>{sub}</i>}
      </span>
    </div>
  );
}

/** DOM part: rendered once, above the canvas and below the HUD. */
export function SceneLabels() {
  const remote = useApp((s) => s.config.scene.remote);
  const alt = useApp((s) => s.config.scene.altitudeKm);
  const remoteName = remote === 'leo' ? `LEO · ${alt.toFixed(0)} km` : remote === 'haps' ? 'HAPS' : 'UAV';
  return (
    <div className="scene-labels" aria-hidden>
      <Tag id={IDS[0]} title="Mobile FSOC terminal" sub="pan/tilt gimbal · optical camera" />
      <Tag id={IDS[1]} title="Remote terminal" sub={`${remoteName} · optical beacon`} tone="ice" />
      <Tag id={IDS[2]} title="Optical link" sub="coarse alignment locked" tone="lock" />
      {SPACE_TAGS.map((t) => (
        <Tag key={t.key} id={`aq-label-${t.key}`} title={t.title} sub={t.sub} tone="dim" />
      ))}
    </div>
  );
}

/** Scene part: projects the anchor points and positions the DOM labels. */
export function LabelProjector() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const sizes = useMemo(() => new Map<string, [number, number]>(), []);
  useFrame(() => {
    const { overlays, view } = useApp.getState();
    const hidden = !overlays.labels || view === 'sensor' || view === 'link' || view === 'follow';
    // Candidates in priority order: link labels first, then other space traffic.
    const items: { id: string; a: THREE.Vector3 | null; space?: boolean }[] = [
      { id: IDS[0], a: new THREE.Vector3(0, 0.0078 * vis.terminalScale, 0) },
      { id: IDS[1], a: vis.sat.clone().add(new THREE.Vector3(0, 0.0035 * vis.satScale, 0)) },
      { id: IDS[2], a: vis.state === 'LOCKED' ? vis.lens.clone().lerp(vis.beacon, 0.55) : null },
    ];
    const hideSpace = hidden || !overlays.space || view === 'orbit';
    for (const t of SPACE_TAGS) items.push({ id: `aq-label-${t.key}`, a: !hideSpace && anchorOn[t.key] ? spaceAnchors[t.key] ?? null : null, space: true });
    const placed: [number, number, number, number][] = [];
    for (const it of items) {
      const el = document.getElementById(it.id);
      if (!el) continue;
      if (hidden || !it.a) {
        el.style.display = 'none';
        continue;
      }
      tmp.copy(it.a).project(camera);
      const onScreen = it.space
        ? tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 0.95 && tmp.y > -0.9 && tmp.y < 0.66
        : tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
      if (!onScreen) {
        el.style.display = 'none';
        continue;
      }
      const x = ((tmp.x + 1) / 2) * size.width;
      const y = ((1 - tmp.y) / 2) * size.height;
      el.style.display = 'flex';
      // Label box (drawn up and to the right of the anchor); skip it if it would cover a
      // higher-priority label — e.g. in the Orbit view, where terminal and satellite are close.
      let wh = sizes.get(it.id);
      if (!wh || wh[0] === 0) {
        wh = [el.offsetWidth, el.offsetHeight];
        sizes.set(it.id, wh);
      }
      const r: [number, number, number, number] = [x, y - wh[1], x + wh[0], y];
      if (placed.some((q) => r[0] < q[2] + 6 && r[2] + 6 > q[0] && r[1] < q[3] + 4 && r[3] + 4 > q[1])) {
        el.style.display = 'none';
        continue;
      }
      placed.push(r);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(0, -100%)`;
    }
  });
  return null;
}
