/// <reference lib="webworker" />
/**
 * Local engine host: runs the ASTRAQ simulation engine in a Web Worker at the
 * configured camera frame rate, so the 3D view never blocks the tracking loop.
 * Posts one snapshot per frame and the rendered sensor image at `imageRate` Hz.
 */
import { SimulationEngine } from '../core/engine';
import { DEFAULT_CONFIG } from '../core/config';
import type { EngineCommand, EngineMessage } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const engine = new SimulationEngine(DEFAULT_CONFIG);
engine.source = 'local';
let timeScale = 1;
let imageRate = 15;
let lastImageT = -1;
let timer: ReturnType<typeof setTimeout> | null = null;
let fpsEma = 0;
let capEma = 0;
const stepTimes: number[] = [];
let lastWall = performance.now();
let sentVersion = -1;
let accumulator = 0;

function post(msg: EngineMessage, transfer?: Transferable[]) {
  ctx.postMessage(msg, transfer ?? []);
}

function sendConfig() {
  if (engine.configVersion !== sentVersion) {
    sentVersion = engine.configVersion;
    post({ type: 'config', config: engine.cfg, version: sentVersion });
  }
}

function status() {
  post({ type: 'status', running: engine.running, demo: engine.demoRunning, fps: fpsEma, timeScale });
}

function stepOnce() {
  const snap = engine.step();
  post({ type: 'snapshot', snapshot: snap });
  const frame = engine.getFrame();
  if (frame && (snap.t - lastImageT >= 1 / imageRate - 1e-6 || lastImageT < 0 || snap.t < lastImageT)) {
    lastImageT = snap.t;
    const copy = frame.data.slice();
    post({ type: 'frame', width: frame.width, height: frame.height, frame: snap.frame, data: copy }, [copy.buffer]);
  }
  sendConfig();
}

function loop() {
  const now = performance.now();
  const wall = (now - lastWall) / 1000;
  lastWall = now;
  const dtF = 1 / engine.cfg.camera.frameRateHz;
  if (engine.running) {
    accumulator = Math.min(accumulator + wall * timeScale, dtF * 4);
    let steps = 0;
    const t0 = performance.now();
    while (accumulator >= dtF && steps < 4) {
      stepOnce();
      accumulator -= dtF;
      steps++;
    }
    if (steps > 0) {
      // Processing capacity: frames per second the full pipeline (render + detect +
      // estimate + control) could sustain, from measured per-frame cost.
      const perFrame = (performance.now() - t0) / steps;
      const capacity = 1000 / Math.max(0.1, perFrame);
      capEma = capEma ? capEma * 0.95 + capacity * 0.05 : capacity;
      engine.setMeasuredFps(Math.min(capEma, 999));
      for (let i = 0; i < steps; i++) stepTimes.push(now);
    }
    while (stepTimes.length && now - stepTimes[0] > 1000) stepTimes.shift();
    fpsEma = stepTimes.length; // achieved frames in the last wall-clock second
  }
  if (Math.random() < 0.05) status();
  timer = setTimeout(loop, Math.max(2, (dtF / Math.max(0.1, timeScale)) * 1000 * 0.5));
}

ctx.onmessage = (e: MessageEvent<EngineCommand>) => {
  const cmd = e.data;
  try {
    switch (cmd.type) {
      case 'start':
        engine.start();
        break;
      case 'pause':
        engine.pause();
        break;
      case 'reset':
        engine.reset();
        lastImageT = -1;
        stepOnce();
        break;
      case 'config':
        engine.applyConfig(cmd.patch);
        break;
      case 'replaceConfig':
        engine.applyConfig({ ...cmd.config, seed: cmd.config.seed });
        break;
      case 'demo':
        engine.setDemo(cmd.on);
        lastImageT = -1;
        break;
      case 'mode':
        engine.setMode(cmd.mode);
        break;
      case 'manual':
        engine.setManualGoal(cmd.pan, cmd.tilt);
        break;
      case 'reacquire':
        engine.reacquire();
        break;
      case 'timeScale':
        timeScale = Math.min(4, Math.max(0.1, cmd.value));
        break;
      case 'imageRate':
        imageRate = Math.min(60, Math.max(2, cmd.hz));
        break;
    }
    sendConfig();
    status();
    if (!engine.running) stepIdle();
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};

/** When paused, still publish the current state so the UI reflects changes. */
function stepIdle() {
  const frame = engine.getFrame();
  if (frame) {
    const copy = frame.data.slice();
    post({ type: 'frame', width: frame.width, height: frame.height, frame: engine.frame, data: copy }, [copy.buffer]);
  }
}

// Boot: publish config, start running immediately (the scene should come alive on load).
sendConfig();
engine.start();
stepOnce();
if (timer === null) loop();
