/// <reference lib="webworker" />
/**
 * Headless batch runner (Monte-Carlo over seeds). Runs complete simulations as fast
 * as possible in a separate worker so the live view keeps running.
 */
import { SimulationEngine } from '../core/engine';
import { SimConfig, mergeConfig } from '../core/config';
import type { MetricsSummary } from '../core/telemetry/types';

export interface BatchRequest {
  config: SimConfig;
  runs: number;
  durationS: number;
  seed0: number;
}
export interface BatchRunResult {
  seed: number;
  metrics: MetricsSummary;
  finalState: string;
}
export type BatchMessage =
  | { type: 'progress'; done: number; total: number; result: BatchRunResult }
  | { type: 'done'; results: BatchRunResult[] };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<BatchRequest>) => {
  const { config, runs, durationS, seed0 } = e.data;
  const results: BatchRunResult[] = [];
  for (let r = 0; r < runs; r++) {
    const seed = seed0 + r;
    const engine = new SimulationEngine(mergeConfig(config, { seed }));
    engine.renderAlways = false;
    engine.start();
    const frames = Math.round(durationS * config.camera.frameRateHz);
    let snap = engine.step();
    const t0 = performance.now();
    for (let i = 1; i < frames; i++) snap = engine.step();
    const perFrame = (performance.now() - t0) / Math.max(1, frames - 1);
    const metrics = { ...snap.metrics, fps: 1000 / Math.max(0.05, perFrame) };
    metrics.acceptance = { ...metrics.acceptance, fps: metrics.fps >= 20 };
    const res = { seed, metrics, finalState: snap.state };
    results.push(res);
    ctx.postMessage({ type: 'progress', done: r + 1, total: runs, result: res } satisfies BatchMessage);
  }
  ctx.postMessage({ type: 'done', results } satisfies BatchMessage);
};
