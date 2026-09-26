/** Top bar, view switch, demo caption, replay bar and toast. */
import { SCENARIO_PRESETS } from '../core/presets';
import { stateColor, useApp, ViewPreset } from '../state/store';
import { BrandMark, Icon, fmt, fmtClock } from './ui';
import { cameraApi } from '../scene/CameraRig';

export function TopBar() {
  const hud = useApp((s) => s.hud);
  const cfg = useApp((s) => s.config);
  const running = useApp((s) => s.running);
  const demo = useApp((s) => s.demo);
  const kind = useApp((s) => s.providerKind);
  const status = useApp((s) => s.providerStatus);
  const fps = useApp((s) => s.engineFps);
  const rec = useApp((s) => s.recording);
  const { send, setDrawer, startRecording, stopRecording, set } = useApp.getState();
  const preset = SCENARIO_PRESETS.find((p) => p.id === cfg.scenarioId);
  const state = hud?.state ?? 'IDLE';
  const inState = hud ? hud.t - hud.stateSince : 0;
  const src = kind === 'local' ? 'Local engine' : kind === 'remote' ? 'FastAPI engine' : 'Replay';
  const isReplay = kind === 'replay';

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <div>
          <div className="brand-word">ASTRAQ</div>
          <div className="brand-sub">Autonomous Spatial Tracking &amp; Alignment for Optical Links</div>
        </div>
      </div>
      <div className="topbar-mid">
        <button className="chip" onClick={() => setDrawer('scenario')} title="Change scenario">
          <span className="dim">Scenario</span> <b>{preset?.name ?? 'Custom'}</b>
        </button>
        <span className="chip mono">
          T+ <b>{fmtClock(hud?.t ?? 0)}</b>
        </span>
        <span className="chip opt" title="Where the simulation is running">
          <span className="dot" style={{ color: status === 'online' ? 'var(--lock)' : status === 'error' ? 'var(--lost)' : 'var(--amber)', background: 'currentColor' }} />
          <b>{src}</b>
          <span className="mono dim">
            {fmt(fps, 0)} fps · {fmt(hud?.procMs, 1)} ms
          </span>
        </span>
      </div>
      <div className="state-badge" style={{ color: stateColor(state) }} title="Acquisition & tracking state (driven by the state machine)">
        <span className="pulse" style={{ background: 'currentColor' }} />
        <span className="state-name">{state}</span>
        <span className="state-time">{inState.toFixed(1)} s</span>
      </div>
      <div className="row">
        <button className="btn icon" onClick={() => send({ type: running ? 'pause' : 'start' })} title={running ? 'Pause (Space)' : 'Run (Space)'}>
          <Icon name={running ? 'pause' : 'play'} />
        </button>
        <button className="btn icon" onClick={() => send({ type: 'reset' })} title="Reset run — new random start (R)" disabled={isReplay}>
          <Icon name="reset" />
        </button>
        <button className={`btn rec ${rec.active ? 'on' : ''}`} onClick={() => (rec.active ? stopRecording() : startRecording())} title="Record telemetry for export / replay">
          <span className="led" />
          {rec.active ? `REC ${(rec.frames / 30).toFixed(0)} s` : 'Record'}
        </button>
        <button className="btn primary" onClick={() => send({ type: 'demo', on: !demo })} disabled={isReplay} title="90 s guided demonstration (D)">
          {demo ? 'End demo' : 'Run demo'}
        </button>
        <button className={`btn icon ghost ${useApp.getState().themeOpen ? 'on' : ''}`} onClick={() => set({ themeOpen: !useApp.getState().themeOpen })} title="Theme">
          <Icon name="palette" />
        </button>
        <button className="btn icon ghost" onClick={() => set({ helpOpen: true })} title="What am I looking at? (?)">
          <Icon name="help" />
        </button>
      </div>
    </header>
  );
}

const VIEWS: { v: ViewPreset; label: string }[] = [
  { v: 'overview', label: 'Overview' },
  { v: 'terminal', label: 'Terminal' },
  { v: 'link', label: 'Spacecraft' },
  { v: 'sensor', label: 'Sensor POV' },
  { v: 'orbit', label: 'Orbit' },
];

export function ViewSwitch() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  return (
    <nav className="viewswitch glass">
      {VIEWS.map((v, i) => (
        <button key={v.v} className={view === v.v ? 'on' : ''} onClick={() => setView(v.v)}>
          {v.label}
          <kbd>{i + 1}</kbd>
        </button>
      ))}
      <span className="vs-sep" />
      <button className="vs-zoom" onClick={() => cameraApi.zoom(1.8)} title="Zoom out (−)" aria-label="Zoom out">
        <Icon name="minus" size={14} />
      </button>
      <button className="vs-zoom" onClick={() => cameraApi.zoom(0.55)} title="Zoom in (+, or the mouse wheel towards the cursor)" aria-label="Zoom in">
        <Icon name="plus" size={14} />
      </button>
    </nav>
  );
}

export function DemoCaption() {
  const demo = useApp((s) => s.hud?.demo);
  if (!demo) return null;
  return (
    <div className="caption glass">
      <div className="eyebrow">
        Demonstration · phase {demo.phase + 1} / {demo.phases}
      </div>
      <div className="title">{demo.title}</div>
      <p>{demo.caption}</p>
      <div className="prog">
        <i style={{ width: `${demo.progress * 100}%` }} />
      </div>
    </div>
  );
}

export function ReplayBar() {
  const replay = useApp((s) => s.replay);
  const running = useApp((s) => s.running);
  const { send, seekReplay, connect } = useApp.getState();
  if (!replay) return null;
  return (
    <div className="replaybar glass">
      <span className="tag sim">Replay</span>
      <button className="btn icon sm" onClick={() => send({ type: running ? 'pause' : 'start' })}>
        <Icon name={running ? 'pause' : 'play'} size={15} />
      </button>
      <input type="range" min={0} max={Math.max(1, replay.length - 1)} value={replay.position} onChange={(e) => seekReplay(parseInt(e.target.value, 10))} />
      <span className="mono dim" style={{ fontSize: 11 }}>
        {replay.position + 1}/{replay.length}
      </span>
      <button className="btn sm" onClick={() => connect('local')}>
        Exit replay
      </button>
    </div>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  return <div className="toast glass">{toast}</div>;
}
