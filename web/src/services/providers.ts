/**
 * TelemetryProvider: the only thing the UI knows about "where the simulation runs".
 *
 *   LocalEngineProvider   Web Worker running the TypeScript engine (default, no backend)
 *   RemoteEngineProvider  FastAPI server over WebSocket (Python engine)
 *   ReplayProvider        plays back a recorded run
 *
 * Swapping providers never requires UI changes.
 */
import type { EngineCommand, EngineMessage } from '../engine/protocol';
import type { Recording } from '../core/telemetry/recorder';

export type ProviderKind = 'local' | 'remote' | 'replay';
export type Listener = (msg: EngineMessage) => void;

export interface TelemetryProvider {
  readonly kind: ProviderKind;
  readonly label: string;
  connect(listener: Listener): Promise<void>;
  send(cmd: EngineCommand): void;
  disconnect(): void;
}

export class LocalEngineProvider implements TelemetryProvider {
  readonly kind = 'local' as const;
  readonly label = 'Local engine (browser worker)';
  private worker: Worker | null = null;

  async connect(listener: Listener) {
    this.worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<EngineMessage>) => listener(e.data);
    this.worker.onerror = (e) => listener({ type: 'error', message: `Engine worker error: ${e.message}` });
  }

  send(cmd: EngineCommand) {
    this.worker?.postMessage(cmd);
  }

  disconnect() {
    this.worker?.terminate();
    this.worker = null;
  }
}

/** Binary frame header: 'AQF1' magic, uint16 width, uint16 height, uint32 frame. */
function decodeBinaryFrame(buf: ArrayBuffer): EngineMessage | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0) !== 0x41514631) return null;
  const width = dv.getUint16(4, true);
  const height = dv.getUint16(6, true);
  const frame = dv.getUint32(8, true);
  const data = new Uint8ClampedArray(buf, 12, width * height);
  return { type: 'frame', width, height, frame, data };
}

export class RemoteEngineProvider implements TelemetryProvider {
  readonly kind = 'remote' as const;
  readonly label: string;
  private ws: WebSocket | null = null;
  constructor(private baseUrl: string) {
    this.label = `Remote engine (${baseUrl})`;
  }

  connect(listener: Listener): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/telemetry';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      const timeout = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error(`No response from ${wsUrl} within 4 s — is the FastAPI server running?`));
        }
      }, 4000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(timeout);
          reject(new Error(`WebSocket connection to ${wsUrl} failed`));
        } else listener({ type: 'error', message: 'WebSocket error' });
      };
      ws.onclose = () => {
        if (opened) listener({ type: 'error', message: 'Remote engine disconnected' });
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            listener(JSON.parse(e.data) as EngineMessage);
          } catch {
            /* ignore malformed */
          }
        } else {
          const m = decodeBinaryFrame(e.data as ArrayBuffer);
          if (m) listener(m);
        }
      };
    });
  }

  send(cmd: EngineCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}

/** Plays a recording back at its original timing (images are not recorded). */
export class ReplayProvider implements TelemetryProvider {
  readonly kind = 'replay' as const;
  readonly label: string;
  private listener: Listener | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  private playing = true;
  private speed = 1;
  private clock = 0;
  constructor(public readonly recording: Recording) {
    this.label = `Replay · ${recording.name}`;
  }

  get length() {
    return this.recording.frames.length;
  }
  get position() {
    return this.index;
  }
  get isPlaying() {
    return this.playing;
  }

  async connect(listener: Listener) {
    this.listener = listener;
    if (this.recording.config) listener({ type: 'config', config: this.recording.config, version: 1 });
    this.clock = this.recording.frames[0]?.t ?? 0;
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = ((now - last) / 1000) * this.speed;
      last = now;
      if (!this.playing) return;
      this.clock += dt;
      const frames = this.recording.frames;
      while (this.index < frames.length - 1 && frames[this.index + 1].t <= this.clock) {
        this.index++;
        this.emit(this.index);
      }
      if (this.index >= frames.length - 1) this.playing = false;
      listener({ type: 'status', running: this.playing, demo: false, fps: this.playing ? 30 : 0, timeScale: this.speed });
    }, 16);
    this.emit(0);
  }

  private emit(i: number) {
    const s = this.recording.frames[i];
    if (s && this.listener) this.listener({ type: 'snapshot', snapshot: { ...s, source: 'replay' } });
  }

  seek(i: number) {
    const frames = this.recording.frames;
    this.index = Math.max(0, Math.min(frames.length - 1, Math.round(i)));
    this.clock = frames[this.index]?.t ?? 0;
    this.emit(this.index);
  }

  send(cmd: EngineCommand) {
    if (cmd.type === 'start') {
      if (this.index >= this.recording.frames.length - 1) this.seek(0);
      this.playing = true;
    } else if (cmd.type === 'pause') this.playing = false;
    else if (cmd.type === 'reset') this.seek(0);
    else if (cmd.type === 'timeScale') this.speed = cmd.value;
  }

  disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listener = null;
  }
}

export const DEFAULT_SERVER_URL: string =
  (import.meta.env.VITE_ASTRAQ_SERVER as string | undefined) ?? 'http://localhost:8000';
