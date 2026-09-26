/**
 * Closed-loop ablation of the learned verifier: the same presets and seeds with the
 * verifier off (hand-tuned confidence) and on (MLP), image-based detector.
 * Usage (from web/): npx rolldown scripts/verifier/closed-loop.ts --platform node -o /tmp/cl.mjs && node /tmp/cl.mjs 20 15
 */
import { SimulationEngine } from '../../src/core/engine';
import { mergeConfig } from '../../src/core/config';
import { presetConfig } from '../../src/core/presets';

const runs = Number(process.argv[2] ?? 10);
const secs = Number(process.argv[3] ?? 15);
const presets = (process.argv[4] ?? 'open-sky,weak-beacon,acquisition-challenge,high-jitter,fast-target,moving-platform,occlusion,ps-baseline').split(',');
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log('preset                 verifier locked acq_mean acq_max  rms_px  loss_%  false_det  reacq_max');
for (const p of presets) {
  for (const verifier of [false, true]) {
    const acq: number[] = [];
    const rms: number[] = [];
    const loss: number[] = [];
    const reacq: number[] = [];
    let fd = 0;
    for (let r = 0; r < runs; r++) {
      const cfg = mergeConfig(presetConfig(p, 1000 + r), { detection: { verifier } });
      const e = new SimulationEngine(cfg);
      e.renderAlways = false;
      e.start();
      let s = e.step();
      for (let i = 1; i < secs * 30; i++) s = e.step();
      const m = s.metrics;
      if (m.acquisitionS !== null) acq.push(m.acquisitionS);
      if (m.errRmsPx !== null) rms.push(m.errRmsPx);
      if (m.lossPct !== null) loss.push(m.lossPct);
      if (m.reacqMaxS !== null) reacq.push(m.reacqMaxS);
      fd += m.falseDetections;
    }
    console.log(
      `${p.padEnd(22)} ${verifier ? 'MLP ' : 'hand'}     ${String(acq.length).padStart(2)}/${runs}  ${mean(acq).toFixed(2).padStart(6)}  ${(acq.length ? Math.max(...acq) : NaN).toFixed(2).padStart(6)}  ${mean(rms).toFixed(2).padStart(6)}  ${mean(loss).toFixed(2).padStart(6)}  ${String(fd).padStart(8)}  ${(reacq.length ? Math.max(...reacq) : NaN).toFixed(2).padStart(8)}`,
    );
  }
}
