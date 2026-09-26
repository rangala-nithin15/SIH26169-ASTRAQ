/**
 * Tool rail + contextual drawers (progressive disclosure: every advanced parameter
 * lives here, hidden until needed).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DrawerId, recorder, useApp } from '../state/store';
import { SCENARIO_PRESETS, presetConfig } from '../core/presets';
import { DETECTION_PROVIDERS } from '../core/detection/registry';
import { VERIFIER } from '../core/detection/verifier';
import { buildReport } from '../core/analysis/report';
import { saveReport } from '../state/store';
import { intrinsics, SimConfig, TrajectoryKind } from '../core/config';
import { acquisitionProbability } from '../core/analysis/link';
import { isRecording } from '../core/telemetry/recorder';
import type { BatchMessage, BatchRunResult } from '../engine/batch.worker';
import { Icon, Section, Seg, Slider, Toggle, fmt } from './ui';
import { ThemeList } from './Theme';

const TOOLS: { id: Exclude<DrawerId, null>; icon: string; label: string }[] = [
  { id: 'scenario', icon: 'scenario', label: 'Scenario & geometry' },
  { id: 'target', icon: 'target', label: 'Target motion & beacon' },
  { id: 'disturbance', icon: 'disturbance', label: 'Disturbances & environment' },
  { id: 'tracking', icon: 'tracking', label: 'Detection · Kalman · PID · gimbal' },
  { id: 'optics', icon: 'optics', label: 'Camera calibration & link budget' },
  { id: 'experiment', icon: 'experiment', label: 'Experiments · record · replay · batch' },
  { id: 'view', icon: 'view', label: 'View, quality & overlays' },
];

export function ToolRail() {
  const drawer = useApp((s) => s.drawer);
  const measure = useApp((s) => s.measure);
  const setDrawer = useApp((s) => s.setDrawer);
  const set = useApp((s) => s.set);
  return (
    <nav className="rail glass" aria-label="Tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={drawer === t.id ? 'on' : ''} onClick={() => setDrawer(t.id)} aria-label={t.label}>
          <Icon name={t.icon} />
          <span className="tip">{t.label}</span>
        </button>
      ))}
      <div className="sep" />
      <button onClick={() => set({ videoOpen: true })} aria-label="Video benchmark">
        <Icon name="film" />
        <span className="tip">Video benchmark — analyse an MP4 (camera bypass, PS Benchmark-2) · V</span>
      </button>
      <button className={measure.enabled ? 'on' : ''} onClick={() => set({ measure: { enabled: !measure.enabled, picks: [] } })} aria-label="Measure">
        <Icon name="measure" />
        <span className="tip">3D measurement — click objects or the Earth</span>
      </button>
    </nav>
  );
}

function useCfg() {
  const cfg = useApp((s) => s.config);
  const patch = useApp((s) => s.patchConfig);
  return { cfg, patch };
}

function ScenarioDrawer() {
  const { cfg, patch } = useCfg();
  const replace = useApp((s) => s.replaceConfig);
  const timeScale = useApp((s) => s.timeScale);
  const send = useApp((s) => s.send);
  const sc = cfg.scene;
  return (
    <>
      <Section title="Scenario presets">
        <div className="preset-list">
          {SCENARIO_PRESETS.map((p) => (
            <button key={p.id} className={`preset ${cfg.scenarioId === p.id ? 'on' : ''}`} onClick={() => replace(presetConfig(p.id, cfg.seed))}>
              <b>{p.name}</b>
              <span>{p.summary}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Run">
        <div className="row">
          <span className="muted" style={{ fontSize: 12 }}>
            Seed
          </span>
          <input type="number" value={cfg.seed} style={{ width: 90 }} onChange={(e) => replace({ ...cfg, seed: parseInt(e.target.value || '0', 10) })} />
          <button className="btn sm" onClick={() => replace({ ...cfg, seed: cfg.seed + 1 })}>
            New random start
          </button>
        </div>
        <div className="field">
          <label>Simulation speed</label>
          <span />
          <div style={{ gridColumn: '1 / -1' }}>
            <Seg
              value={String(timeScale)}
              options={['0.25', '0.5', '1', '2'].map((v) => ({ v, label: `${v}×` }))}
              onChange={(v) => send({ type: 'timeScale', value: parseFloat(v) })}
            />
          </div>
        </div>
      </Section>
      <Section title="Geometry" right={<span className="dim">restarts run</span>}>
        <Slider label="Predicted LOS azimuth" value={sc.losAzDeg} min={0} max={359} step={1} digits={0} unit="°" onChange={(v) => patch({ scene: { losAzDeg: v } })} />
        <Slider label="Predicted LOS elevation" value={sc.losElDeg} min={15} max={80} step={1} digits={0} unit="°" onChange={(v) => patch({ scene: { losElDeg: v } })} />
        <Slider label="Satellite altitude" value={sc.altitudeKm} min={300} max={1200} step={10} digits={0} unit=" km" onChange={(v) => patch({ scene: { altitudeKm: v } })} />
        <Slider label="Sun elevation (lighting)" value={sc.sunElDeg} min={-12} max={40} step={1} digits={0} unit="°" onChange={(v) => patch({ scene: { sunElDeg: v } })} />
        <Slider label="Sun azimuth" value={sc.sunAzDeg} min={0} max={359} step={1} digits={0} unit="°" onChange={(v) => patch({ scene: { sunAzDeg: v } })} />
        <p className="note">
          Site: <b>{sc.siteName}</b> ({sc.siteLatDeg.toFixed(2)}° N, {sc.siteLonDeg.toFixed(2)}° E). Coastlines are Natural Earth data; terrain colours and night lights are procedural.
        </p>
      </Section>
    </>
  );
}

const TRAJ: { v: TrajectoryKind; label: string }[] = [
  { v: 'stationary', label: 'Stationary' },
  { v: 'linear', label: 'Linear' },
  { v: 'circular', label: 'Circular' },
  { v: 'sinusoidal', label: 'Sinusoidal' },
  { v: 'figure8', label: 'Figure-8' },
  { v: 'spiral', label: 'Spiral' },
  { v: 'random', label: 'Random' },
  { v: 'custom', label: 'Custom' },
  { v: 'orbital', label: 'LEO pass' },
];

function WaypointEditor({ cfg, onChange }: { cfg: SimConfig; onChange: (w: [number, number][]) => void }) {
  const hu = cfg.logic.searchHalfUDeg;
  const hv = cfg.logic.searchHalfVDeg;
  const W = 290;
  const H = 150;
  const sc = Math.min(W / (2 * hu), H / (2 * hv));
  const X = (u: number) => W / 2 + u * sc;
  const Y = (v: number) => H / 2 - v * sc;
  const wp = cfg.target.waypoints;
  return (
    <div>
      <svg
        width={W}
        height={H}
        style={{ background: 'rgba(var(--panel-rgb),0.6)', borderRadius: 6, cursor: 'crosshair', border: '1px solid var(--line)' }}
        onClick={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const u = (e.clientX - r.left - W / 2) / sc;
          const v = -(e.clientY - r.top - H / 2) / sc;
          onChange([...wp, [Math.round(u * 100) / 100, Math.round(v * 100) / 100]]);
        }}
      >
        <line style={{ stroke: 'rgba(var(--line-rgb),0.12)' }} x1={X(-hu)} y1={Y(0)} x2={X(hu)} y2={Y(0)} />
        <line style={{ stroke: 'rgba(var(--line-rgb),0.12)' }} x1={X(0)} y1={Y(-hv)} x2={X(0)} y2={Y(hv)} />
        <polyline points={[...wp, wp[0] ?? [0, 0]].map(([u, v]) => `${X(u)},${Y(v)}`).join(' ')} fill="none" stroke="var(--ice)" strokeDasharray="3 3" />
        {wp.map(([u, v], i) => (
          <g key={i}>
            <circle cx={X(u)} cy={Y(v)} r="3.5" fill="var(--ice)" />
            <text x={X(u) + 6} y={Y(v) - 5} fontSize="9" fill="var(--text-2)">
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="note" style={{ flex: 1, margin: 0 }}>
          Click inside the search field to add waypoints ({wp.length}).
        </span>
        <button className="btn sm" onClick={() => onChange([])}>
          Clear
        </button>
      </div>
    </div>
  );
}

function TargetDrawer() {
  const { cfg, patch } = useCfg();
  const t = cfg.target;
  const periodic = ['circular', 'sinusoidal', 'figure8', 'spiral'].includes(t.trajectory);
  return (
    <>
      <Section title="Trajectory">
        <Seg value={t.trajectory} options={TRAJ} onChange={(v) => patch({ target: { trajectory: v } })} />
        {(t.trajectory === 'linear' || t.trajectory === 'random' || t.trajectory === 'custom') && (
          <Slider label="Speed" value={t.speedDegS} min={0} max={3} step={0.05} unit=" °/s" onChange={(v) => patch({ target: { speedDegS: v } })} />
        )}
        {periodic && (
          <>
            <Slider label="Amplitude" value={t.amplitudeDeg} min={0.2} max={4} step={0.05} unit="°" onChange={(v) => patch({ target: { amplitudeDeg: v } })} />
            <Slider label="Period" value={t.periodS} min={4} max={60} step={1} digits={0} unit=" s" onChange={(v) => patch({ target: { periodS: v } })} />
          </>
        )}
        {t.trajectory !== 'orbital' && t.trajectory !== 'custom' && t.trajectory !== 'stationary' && t.trajectory !== 'random' && (
          <Slider label="Direction / orientation" value={t.headingDeg} min={0} max={359} step={1} digits={0} unit="°" onChange={(v) => patch({ target: { headingDeg: v } })} />
        )}
        {t.trajectory === 'custom' && <WaypointEditor cfg={cfg} onChange={(w) => patch({ target: { waypoints: w } })} />}
        {t.trajectory === 'orbital' && (
          <>
            <Slider label="Max pass elevation" value={cfg.scene.passMaxElDeg} min={20} max={85} step={1} digits={0} unit="°" onChange={(v) => patch({ scene: { passMaxElDeg: v } })} />
            <Slider label="Ephemeris timing error" value={cfg.scene.ephemerisErrorS} min={0} max={6} step={0.1} digits={1} unit=" s" onChange={(v) => patch({ scene: { ephemerisErrorS: v } })} />
            <p className="note">Circular orbit at {cfg.scene.altitudeKm} km. The camera searches around the predicted pass, which lags the real satellite.</p>
          </>
        )}
      </Section>
      <Section title="Start position" right={<span className="dim">applies on reset</span>}>
        <Seg
          value={t.startMode}
          options={[
            { v: 'random', label: 'Random (PS default)' },
            { v: 'fixed', label: 'Fixed' },
          ]}
          onChange={(v) => patch({ target: { startMode: v } })}
        />
        {t.startMode === 'fixed' && (
          <>
            <Slider label="Start u (right)" value={t.startUDeg} min={-6} max={6} step={0.1} digits={1} unit="°" onChange={(v) => patch({ target: { startUDeg: v } })} />
            <Slider label="Start v (up)" value={t.startVDeg} min={-6} max={6} step={0.1} digits={1} unit="°" onChange={(v) => patch({ target: { startVDeg: v } })} />
          </>
        )}
      </Section>
      <Section title="Beacon spot">
        <Seg
          value={t.spotShape}
          options={[
            { v: 'square', label: 'Square' },
            { v: 'disk', label: 'Disk' },
            { v: 'gaussian', label: 'Gaussian' },
          ]}
          onChange={(v) => patch({ target: { spotShape: v } })}
        />
        <Slider label="Spot size (at 4° FOV)" value={t.spotSizePx} min={5} max={20} step={1} digits={0} unit=" px" onChange={(v) => patch({ target: { spotSizePx: v } })} />
        <Slider label="Beacon intensity" value={t.beaconIntensity} min={40} max={255} step={1} digits={0} unit=" DN" onChange={(v) => patch({ target: { beaconIntensity: v } })} />
      </Section>
    </>
  );
}

function DisturbanceDrawer() {
  const { cfg, patch } = useCfg();
  const d = cfg.disturbance;
  return (
    <>
      <Section title="Atmosphere">
        <Seg
          value={d.atmosphere}
          options={[
            { v: 'clear', label: 'Clear' },
            { v: 'haze', label: 'Haze' },
            { v: 'fog', label: 'Fog' },
            { v: 'rain', label: 'Rain' },
            { v: 'low_light', label: 'Low light' },
          ]}
          onChange={(v) => patch({ disturbance: { atmosphere: v } })}
        />
        <Slider label="Strength (contrast / brightness loss)" value={d.atmosphereStrength} min={0} max={1} step={0.05} onChange={(v) => patch({ disturbance: { atmosphereStrength: v } })} />
        <Slider label="Turbulence (scintillation + wander)" value={d.turbulence} min={0} max={1} step={0.05} onChange={(v) => patch({ disturbance: { turbulence: v } })} />
      </Section>
      <Section title="Sensor noise">
        <Slider label="Gaussian σ" value={d.gaussianNoise} min={0} max={20} step={0.5} digits={1} unit=" DN" onChange={(v) => patch({ disturbance: { gaussianNoise: v } })} />
        <Slider label="Salt & pepper" value={d.saltPepper * 100} min={0} max={10} step={0.1} digits={1} unit=" %" onChange={(v) => patch({ disturbance: { saltPepper: v / 100 } })} />
        <Toggle label="Poisson (shot) noise" on={d.poisson} onChange={(v) => patch({ disturbance: { poisson: v } })} />
      </Section>
      <Section title="Platform & gimbal">
        <Slider label="Camera jitter (±/frame)" value={d.jitterPx} min={0} max={20} step={0.5} digits={1} unit=" px" onChange={(v) => patch({ disturbance: { jitterPx: v } })} />
        <Slider label="Platform vibration" value={d.vibrationPx} min={0} max={20} step={0.5} digits={1} unit=" px" onChange={(v) => patch({ disturbance: { vibrationPx: v } })} />
        <Slider label="Vibration frequency" value={d.vibrationHz} min={0.5} max={20} step={0.5} digits={1} unit=" Hz" onChange={(v) => patch({ disturbance: { vibrationHz: v } })} />
        <div className="field">
          <label>Platform motion</label>
          <span />
          <div style={{ gridColumn: '1 / -1' }}>
            <Seg
              value={d.platformMotion}
              options={[
                { v: 'none', label: 'None' },
                { v: 'linear', label: 'Linear' },
                { v: 'circular', label: 'Circular' },
                { v: 'random', label: 'Random' },
              ]}
              onChange={(v) => patch({ disturbance: { platformMotion: v } })}
            />
          </div>
        </div>
        {d.platformMotion !== 'none' && (
          <Slider label="Platform motion amplitude" value={d.platformMotionPx} min={0} max={40} step={1} digits={0} unit=" px" onChange={(v) => patch({ disturbance: { platformMotionPx: v } })} />
        )}
        <Slider label="Wind torque (rate σ)" value={d.windDegS} min={0} max={1} step={0.01} unit=" °/s" onChange={(v) => patch({ disturbance: { windDegS: v } })} />
      </Section>
      <Section title="Target & detection">
        <Slider label="Target motion noise" value={d.targetNoiseDeg} min={0} max={0.2} step={0.005} digits={3} unit="°" onChange={(v) => patch({ disturbance: { targetNoiseDeg: v } })} />
        <Slider label="Beacon dropouts" value={d.dropoutProb * 100} min={0} max={90} step={1} digits={0} unit=" %" onChange={(v) => patch({ disturbance: { dropoutProb: v / 100 } })} />
        <Slider label="Cloud outage every (0 = off)" value={d.occlusionPeriodS} min={0} max={30} step={1} digits={0} unit=" s" onChange={(v) => patch({ disturbance: { occlusionPeriodS: v } })} />
        {d.occlusionPeriodS > 0 && (
          <Slider label="Outage length" value={d.occlusionDurS} min={0.2} max={5} step={0.1} digits={1} unit=" s" onChange={(v) => patch({ disturbance: { occlusionDurS: v } })} />
        )}
        <Toggle label="Decoy glint in the field" on={d.decoy} onChange={(v) => patch({ disturbance: { decoy: v } })} />
        <p className="note">Every disturbance acts on the simulation itself: attitude (jitter, vibration, platform), gimbal rates (wind), the rendered image (noise, atmosphere, turbulence) or the target path.</p>
      </Section>
    </>
  );
}

function TrackingDrawer() {
  const { cfg, patch } = useCfg();
  const hud = useApp((s) => s.hud);
  const send = useApp((s) => s.send);
  const [manual, setManual] = useState<[number, number]>([0, 0]);
  const mode = hud?.mode ?? 'auto';
  const k = cfg.kalman;
  const c = cfg.control;
  const g = cfg.gimbal;
  const det = cfg.detection;
  const l = cfg.logic;
  useEffect(() => {
    if (mode === 'manual' && hud) setManual([hud.gimbal.pan, hud.gimbal.tilt]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  return (
    <>
      <Section title="Pointing mode">
        <Seg
          value={mode}
          options={[
            { v: 'auto', label: 'Automatic tracking' },
            { v: 'manual', label: 'Manual pan / tilt' },
          ]}
          onChange={(v) => send({ type: 'mode', mode: v })}
        />
        {mode === 'manual' && (
          <>
            <Slider label="Pan (azimuth)" value={manual[0]} min={-180} max={180} step={0.05} unit="°" onChange={(v) => { setManual([v, manual[1]]); send({ type: 'manual', pan: v, tilt: manual[1] }); }} />
            <Slider label="Tilt (elevation)" value={manual[1]} min={g.tiltMinDeg} max={g.tiltMaxDeg} step={0.05} unit="°" onChange={(v) => { setManual([manual[0], v]); send({ type: 'manual', pan: manual[0], tilt: v }); }} />
            <p className="note">Arrow keys jog 0.1° (Shift: 1°). Detection keeps running; the loop is open.</p>
          </>
        )}
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn sm" onClick={() => send({ type: 'reacquire' })}>
            Force reacquisition
          </button>
        </div>
      </Section>
      <Section title="Detection provider">
        <div className="preset-list">
          {DETECTION_PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`preset ${det.provider === p.id ? 'on' : ''}`}
              disabled={p.status === 'planned'}
              style={p.status === 'planned' ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
              onClick={() => p.status === 'available' && patch({ detection: { provider: p.id as 'centroid' | 'synthetic' } })}
            >
              <b>
                {p.label} {p.status === 'planned' ? <span className="tag planned">planned</span> : p.id === 'synthetic' ? <span className="tag sim">model</span> : <span className="tag">CV</span>}
              </b>
              <span>{p.note}</span>
            </button>
          ))}
        </div>
        {det.provider === 'centroid' && (
          <div className="ai-box">
            <Toggle
              label={
                <>
                  <b style={{ color: 'var(--text)' }}>Learned beacon verifier</b> <span className="tag ai">AI</span>
                </>
              }
              on={det.verifier}
              onChange={(v) => patch({ detection: { verifier: v } })}
              hint="A small neural network scores every blob the detector finds"
            />
            <p className="note">
              A neural network (MLP 11→16→8→1) scores every candidate blob: beacon, or star / noise / rain / decoy. Trained on {Number(VERIFIER.metrics?.trainCandidates ?? 0).toLocaleString()} labelled blobs. Held-out test: beacon found in{' '}
              <b>{(100 * Number(VERIFIER.metrics?.pdMlp ?? 0)).toFixed(1)} %</b> of frames vs {(100 * Number(VERIFIER.metrics?.pdHand ?? 0)).toFixed(1)} % hand-tuned; false detections{' '}
              <b>{(100 * Number(VERIFIER.metrics?.faMlp ?? 0)).toFixed(2)} %</b> vs {(100 * Number(VERIFIER.metrics?.faHand ?? 0)).toFixed(2)} %.
            </p>
          </div>
        )}
        {det.provider === 'centroid' ? (
          <>
            <Slider label="Threshold (k·σ)" value={det.thresholdSigma} min={3} max={10} step={0.5} digits={1} onChange={(v) => patch({ detection: { thresholdSigma: v } })} />
            <Slider label="Minimum confidence" value={det.minConfidence} min={0.1} max={0.9} step={0.05} onChange={(v) => patch({ detection: { minConfidence: v } })} />
          </>
        ) : (
          <>
            <Slider label="Centroid noise σ" value={det.syntheticNoisePx} min={0} max={5} step={0.1} digits={1} unit=" px" onChange={(v) => patch({ detection: { syntheticNoisePx: v } })} />
            <Slider label="Miss probability" value={det.syntheticMissProb * 100} min={0} max={80} step={1} digits={0} unit=" %" onChange={(v) => patch({ detection: { syntheticMissProb: v / 100 } })} />
          </>
        )}
        <Slider label="Association gate" value={det.gateRadiusPx} min={10} max={200} step={5} digits={0} unit=" px" onChange={(v) => patch({ detection: { gateRadiusPx: v } })} />
        <Slider label="Detection latency" value={det.latencyFrames} min={0} max={6} step={1} digits={0} unit=" frames" onChange={(v) => patch({ detection: { latencyFrames: v } })} />
      </Section>
      <Section title="Kalman filter" right={<span className="dim">az/el, constant velocity</span>}>
        <Toggle label="Enable Kalman filter" on={k.enabled} onChange={(v) => patch({ kalman: { enabled: v } })} />
        <Slider label="Process noise q" value={k.processNoise} min={0.05} max={10} step={0.05} unit=" (°/s²)²/Hz" onChange={(v) => patch({ kalman: { processNoise: v } })} />
        <Slider label="Measurement noise r" value={k.measurementNoisePx} min={0.2} max={10} step={0.1} digits={1} unit=" px" onChange={(v) => patch({ kalman: { measurementNoisePx: v } })} />
        <Slider label="Innovation gate (χ²)" value={k.gate} min={4} max={100} step={1} digits={0} onChange={(v) => patch({ kalman: { gate: v } })} />
      </Section>
      <Section title="PID alignment controller">
        <Slider label="Kp" value={c.kp} min={0} max={20} step={0.1} digits={1} onChange={(v) => patch({ control: { kp: v } })} />
        <Slider label="Ki" value={c.ki} min={0} max={5} step={0.05} onChange={(v) => patch({ control: { ki: v } })} />
        <Slider label="Kd" value={c.kd} min={0} max={1} step={0.01} onChange={(v) => patch({ control: { kd: v } })} />
        <Slider label="Integral limit" value={c.integralLimit} min={0} max={0.5} step={0.01} unit=" °·s" onChange={(v) => patch({ control: { integralLimit: v } })} />
        <Toggle label="Rate feed-forward (Kalman velocity)" on={c.feedForward} onChange={(v) => patch({ control: { feedForward: v } })} />
        <Slider label="Control rate" value={c.controlRateHz} min={20} max={120} step={10} digits={0} unit=" Hz" onChange={(v) => patch({ control: { controlRateHz: v } })} />
      </Section>
      <Section title="Gimbal limits">
        <Slider label="Max rate (PS 5–10)" value={g.maxRateDegS} min={1} max={15} step={0.5} digits={1} unit=" °/s" onChange={(v) => patch({ gimbal: { maxRateDegS: v } })} />
        <Slider label="Max acceleration" value={g.maxAccelDegS2} min={5} max={120} step={5} digits={0} unit=" °/s²" onChange={(v) => patch({ gimbal: { maxAccelDegS2: v } })} />
        <Slider label="Tilt max" value={g.tiltMaxDeg} min={45} max={89} step={1} digits={0} unit="°" onChange={(v) => patch({ gimbal: { tiltMaxDeg: v } })} />
      </Section>
      <Section title="State machine thresholds">
        <Slider label="Lock threshold" value={l.lockPx} min={2} max={30} step={1} digits={0} unit=" px" onChange={(v) => patch({ logic: { lockPx: v, unlockPx: Math.max(v + 2, l.unlockPx) } })} />
        <Slider label="Frames to lock" value={l.lockFrames} min={1} max={30} step={1} digits={0} onChange={(v) => patch({ logic: { lockFrames: v } })} />
        <Slider label="Coast frames before LOST" value={l.coastFrames} min={1} max={30} step={1} digits={0} onChange={(v) => patch({ logic: { coastFrames: v } })} />
        <Slider label="Reacquisition timeout" value={l.reacquireTimeoutS} min={1} max={10} step={0.5} digits={1} unit=" s" onChange={(v) => patch({ logic: { reacquireTimeoutS: v } })} />
      </Section>
    </>
  );
}

function PinholeDiagram({ cfg }: { cfg: SimConfig }) {
  const k = intrinsics(cfg.camera);
  return (
    <svg width="290" height="120" viewBox="0 0 290 120" style={{ display: 'block', margin: '4px 0 8px' }}>
      <line x1="30" y1="20" x2="30" y2="100" stroke="var(--ice)" strokeWidth="2" />
      <text x="16" y="114" fontSize="9" fill="var(--text-3)">
        sensor
      </text>
      <circle cx="120" cy="60" r="3" fill="var(--amber)" />
      <text x="104" y="114" fontSize="9" fill="var(--text-3)">
        pinhole
      </text>
      <line style={{ stroke: 'rgba(var(--accent-rgb),0.45)' }} x1="30" y1="20" x2="280" y2="98" />
      <line style={{ stroke: 'rgba(var(--accent-rgb),0.45)' }} x1="30" y1="100" x2="280" y2="22" />
      <line style={{ stroke: 'rgba(var(--line-rgb),0.3)' }} x1="30" y1="60" x2="280" y2="60" strokeDasharray="3 3" />
      <line x1="30" y1="75" x2="120" y2="75" stroke="var(--amber)" />
      <text x="62" y="86" fontSize="9" fill="var(--amber)">
        f = {k.focalMm.toFixed(1)} mm
      </text>
      <path d="M160 48 A 42 42 0 0 1 160 72" fill="none" stroke="var(--ice)" />
      <text x="168" y="64" fontSize="9" fill="var(--ice)">
        HFOV {k.hfovDeg.toFixed(2)}°
      </text>
      <text x="36" y="16" fontSize="9" fill="var(--text-2)">
        {cfg.camera.width} px × {cfg.camera.pixelPitchUm} µm
      </text>
    </svg>
  );
}

function OpticsDrawer() {
  const { cfg, patch } = useCfg();
  const link = useApp((s) => s.hud?.link);
  const cam = cfg.camera;
  const k = intrinsics(cam);
  const acq = acquisitionProbability(cfg);
  const L = cfg.link;
  return (
    <>
      <Section title="Camera calibration">
        <PinholeDiagram cfg={cfg} />
        <dl className="kv">
          <dt>Resolution</dt>
          <dd>
            {cam.width} × {cam.height} px
          </dd>
          <dt>Principal point (cx, cy)</dt>
          <dd>
            ({k.cx}, {k.cy}) px
          </dd>
          <dt>Focal length fx = fy</dt>
          <dd>{k.fx.toFixed(1)} px</dd>
          <dt>Focal length (pitch {cam.pixelPitchUm} µm)</dt>
          <dd>{k.focalMm.toFixed(2)} mm</dd>
          <dt>FOV (tracking)</dt>
          <dd>
            {k.hfovDeg.toFixed(2)}° × {k.vfovDeg.toFixed(2)}°
          </dd>
          <dt>IFOV at centre</dt>
          <dd>
            {k.ifovDeg.toFixed(5)}° · {((k.ifovDeg * Math.PI) / 180 * 1e6).toFixed(1)} µrad
          </dd>
          <dt>Projection</dt>
          <dd>u = cx + fx·x/z, v = cy − fy·y/z</dd>
        </dl>
      </Section>
      <Section title="Camera" right={<span className="dim">size change restarts</span>}>
        <Slider label="Horizontal FOV (tracking)" value={cam.hfovDeg} min={1} max={12} step={0.1} digits={1} unit="°" onChange={(v) => patch({ camera: { hfovDeg: v } })} />
        <Toggle label="Wide-field acquisition (zoom in after detection)" on={cam.wideAcquisition} onChange={(v) => patch({ camera: { wideAcquisition: v } })} />
        {cam.wideAcquisition && (
          <>
            <Slider label="Acquisition FOV" value={cam.wideHfovDeg} min={cam.hfovDeg} max={20} step={0.5} digits={1} unit="°" onChange={(v) => patch({ camera: { wideHfovDeg: v } })} />
            <Slider label="Zoom rate" value={cam.zoomRateDegS} min={2} max={30} step={1} digits={0} unit=" °/s" onChange={(v) => patch({ camera: { zoomRateDegS: v } })} />
          </>
        )}
        <Seg
          value={`${cam.width}x${cam.height}`}
          options={[
            { v: '640x480', label: '640×480 (PS)' },
            { v: '800x600', label: '800×600' },
            { v: '1024x768', label: '1024×768' },
          ]}
          onChange={(v) => {
            const [w, h] = v.split('x').map(Number);
            patch({ camera: { width: w, height: h } });
          }}
        />
        <Slider label="Frame rate (PS ≥ 30)" value={cam.frameRateHz} min={15} max={60} step={5} digits={0} unit=" Hz" onChange={(v) => patch({ camera: { frameRateHz: v } })} />
      </Section>
      <Section title="Acquisition probability" right={<span className="tag sim">estimate</span>}>
        <dl className="kv">
          <dt>Beacon in view at start</dt>
          <dd>{(acq.pView0 * 100).toFixed(1)} %</dd>
          <dt>Per-frame detection</dt>
          <dd>{(acq.pDet * 100).toFixed(1)} %</dd>
          <dt>Estimated SNR (box-filtered)</dt>
          <dd>{acq.snr.toFixed(1)}</dd>
          <dt>P(acquire ≤ 2 s)</dt>
          <dd style={{ color: 'var(--ice)' }}>{(acq.pAcq * 100).toFixed(1)} %</dd>
        </dl>
        <p className="note">P = min(1, A_cov(2 s)/A_field) · (1 − (1 − P_det)^n). A_cov = FOV area + scan rate × VFOV × T. Coverage model, not a Monte-Carlo result — use Experiment ▸ Batch for measured rates.</p>
      </Section>
      <Section title="Link budget" right={<span className="tag sim">simplified</span>}>
        <Slider label="Transmit power" value={L.txPowerMw} min={10} max={5000} step={10} digits={0} unit=" mW" onChange={(v) => patch({ link: { txPowerMw: v } })} />
        <Slider label="Beam divergence (full)" value={L.divergenceUrad} min={20} max={1000} step={5} digits={0} unit=" µrad" onChange={(v) => patch({ link: { divergenceUrad: v } })} />
        <Slider label="Receiver aperture" value={L.rxApertureCm} min={2} max={60} step={1} digits={0} unit=" cm" onChange={(v) => patch({ link: { rxApertureCm: v } })} />
        <Slider label="Receiver sensitivity" value={L.rxSensitivityDbm} min={-70} max={-20} step={1} digits={0} unit=" dBm" onChange={(v) => patch({ link: { rxSensitivityDbm: v } })} />
        <Slider label="Fine-stage capture (half)" value={L.fineCaptureMrad} min={0.1} max={5} step={0.1} digits={1} unit=" mrad" onChange={(v) => patch({ link: { fineCaptureMrad: v } })} />
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Range (live)</dt>
          <dd>{fmt(link?.rangeKm, 1, ' km')}</dd>
          <dt>Geometric loss</dt>
          <dd>{fmt(link?.geomLossDb, 1, ' dB')}</dd>
          <dt>Atmospheric loss (× airmass)</dt>
          <dd>{fmt(link?.atmLossDb, 2, ' dB')}</dd>
          <dt>Receive pointing loss</dt>
          <dd>{fmt(link?.pointingLossDb, 2, ' dB')}</dd>
          <dt>System loss</dt>
          <dd>{L.systemLossDb.toFixed(1)} dB</dd>
          <dt>Received power</dt>
          <dd>{fmt(link?.prDbm, 1, ' dBm')}</dd>
          <dt>Margin</dt>
          <dd style={{ color: (link?.marginDb ?? 0) < 0 ? 'var(--lost)' : 'var(--lock)' }}>{fmt(link?.marginDb, 1, ' dB')}</dd>
        </dl>
        <p className="note">Assumes a Gaussian far-field beam at {L.wavelengthNm} nm, η = 1 − exp(−2a²/w²), pointing loss exp(−2(θ/θ_fine)²). Ignores scintillation fades, background light and detector noise.</p>
      </Section>
    </>
  );
}

function BatchPanel() {
  const cfg = useApp((s) => s.config);
  const [runs, setRuns] = useState(10);
  const [dur, setDur] = useState(15);
  const [results, setResults] = useState<BatchRunResult[]>([]);
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const start = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../engine/batch.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setResults([]);
    setBusy(true);
    w.onmessage = (e: MessageEvent<BatchMessage>) => {
      if (e.data.type === 'progress') setResults((r) => [...r, e.data.type === 'progress' ? e.data.result : r[0]]);
      else setBusy(false);
    };
    w.postMessage({ config: cfg, runs, durationS: dur, seed0: cfg.seed * 1000 });
  };
  const summary = useMemo(() => {
    if (!results.length) return null;
    const acq = results.map((r) => r.metrics.acquisitionS).filter((x): x is number => x !== null);
    const rms = results.map((r) => r.metrics.errRmsPx).filter((x): x is number => x !== null);
    const pass = results.filter((r) => r.metrics.acceptance.acquisition && r.metrics.acceptance.error && r.metrics.acceptance.loss !== false).length;
    return {
      acqMean: acq.length ? acq.reduce((a, b) => a + b, 0) / acq.length : null,
      acqMax: acq.length ? Math.max(...acq) : null,
      rmsMean: rms.length ? rms.reduce((a, b) => a + b, 0) / rms.length : null,
      locked: acq.length,
      pass,
    };
  }, [results]);
  const exportCsv = () => {
    const head = 'seed,final_state,acquisition_s,err_rms_px,err_max_px,loss_pct,reacq_max_s,centroid_rms_px,fps_capacity';
    const rows = results.map((r) =>
      [r.seed, r.finalState, r.metrics.acquisitionS ?? '', r.metrics.errRmsPx ?? '', r.metrics.errMaxPx ?? '', r.metrics.lossPct ?? '', r.metrics.reacqMaxS ?? '', r.metrics.centroidRmsPx ?? '', r.metrics.fps.toFixed(0)].join(','),
    );
    const blob = new Blob([[head, ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `astraq-batch-${cfg.scenarioId}.csv`;
    a.click();
  };
  return (
    <Section title="Batch (Monte-Carlo over seeds)" right={<span className="dim">headless worker</span>}>
      <Slider label="Runs" value={runs} min={2} max={50} step={1} digits={0} onChange={setRuns} />
      <Slider label="Duration per run" value={dur} min={5} max={60} step={1} digits={0} unit=" s" onChange={setDur} />
      <div className="row">
        <button className="btn sm primary" onClick={start} disabled={busy}>
          {busy ? `Running ${results.length}/${runs}…` : 'Run batch'}
        </button>
        <button className="btn sm" onClick={exportCsv} disabled={!results.length}>
          <Icon name="download" size={14} /> CSV
        </button>
        <button
          className="btn sm"
          disabled={!results.length || busy}
          onClick={() => saveReport(buildReport({ kind: 'batch', source: 'Browser engine (batch worker)', config: cfg, batch: results }), 'html', `astraq-batch-report-${cfg.scenarioId}`)}
        >
          <Icon name="report" size={14} /> Report
        </button>
      </div>
      {summary && (
        <p className="note">
          Locked <b>{summary.locked}/{results.length}</b> · passing acquisition+error+loss <b>{summary.pass}/{results.length}</b> · acquisition mean <b>{fmt(summary.acqMean, 2, ' s')}</b> (max {fmt(summary.acqMax, 2, ' s')}) · RMS error mean <b>{fmt(summary.rmsMean, 2, ' px')}</b>
        </p>
      )}
      {results.length > 0 && (
        <table className="batch-table">
          <thead>
            <tr>
              <th>seed</th>
              <th>acq s</th>
              <th>rms px</th>
              <th>loss %</th>
              <th>re-acq</th>
              <th>end</th>
            </tr>
          </thead>
          <tbody>
            {results.slice(-12).map((r) => (
              <tr key={r.seed}>
                <td>{r.seed}</td>
                <td>{fmt(r.metrics.acquisitionS, 2)}</td>
                <td>{fmt(r.metrics.errRmsPx, 2)}</td>
                <td>{fmt(r.metrics.lossPct, 1)}</td>
                <td>{fmt(r.metrics.reacqMaxS, 2)}</td>
                <td>{r.finalState.slice(0, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ReportPanel() {
  const autoReport = useApp((s) => s.autoReport);
  const { downloadReport, set } = useApp.getState();
  const rec = useApp((s) => s.recording);
  return (
    <Section title="Performance report" right={<span className="tag ai">auto</span>}>
      <p className="note" style={{ marginTop: 0 }}>
        Duration, FPS, acquisition time, average / max tracking error, lock retention, loss, re-acquisition, processing time, PS169 pass/fail, configuration and the state log.
      </p>
      <div className="row">
        <button className="btn sm primary" onClick={() => downloadReport('live', 'html')}>
          <Icon name="report" size={14} /> Report (live run)
        </button>
        <button className="btn sm" onClick={() => downloadReport('live', 'md')}>
          Markdown
        </button>
        <button className="btn sm" onClick={() => downloadReport('live', 'json')}>
          JSON
        </button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm" onClick={() => downloadReport('recording', 'html')} disabled={!rec.frames}>
          <Icon name="report" size={14} /> Report (recording)
        </button>
      </div>
      <Toggle
        label="Save a report automatically when a recording stops"
        on={autoReport}
        onChange={(v) => {
          try {
            localStorage.setItem('astraq.autoReport', v ? '1' : '0');
          } catch {
            /* storage unavailable */
          }
          set({ autoReport: v });
        }}
      />
    </Section>
  );
}

function ExperimentDrawer() {
  const kind = useApp((s) => s.providerKind);
  const status = useApp((s) => s.providerStatus);
  const err = useApp((s) => s.providerError);
  const serverUrl = useApp((s) => s.serverUrl);
  const rec = useApp((s) => s.recording);
  const events = useApp((s) => s.events);
  const { connect, startRecording, stopRecording, exportCsv, exportJson, notify, send } = useApp.getState();
  const running = useApp((s) => s.running);
  const [url, setUrl] = useState(serverUrl);
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <Section title="Engine">
        <Seg
          value={kind === 'replay' ? 'local' : kind}
          options={[
            { v: 'local', label: 'Local (browser)' },
            { v: 'remote', label: 'FastAPI server' },
          ]}
          onChange={(v) => connect(v, v === 'remote' ? { url } : undefined)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => connect('remote', { url })}>
            Connect
          </button>
        </div>
        <p className="note">
          Status: <b>{status}</b> · source <b>{kind}</b>
          {err && (
            <>
              <br />
              <span style={{ color: 'var(--lost)' }}>{err}</span>
            </>
          )}
        </p>
      </Section>
      <Section title="Experiment control">
        <div className="row">
          <button className="btn sm" onClick={() => send({ type: running ? 'pause' : 'start' })}>
            {running ? 'Stop' : 'Start'}
          </button>
          <button className="btn sm" onClick={() => send({ type: 'reset' })} disabled={kind === 'replay'}>
            Reset
          </button>
          <button className={`btn sm rec ${rec.active ? 'on' : ''}`} onClick={() => (rec.active ? stopRecording() : startRecording())}>
            <span className="led" />
            {rec.active ? 'Stop recording' : 'Record'}
          </button>
        </div>
        <p className="note">
          Recorded: <b>{rec.frames}</b> frames ({(rec.frames / 30).toFixed(1)} s). Every snapshot is kept (no images) for CSV / JSON export and replay.
        </p>
        <div className="row">
          <button className="btn sm" onClick={exportCsv}>
            <Icon name="download" size={14} /> CSV
          </button>
          <button className="btn sm" onClick={exportJson}>
            <Icon name="download" size={14} /> JSON
          </button>
          <button
            className="btn sm"
            onClick={() => {
              if (!recorder.frames.length) return notify('Nothing recorded yet');
              connect('replay', { recording: recorder.toRecording('In-memory recording', useApp.getState().config, kind) });
            }}
          >
            <Icon name="play" size={14} /> Replay
          </button>
          <button className="btn sm" onClick={() => file.current?.click()}>
            <Icon name="upload" size={14} /> Load JSON
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                if (!isRecording(data)) throw new Error('Not an ASTRAQ recording');
                connect('replay', { recording: data });
              } catch (x) {
                notify(`Could not load recording: ${(x as Error).message}`);
              }
              e.target.value = '';
            }}
          />
        </div>
      </Section>
      <ReportPanel />
      <BatchPanel />
      <Section title="State transition log" right={<span className="dim">{events.length}</span>}>
        <div style={{ maxHeight: 220, overflowY: 'auto', fontSize: 11.5 }}>
          {[...events].reverse().slice(0, 80).map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--hair)' }}>
              <span className="mono dim" style={{ flex: 'none', width: 48 }}>
                {e.t.toFixed(2)}
              </span>
              <span className="muted">
                {e.to && <b style={{ color: 'var(--text)' }}>{e.to} </b>}
                {e.message}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function ViewDrawer() {
  const quality = useApp((s) => s.quality);
  const overlays = useApp((s) => s.overlays);
  const view = useApp((s) => s.view);
  const followKey = useApp((s) => s.followKey);
  const { setQuality, toggleOverlay } = useApp.getState();
  return (
    <>
      <Section title="Theme">
        <ThemeList />
      </Section>
      <Section title="Render quality">
        <Seg
          value={quality}
          options={[
            { v: 'low', label: 'Low' },
            { v: 'medium', label: 'Medium' },
            { v: 'high', label: 'High' },
          ]}
          onChange={setQuality}
        />
        <p className="note">Low: no post-processing, no clouds, 2k land mask. Medium: bloom, clouds. High: SMAA anti-aliasing, shadows, up to 2× pixel ratio (capped to what the screen size allows), 30 Hz sensor feed. If a graphics card cannot draw a level, ASTRAQ drops one level automatically and tells you.</p>
      </Section>
      <Section title="3D overlays">
        <Toggle label="Labels" on={overlays.labels} onChange={() => toggleOverlay('labels')} />
        <Toggle label="Camera FOV frustum & optical axis" on={overlays.fov} onChange={() => toggleOverlay('fov')} />
        <Toggle label="Trajectories, search field, scan path" on={overlays.trails} onChange={() => toggleOverlay('trails')} />
        <Toggle label="Latitude / longitude grid" on={overlays.grid} onChange={() => toggleOverlay('grid')} />
      </Section>
      <Section title="Space environment" right={<span className="dim">visual only</span>}>
        <Toggle label="Other satellites, ISS, meteors, aurora, galaxies" on={overlays.space} onChange={() => toggleOverlay('space')} />
        <div className="eyebrow" style={{ margin: '10px 0 6px' }}>
          <span>Fly to (key F)</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {(
            [
              ['iss', 'ISS'],
              ['sat2', 'SAT-2'],
              ['sat3', 'SAT-3'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={`btn sm ${view === 'follow' && followKey === k ? 'primary' : ''}`} onClick={() => useApp.getState().flyTo(k)}>
              {label}
            </button>
          ))}
          <button className="btn sm ghost" onClick={() => useApp.getState().setView('overview')}>
            Back
          </button>
        </div>
        <p className="note">
          SAT-2 (Earth observation, 700 km), SAT-3 (data relay, 1,100 km) and the ISS (420 km) fly at real orbital speed on repeating passes over the link. In a Fly-to view, drag to look around the spacecraft and scroll to zoom; the camera travels with it. None of this is in the simulated camera image, so it does not affect tracking or any result. The Andromeda galaxy and Magellanic Clouds are at approximate positions.
        </p>
      </Section>
      <Section title="Sensor overlays">
        <Toggle label="Region of interest" on={overlays.roi} onChange={() => toggleOverlay('roi')} />
        <Toggle label="Calibration grid (degrees)" on={overlays.calibration} onChange={() => toggleOverlay('calibration')} />
        <Toggle label="Ground truth marker (simulation only)" on={overlays.truth} onChange={() => toggleOverlay('truth')} />
      </Section>
      <Section title="Scale">
        <p className="note">
          Scene units are kilometres; directions, ranges and the Earth are true. The terminal and spacecraft are drawn with <b>iconic scaling</b> (enlarged when far away) and the Moon ×3. The beacon cone divergence is exaggerated ×80.
        </p>
      </Section>
    </>
  );
}

const TITLES: Record<Exclude<DrawerId, null>, string> = {
  scenario: 'Scenario',
  target: 'Target',
  disturbance: 'Disturbances',
  tracking: 'Tracking',
  optics: 'Optics & link',
  experiment: 'Experiment',
  view: 'View',
};

export function Drawer() {
  const drawer = useApp((s) => s.drawer);
  const setDrawer = useApp((s) => s.setDrawer);
  if (!drawer) return null;
  return (
    <aside className="drawer glass">
      <div className="drawer-head">
        <h3>{TITLES[drawer]}</h3>
        <button className="btn icon sm ghost" onClick={() => setDrawer(drawer)} aria-label="Close">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="drawer-body">
        {drawer === 'scenario' && <ScenarioDrawer />}
        {drawer === 'target' && <TargetDrawer />}
        {drawer === 'disturbance' && <DisturbanceDrawer />}
        {drawer === 'tracking' && <TrackingDrawer />}
        {drawer === 'optics' && <OpticsDrawer />}
        {drawer === 'experiment' && <ExperimentDrawer />}
        {drawer === 'view' && <ViewDrawer />}
      </div>
    </aside>
  );
}

