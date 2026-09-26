/**
 * Application state (zustand).
 *
 * High-rate data (snapshots at 30 Hz, sensor images, time series) lives in plain
 * module-level buffers read by the 3D scene every animation frame; React state only
 * receives a throttled "tick" so the HUD re-renders ~12 times per second.
 */
import { create } from 'zustand';
import { DEFAULT_CONFIG, DeepPartial, SimConfig, mergeConfig } from '../core/config';
import type { Snapshot, TransitionEvent, TrackState } from '../core/telemetry/types';
import { TRACK_STATES } from '../core/telemetry/types';
import { Recorder, Recording } from '../core/telemetry/recorder';
import { PerformanceReport, buildReport, reportHtml, reportMarkdown } from '../core/analysis/report';
import type { EngineCommand, EngineMessage } from '../engine/protocol';
import { DEFAULT_SERVER_URL, LocalEngineProvider, ProviderKind, RemoteEngineProvider, ReplayProvider, TelemetryProvider } from '../services/providers';

// ───────────────────────── high-rate buffers ─────────────────────────
export const live = {
  snap: null as Snapshot | null,
  image: null as { width: number; height: number; frame: number; data: Uint8ClampedArray } | null,
  imageVersion: 0,
  plan: null as Snapshot['plan'] | null,
  /** Last ~1 s of snapshots, so the sensor overlay can use the snapshot matching the displayed image. */
  recent: [] as Snapshot[],
  /** Error at the moment of the latest first detection (coarse-alignment "initial error"). */
  initialErrPx: null as number | null,
};

const N = 30 * 90;
export const SERIES = ['t', 'errPx', 'estErrPx', 'angErr', 'pan', 'tilt', 'panRate', 'tiltRate', 'panCmd', 'tiltCmd', 'conf', 'tgtRate', 'state', 'aqs'] as const;
export type SeriesKey = (typeof SERIES)[number];
export const history = {
  n: 0,
  head: 0,
  data: Object.fromEntries(SERIES.map((k) => [k, new Float32Array(N)])) as Record<SeriesKey, Float32Array>,
  cap: N,
};
/** Recent 3D trail data. */
export const trails = {
  target: [] as [number, number, number][],
  axis: [] as { az: number; el: number; r: number }[],
};

function pushHistory(s: Snapshot) {
  const h = history;
  const i = h.head;
  const d = h.data;
  d.t[i] = s.t;
  d.errPx[i] = s.error.magPx ?? NaN;
  d.estErrPx[i] = s.error.estMagPx ?? NaN;
  d.angErr[i] = s.error.angDeg;
  d.pan[i] = s.gimbal.pan;
  d.tilt[i] = s.gimbal.tilt;
  d.panRate[i] = s.gimbal.panRate;
  d.tiltRate[i] = s.gimbal.tiltRate;
  d.panCmd[i] = s.gimbal.panCmd;
  d.tiltCmd[i] = s.gimbal.tiltCmd;
  d.conf[i] = s.detection?.confidence ?? 0;
  d.tgtRate[i] = s.target.angRateDegS;
  d.state[i] = TRACK_STATES.indexOf(s.state);
  d.aqs[i] = s.metrics.aqs;
  h.head = (i + 1) % h.cap;
  h.n = Math.min(h.cap, h.n + 1);
  trails.target.push(s.target.posKm);
  if (trails.target.length > 30 * 25) trails.target.shift();
  trails.axis.push({ az: s.gimbal.axisAz, el: s.gimbal.axisEl, r: s.target.rangeKm });
  if (trails.axis.length > 30 * 8) trails.axis.shift();
}

export function clearHistory() {
  history.n = 0;
  history.head = 0;
  trails.target.length = 0;
  trails.axis.length = 0;
}

/** Iterate history in time order. */
export function historySlice(key: SeriesKey, seconds: number): { t: Float32Array; v: Float32Array } {
  const h = history;
  const n = Math.min(h.n, Math.round(seconds * 30));
  const t = new Float32Array(n);
  const v = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const idx = (h.head - n + k + h.cap) % h.cap;
    t[k] = h.data.t[idx];
    v[k] = h.data[key][idx];
  }
  return { t, v };
}

// ───────────────────────── React-facing store ─────────────────────────
export type DrawerId = 'scenario' | 'target' | 'disturbance' | 'tracking' | 'experiment' | 'optics' | 'view' | null;
export type ViewPreset = 'overview' | 'terminal' | 'link' | 'sensor' | 'orbit' | 'free' | 'follow';
export type FollowKey = 'iss' | 'sat2' | 'sat3';
export type Quality = 'low' | 'medium' | 'high';
export type ThemeId = 'deep-space' | 'laser' | 'aurora' | 'solar' | 'daylight';
export const THEMES: { id: ThemeId; name: string; note: string; swatch: string[] }[] = [
  { id: 'deep-space', name: 'Deep Space', note: 'Navy + ice cyan (default)', swatch: ['#070b12', '#8fdcff', '#ffb547', '#9cf5c8'] },
  { id: 'laser', name: 'Laser Red', note: 'Charcoal + crimson', swatch: ['#0f0a0e', '#ff6b6b', '#ffb547', '#9cf5c8'] },
  { id: 'aurora', name: 'Aurora', note: 'Deep teal + mint', swatch: ['#06110f', '#5ef2c2', '#ffb547', '#b7f58c'] },
  { id: 'solar', name: 'Solar Gold', note: 'Graphite + amber', swatch: ['#110f0b', '#ffc861', '#8fdcff', '#9cf5c8'] },
  { id: 'daylight', name: 'Daylight', note: 'Light panels for bright rooms and projectors', swatch: ['#f4f7fa', '#0b6fb8', '#c07400', '#0e9f63'] },
];
export function applyTheme(t: ThemeId) {
  if (typeof document === 'undefined') return;
  if (t === 'deep-space') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
export interface MeasureTarget {
  id: string;
  name: string;
  /** True position, km, site ENU frame. */
  pos: [number, number, number];
}

interface AppState {
  tick: number;
  hud: Snapshot | null;
  config: SimConfig;
  providerKind: ProviderKind;
  providerStatus: 'connecting' | 'online' | 'error';
  providerError: string | null;
  serverUrl: string;
  running: boolean;
  demo: boolean;
  engineFps: number;
  timeScale: number;
  events: TransitionEvent[];
  drawer: DrawerId;
  view: ViewPreset;
  viewNonce: number;
  followKey: FollowKey;
  quality: Quality;
  theme: ThemeId;
  themeOpen: boolean;
  videoOpen: boolean;
  sensorTab: 'camera' | 'screen';
  autoReport: boolean;
  overlays: { labels: boolean; fov: boolean; trails: boolean; grid: boolean; truth: boolean; calibration: boolean; roi: boolean; space: boolean };
  sensorExpanded: boolean;
  analysisOpen: boolean;
  analysisTab: string;
  helpOpen: boolean;
  measure: { enabled: boolean; picks: MeasureTarget[] };
  recording: { active: boolean; frames: number };
  replay: { name: string; length: number; position: number; playing: boolean } | null;
  toast: string | null;
  /** Increments whenever the run restarts (reset, preset, demo) — used to re-frame the camera. */
  resetNonce: number;

  connect: (kind: ProviderKind, opts?: { url?: string; recording?: Recording }) => Promise<void>;
  send: (cmd: EngineCommand) => void;
  patchConfig: (patch: DeepPartial<SimConfig>) => void;
  replaceConfig: (cfg: SimConfig) => void;
  setDrawer: (d: DrawerId) => void;
  setView: (v: ViewPreset) => void;
  flyTo: (k: FollowKey) => void;
  setQuality: (q: Quality) => void;
  setTheme: (t: ThemeId) => void;
  toggleOverlay: (k: keyof AppState['overlays']) => void;
  set: (p: Partial<AppState>) => void;
  startRecording: () => void;
  stopRecording: () => void;
  exportCsv: () => void;
  exportJson: () => void;
  downloadReport: (source: 'live' | 'recording', fmt?: ReportFormat) => void;
  seekReplay: (i: number) => void;
  notify: (msg: string, ms?: number) => void;
}

let provider: TelemetryProvider | null = null;
export const recorder = new Recorder();
let lastHud = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export type ReportFormat = 'html' | 'md' | 'json';

/** Save a performance report as HTML (printable), Markdown or JSON. */
export function saveReport(rep: PerformanceReport, fmt: ReportFormat, base: string) {
  if (fmt === 'json') download(`${base}.json`, JSON.stringify(rep, null, 2), 'application/json');
  else if (fmt === 'md') download(`${base}.md`, reportMarkdown(rep), 'text/markdown');
  else download(`${base}.html`, reportHtml(rep), 'text/html');
}

export function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export const useApp = create<AppState>((set, get) => {
  const onMessage = (m: EngineMessage) => {
    switch (m.type) {
      case 'snapshot': {
        const s = m.snapshot;
        if (live.snap && s.t < live.snap.t - 0.5) {
          clearHistory();
          set({ resetNonce: get().resetNonce + 1 });
        }
        if (s.state === 'DETECTED' && live.snap?.state !== 'DETECTED' && s.detection) {
          live.initialErrPx = Math.hypot(s.detection.x - s.camera.width / 2, s.detection.y - s.camera.height / 2);
        }
        live.snap = s;
        live.recent.push(s);
        if (live.recent.length > 40) live.recent.shift();
        if (s.plan) live.plan = s.plan;
        pushHistory(s);
        recorder.push(s);
        const now = performance.now();
        const newEvents = s.events.length ? [...get().events, ...s.events].slice(-250) : null;
        if (now - lastHud > 80 || newEvents) {
          lastHud = now;
          const rp = provider instanceof ReplayProvider ? provider : null;
          set({
            hud: s,
            tick: get().tick + 1,
            ...(newEvents ? { events: newEvents } : {}),
            recording: { active: recorder.active, frames: recorder.frames.length },
            ...(rp ? { replay: { name: rp.recording.name, length: rp.length, position: rp.position, playing: rp.isPlaying } } : {}),
          });
        }
        break;
      }
      case 'frame':
        live.image = { width: m.width, height: m.height, frame: m.frame, data: m.data };
        live.imageVersion++;
        break;
      case 'config':
        set({ config: m.config });
        break;
      case 'status':
        set({ running: m.running, demo: m.demo, engineFps: m.fps, timeScale: m.timeScale });
        break;
      case 'error':
        set({ providerError: m.message });
        get().notify(m.message);
        break;
    }
  };

  return {
    tick: 0,
    hud: null,
    config: DEFAULT_CONFIG,
    providerKind: 'local',
    providerStatus: 'connecting',
    providerError: null,
    serverUrl: DEFAULT_SERVER_URL,
    running: false,
    demo: false,
    engineFps: 0,
    timeScale: 1,
    events: [],
    drawer: null,
    view: 'overview',
    viewNonce: 0,
    followKey: 'iss',
    quality: (localStorageGet('astraq.quality') as Quality) ?? 'medium',
    theme: initialTheme(),
    themeOpen: false,
    videoOpen: false,
    sensorTab: 'camera',
    autoReport: localStorageGet('astraq.autoReport') !== '0',
    overlays: { labels: true, fov: true, trails: true, grid: false, truth: false, calibration: false, roi: true, space: true },
    sensorExpanded: false,
    analysisOpen: false,
    analysisTab: 'error',
    helpOpen: false,
    measure: { enabled: false, picks: [] },
    recording: { active: false, frames: 0 },
    replay: null,
    toast: null,
    resetNonce: 0,

    async connect(kind, opts) {
      const prevKind = get().providerKind;
      provider?.disconnect();
      provider = null;
      clearHistory();
      live.snap = null;
      live.image = null;
      live.imageVersion++;
      set({ providerKind: kind, providerStatus: 'connecting', providerError: null, events: [], replay: null, hud: null });
      let p: TelemetryProvider;
      if (kind === 'remote') p = new RemoteEngineProvider(opts?.url ?? get().serverUrl);
      else if (kind === 'replay' && opts?.recording) p = new ReplayProvider(opts.recording);
      else p = new LocalEngineProvider();
      try {
        await p.connect(onMessage);
        provider = p;
        set({ providerStatus: 'online', ...(opts?.url ? { serverUrl: opts.url } : {}) });
        if (kind === 'remote') {
          p.send({ type: 'replaceConfig', config: get().config });
          p.send({ type: 'start' });
        }
        if (kind === 'replay' && opts?.recording) {
          set({ replay: { name: opts.recording.name, length: opts.recording.frames.length, position: 0, playing: true } });
        }
      } catch (err) {
        set({ providerStatus: 'error', providerError: String((err as Error).message ?? err) });
        get().notify(String((err as Error).message ?? err));
        if (kind !== 'local' && prevKind !== kind) {
          // Fall back to the local engine so the demo keeps working.
          await get().connect('local');
          set({ providerError: String((err as Error).message ?? err) });
        }
      }
    },

    send(cmd) {
      provider?.send(cmd);
      if (cmd.type === 'reset' || cmd.type === 'replaceConfig') clearHistory();
    },

    patchConfig(patch) {
      set({ config: mergeConfig(get().config, patch) });
      provider?.send({ type: 'config', patch });
    },

    replaceConfig(cfg) {
      set({ config: cfg });
      clearHistory();
      provider?.send({ type: 'replaceConfig', config: cfg });
    },

    setDrawer: (d) => set({ drawer: get().drawer === d ? null : d }),
    setView: (v) => set({ view: v, viewNonce: get().viewNonce + 1 }),
    flyTo: (k) => set({ view: 'follow', followKey: k, viewNonce: get().viewNonce + 1, overlays: { ...get().overlays, space: true } }),
    setQuality: (q) => {
      localStorageSet('astraq.quality', q);
      set({ quality: q });
      provider?.send({ type: 'imageRate', hz: q === 'low' ? 8 : q === 'medium' ? 15 : 30 });
    },
    setTheme: (t) => {
      localStorageSet('astraq.theme', t);
      applyTheme(t);
      set({ theme: t });
    },
    toggleOverlay: (k) => set({ overlays: { ...get().overlays, [k]: !get().overlays[k] } }),
    set: (p) => set(p),

    startRecording() {
      recorder.start();
      set({ recording: { active: true, frames: 0 } });
      get().notify('Recording telemetry…');
    },
    stopRecording() {
      recorder.stop();
      set({ recording: { active: false, frames: recorder.frames.length } });
      if (get().autoReport && recorder.frames.length > 1) {
        get().downloadReport('recording', 'html');
        get().notify(`Recorded ${recorder.frames.length} frames — performance report saved automatically`);
      } else get().notify(`Recorded ${recorder.frames.length} frames`);
    },
    downloadReport(source, fmt = 'html') {
      const kindLabel = get().providerKind === 'remote' ? 'FastAPI engine' : get().providerKind === 'replay' ? 'Replay' : 'Browser engine (local)';
      if (source === 'recording') {
        const last = recorder.frames[recorder.frames.length - 1];
        if (!last) return get().notify('Nothing recorded yet — press Record first');
        const rep = buildReport({ kind: 'recording', source: kindLabel, config: get().config, metrics: last.metrics, events: recorder.events });
        saveReport(rep, fmt, `astraq-report-${stamp()}`);
      } else {
        const snap = live.snap;
        if (!snap) return get().notify('No telemetry yet');
        const rep = buildReport({ kind: 'live', source: kindLabel, config: get().config, metrics: snap.metrics, events: get().events });
        saveReport(rep, fmt, `astraq-report-${stamp()}`);
      }
    },
    exportCsv() {
      if (!recorder.frames.length) return get().notify('Nothing recorded yet — press Record first');
      download(`astraq-run-${stamp()}.csv`, recorder.toCsv(), 'text/csv');
    },
    exportJson() {
      if (!recorder.frames.length) return get().notify('Nothing recorded yet — press Record first');
      const rec = recorder.toRecording(`ASTRAQ run ${stamp()}`, get().config, get().providerKind);
      download(`astraq-run-${stamp()}.json`, JSON.stringify(rec), 'application/json');
    },
    seekReplay(i) {
      if (provider instanceof ReplayProvider) {
        provider.seek(i);
        clearHistory();
      }
    },
    notify(msg, ms = 3800) {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: msg });
      toastTimer = setTimeout(() => set({ toast: null }), ms);
    },
  };
});

export const stateColor = (s: TrackState | undefined): string => {
  switch (s) {
    case 'SEARCHING':
      return 'var(--amber)';
    case 'DETECTED':
      return 'var(--amber-hi)';
    case 'ACQUIRING':
      return 'var(--amber-hi)';
    case 'TRACKING':
      return 'var(--ice)';
    case 'LOCKED':
      return 'var(--lock)';
    case 'LOST':
      return 'var(--lost)';
    case 'REACQUIRING':
      return 'var(--warn)';
    default:
      return 'var(--text-3)';
  }
};

export const STATE_HEX: Record<TrackState, string> = {
  IDLE: '#5b6b7d',
  SEARCHING: '#ffb547',
  DETECTED: '#ffd08a',
  ACQUIRING: '#ffd08a',
  TRACKING: '#8fdcff',
  LOCKED: '#9cf5c8',
  LOST: '#ff6b5e',
  REACQUIRING: '#ff9a4d',
};

function initialTheme(): ThemeId {
  const t = localStorageGet('astraq.theme') as ThemeId | null;
  const ok = THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'deep-space';
  applyTheme(ok);
  return ok;
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}
