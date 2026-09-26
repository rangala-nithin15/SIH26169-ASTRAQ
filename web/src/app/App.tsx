/**
 * ASTRAQ application shell: full-bleed 3D stage with the HUD layered on top.
 */
import { useEffect, useRef } from 'react';
import { Stage } from '../scene/Stage';
import { SceneLabels } from '../scene/Labels';
import { live, useApp } from '../state/store';
import { TopBar, ViewSwitch, DemoCaption, ReplayBar, Toast } from '../hud/Top';
import { SensorView, Timeline } from '../hud/Sensor';
import { Dock } from '../hud/Dock';
import { Analysis } from '../hud/Analysis';
import { Drawer, ToolRail } from '../hud/Drawers';
import { Help, MeasurePanel } from '../hud/Overlays';
import { ThemePopover } from '../hud/Theme';
import { VideoBench } from '../hud/VideoBench';
import { vis } from '../scene/vis';
import { cameraApi } from '../scene/CameraRig';
import { spaceAnchors, spaceBodies } from '../scene/space/SpaceObjects';

// Test hook for automated UI checks (read-only use).
(window as unknown as { __ASTRAQ__: unknown }).__ASTRAQ__ = { useApp, live, vis, space: spaceAnchors, bodies: spaceBodies };

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const st = useApp.getState();
      const views = ['overview', 'terminal', 'link', 'sensor', 'orbit'] as const;
      if (e.key === ' ') {
        e.preventDefault();
        st.send({ type: st.running ? 'pause' : 'start' });
      } else if (e.key === 'r' || e.key === 'R') st.send({ type: 'reset' });
      else if (e.key === 'd' || e.key === 'D') st.send({ type: 'demo', on: !st.demo });
      else if (e.key === 's' || e.key === 'S') st.set({ sensorExpanded: !st.sensorExpanded });
      else if (e.key === 'a' || e.key === 'A') st.set({ analysisOpen: !st.analysisOpen });
      else if (e.key === '?') st.set({ helpOpen: !st.helpOpen });
      else if (e.key === 'Escape') st.set({ helpOpen: false, sensorExpanded: false, drawer: null, themeOpen: false, videoOpen: false });
      else if (e.key === '+' || e.key === '=') cameraApi.zoom(0.6);
      else if (e.key === '-' || e.key === '_') cameraApi.zoom(1.66);
      else if (e.key === 'v' || e.key === 'V') st.set({ videoOpen: !st.videoOpen });
      else if (e.key === 't' || e.key === 'T') st.set({ themeOpen: !st.themeOpen });
      else if (e.key === 'p' || e.key === 'P') st.downloadReport('live', 'html');
      else if (e.key === 'f' || e.key === 'F') {
        const order = ['iss', 'sat2', 'sat3'] as const;
        const i = st.view === 'follow' ? order.indexOf(st.followKey) : -1;
        st.flyTo(order[(i + 1) % order.length]);
      } else if (e.key === 'g' || e.key === 'G') st.set({ sensorTab: st.sensorTab === 'screen' ? 'camera' : 'screen' });
      else if (e.key === 'm' || e.key === 'M') st.send({ type: 'mode', mode: st.hud?.mode === 'manual' ? 'auto' : 'manual' });
      else if (e.key >= '1' && e.key <= '5') st.setView(views[parseInt(e.key, 10) - 1]);
      else if (e.key.startsWith('Arrow') && st.hud?.mode === 'manual' && live.snap) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.1;
        const g = live.snap.gimbal;
        const dp = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dt = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        st.send({ type: 'manual', pan: g.pan + dp, tilt: g.tilt + dt });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const hud = useApp((s) => s.hud);
  const drawer = useApp((s) => s.drawer);
  const providerKind = useApp((s) => s.providerKind);
  const resetNonce = useApp((s) => s.resetNonce);
  const booted = useRef(false);
  const framed = useRef(false);
  useKeyboard();

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const st = useApp.getState();
    st.connect('local').then(() => st.setQuality(st.quality));
  }, []);

  // Re-frame whenever the telemetry source changes.
  useEffect(() => {
    framed.current = false;
  }, [providerKind, resetNonce]);

  // Frame the hero view once the first telemetry (satellite position) is known.
  useEffect(() => {
    if (hud && !framed.current && hud.t > 0.1) {
      framed.current = true;
      setTimeout(() => {
        const v = useApp.getState().view;
        useApp.getState().setView(v === 'free' ? 'overview' : v);
      }, 50);
    }
  }, [hud]);

  return (
    <div className={`app ${drawer ? 'has-drawer' : ''}`}>
      <Stage />
      <div className="stage-shade" />
      <SceneLabels />
      {!hud && (
        <div className="boot">
          <div>INITIALISING ENGINE…</div>
        </div>
      )}
      <TopBar />
      <ViewSwitch />
      <DemoCaption />
      <ReplayBar />
      <ToolRail />
      <Drawer />
      <MeasurePanel />
      <div className="rightcol">
        <SensorView />
        <Timeline />
      </div>
      <Analysis />
      <Dock />
      <Help />
      <ThemePopover />
      <VideoBench />
      <Toast />
    </div>
  );
}
