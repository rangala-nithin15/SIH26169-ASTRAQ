/**
 * Message protocol shared by every engine host: the browser Web Worker, the FastAPI
 * WebSocket server, and (read-only) the replay player.
 */
import type { DeepPartial, SimConfig } from '../core/config';
import type { Snapshot } from '../core/telemetry/types';

export type EngineCommand =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'config'; patch: DeepPartial<SimConfig> }
  | { type: 'replaceConfig'; config: SimConfig }
  | { type: 'demo'; on: boolean }
  | { type: 'mode'; mode: 'auto' | 'manual' }
  | { type: 'manual'; pan: number; tilt: number }
  | { type: 'reacquire' }
  | { type: 'timeScale'; value: number }
  | { type: 'imageRate'; hz: number };

export type EngineMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'frame'; width: number; height: number; frame: number; data: Uint8ClampedArray }
  | { type: 'config'; config: SimConfig; version: number }
  | { type: 'status'; running: boolean; demo: boolean; fps: number; timeScale: number }
  | { type: 'error'; message: string };
