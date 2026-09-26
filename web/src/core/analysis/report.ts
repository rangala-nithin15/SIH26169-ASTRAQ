/**
 * Automatic performance report (PS deliverable "Performance Log"): simulation duration,
 * FPS, acquisition time, average and maximum tracking error, lock retention rate,
 * processing time, plus the rest of the PS169 metrics, the configuration and the
 * state-transition log.
 *
 * Pure functions: the same report is produced for a live run, a recording, a batch
 * and the video benchmark, as JSON (machine-readable), Markdown and a self-contained
 * printable HTML page.
 */
import type { SimConfig } from '../config';
import type { MetricsSummary, TransitionEvent } from '../telemetry/types';

export type ReportKind = 'live' | 'recording' | 'batch' | 'video';

export interface BatchRow {
  seed: number;
  finalState: string;
  metrics: MetricsSummary;
}

export interface VideoReportSummary {
  fileName: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  detectionRate: number;
  acquisitionS: number | null;
  lossPct: number | null;
  reacqMaxS: number | null;
  centroidRmsePx: number | null;
  centroidMaxPx: number | null;
  procMeanMs: number;
  processingFps: number;
  lockRetentionPct: number | null;
  truthProvided: boolean;
}

export interface ReportInput {
  kind: ReportKind;
  title?: string;
  generatedAt?: string;
  source: string;
  config: SimConfig | null;
  metrics?: MetricsSummary | null;
  events?: TransitionEvent[];
  batch?: BatchRow[];
  video?: VideoReportSummary;
}

export interface ReportRow {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  digits: number;
  limit?: string;
  pass?: boolean | null;
  ps?: boolean;
}

export interface PerformanceReport {
  format: 'astraq-performance-report';
  version: 1;
  kind: ReportKind;
  title: string;
  generatedAt: string;
  source: string;
  scenario: string | null;
  rows: ReportRow[];
  acceptance: { label: string; limit: string; value: string; pass: boolean | null }[];
  configSummary: [string, string][];
  events: TransitionEvent[];
  batch?: { rows: BatchRow[]; aggregate: ReportRow[] };
  video?: VideoReportSummary;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const max = (a: number[]) => (a.length ? Math.max(...a) : null);
const nn = (a: (number | null | undefined)[]) => a.filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));

export function fmtVal(v: number | null | undefined, digits: number, unit = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}

function metricRows(m: MetricsSummary): ReportRow[] {
  return [
    { key: 'duration', label: 'Simulation duration', value: m.elapsedS, unit: 's', digits: 1, ps: true },
    { key: 'frames', label: 'Frames processed', value: m.frames, unit: '', digits: 0 },
    { key: 'fps', label: 'Processing speed (engine FPS)', value: m.fps || null, unit: 'FPS', digits: 1, limit: '≥ 20', pass: m.acceptance.fps, ps: true },
    { key: 'acq', label: 'Acquisition time (start → first LOCK)', value: m.acquisitionS, unit: 's', digits: 2, limit: '≤ 2 s', pass: m.acceptance.acquisition, ps: true },
    { key: 'tdet', label: 'First confirmed detection', value: m.tDetect, unit: 's', digits: 2 },
    { key: 'errMean', label: 'Average tracking error', value: m.errMeanPx, unit: 'px', digits: 2, ps: true },
    { key: 'errRms', label: 'RMS tracking error', value: m.errRmsPx, unit: 'px', digits: 2, limit: '≤ 10 px', pass: m.acceptance.error, ps: true },
    { key: 'errP95', label: '95th-percentile tracking error', value: m.errP95Px, unit: 'px', digits: 2 },
    { key: 'errMax', label: 'Maximum tracking error', value: m.errMaxPx, unit: 'px', digits: 2, ps: true },
    { key: 'retention', label: 'Lock retention rate (after first lock)', value: m.lockRetentionPct, unit: '%', digits: 1, ps: true },
    { key: 'loss', label: 'Target loss (after first lock)', value: m.lossPct, unit: '%', digits: 2, limit: '< 5 %', pass: m.acceptance.loss, ps: true },
    { key: 'lossEvents', label: 'Loss events', value: m.lossEvents, unit: '', digits: 0 },
    { key: 'reacqMean', label: 'Re-acquisition time, mean', value: m.reacqMeanS, unit: 's', digits: 2 },
    { key: 'reacqMax', label: 'Re-acquisition time, worst', value: m.reacqMaxS, unit: 's', digits: 2, limit: '≤ 1 s', pass: m.acceptance.reacq, ps: true },
    { key: 'proc', label: 'Processing time per frame, mean', value: m.procMeanMs, unit: 'ms', digits: 2, ps: true },
    { key: 'procMax', label: 'Processing time per frame, max', value: m.procMaxMs, unit: 'ms', digits: 2 },
    { key: 'centroid', label: 'Centroid error vs rendered spot (RMS)', value: m.centroidRmsPx, unit: 'px', digits: 3 },
    { key: 'false', label: 'False detections accepted', value: m.falseDetections, unit: '', digits: 0 },
    { key: 'aqs', label: 'Alignment Quality Score (last 10 s)', value: m.aqs, unit: '/100', digits: 0 },
  ];
}

function batchAggregate(rows: BatchRow[]): ReportRow[] {
  const acq = nn(rows.map((r) => r.metrics.acquisitionS));
  const rms = nn(rows.map((r) => r.metrics.errRmsPx));
  const emax = nn(rows.map((r) => r.metrics.errMaxPx));
  const loss = nn(rows.map((r) => r.metrics.lossPct));
  const ret = nn(rows.map((r) => r.metrics.lockRetentionPct));
  const reacq = nn(rows.map((r) => r.metrics.reacqMaxS));
  const fps = nn(rows.map((r) => r.metrics.fps));
  const proc = nn(rows.map((r) => r.metrics.procMeanMs));
  const n = rows.length;
  return [
    { key: 'runs', label: 'Runs', value: n, unit: '', digits: 0 },
    { key: 'locked', label: 'Runs that reached LOCK', value: acq.length, unit: `of ${n}`, digits: 0 },
    { key: 'acqMean', label: 'Acquisition time, mean', value: mean(acq), unit: 's', digits: 2 },
    { key: 'acqMax', label: 'Acquisition time, worst', value: max(acq), unit: 's', digits: 2, limit: '≤ 2 s', pass: acq.length ? (max(acq) as number) <= 2 : null },
    { key: 'acqPass', label: 'Runs acquiring within 2 s', value: n ? (100 * acq.filter((x) => x <= 2).length) / n : null, unit: '%', digits: 0 },
    { key: 'rmsMean', label: 'RMS tracking error, mean over runs', value: mean(rms), unit: 'px', digits: 2, limit: '≤ 10 px', pass: rms.length ? (mean(rms) as number) <= 10 : null },
    { key: 'errMax', label: 'Maximum tracking error, worst run', value: max(emax), unit: 'px', digits: 2 },
    { key: 'lossMean', label: 'Target loss, mean', value: mean(loss), unit: '%', digits: 2, limit: '< 5 %', pass: loss.length ? (mean(loss) as number) < 5 : null },
    { key: 'retMean', label: 'Lock retention, mean', value: mean(ret), unit: '%', digits: 1 },
    { key: 'reacqMax', label: 'Re-acquisition, worst', value: max(reacq), unit: 's', digits: 2, limit: '≤ 1 s', pass: reacq.length ? (max(reacq) as number) <= 1 : null },
    { key: 'fps', label: 'Engine capacity (headless), mean', value: mean(fps), unit: 'FPS', digits: 0, limit: '≥ 20', pass: fps.length ? (mean(fps) as number) >= 20 : null },
    { key: 'proc', label: 'Detection time per frame, mean', value: mean(proc), unit: 'ms', digits: 2 },
  ];
}

function videoRows(v: VideoReportSummary): ReportRow[] {
  return [
    { key: 'frames', label: 'Frames analysed', value: v.frames, unit: '', digits: 0 },
    { key: 'duration', label: 'Video duration', value: v.frames / Math.max(1, v.fps), unit: 's', digits: 2, ps: true },
    { key: 'det', label: 'Detection rate', value: 100 * v.detectionRate, unit: '%', digits: 1 },
    { key: 'acq', label: 'Acquisition time', value: v.acquisitionS, unit: 's', digits: 3, limit: '≤ 2 s', pass: v.acquisitionS === null ? null : v.acquisitionS <= 2, ps: true },
    { key: 'retention', label: 'Lock retention', value: v.lockRetentionPct, unit: '%', digits: 1, ps: true },
    { key: 'loss', label: 'Target loss', value: v.lossPct, unit: '%', digits: 2, limit: '< 5 %', pass: v.lossPct === null ? null : v.lossPct < 5, ps: true },
    { key: 'reacq', label: 'Re-acquisition, worst', value: v.reacqMaxS, unit: 's', digits: 2, limit: '≤ 1 s', pass: v.reacqMaxS === null ? null : v.reacqMaxS <= 1 },
    { key: 'rmse', label: 'Centroid RMSE vs ground truth', value: v.centroidRmsePx, unit: 'px', digits: 3, ps: true },
    { key: 'cmax', label: 'Centroid error, max', value: v.centroidMaxPx, unit: 'px', digits: 3 },
    { key: 'proc', label: 'Processing time per frame, mean', value: v.procMeanMs, unit: 'ms', digits: 2, ps: true },
    { key: 'fps', label: 'Processing speed', value: v.processingFps, unit: 'FPS', digits: 1, limit: '≥ 20', pass: v.processingFps >= 20, ps: true },
  ];
}

function configSummary(c: SimConfig | null): [string, string][] {
  if (!c) return [];
  const d = c.disturbance;
  const noise = [d.gaussianNoise > 0 ? `Gaussian σ ${d.gaussianNoise}` : '', d.saltPepper > 0 ? `salt & pepper ${(d.saltPepper * 100).toFixed(1)} %` : '', d.poisson ? 'Poisson' : '']
    .filter(Boolean)
    .join(', ');
  return [
    ['Scenario', c.scenarioId],
    ['Seed', String(c.seed)],
    ['Camera', `${c.camera.width}×${c.camera.height} mono, ${c.camera.hfovDeg}° HFOV, ${c.camera.frameRateHz} Hz${c.camera.wideAcquisition ? `, wide-field acquisition ${c.camera.wideHfovDeg}°` : ''}`],
    ['Search field', `±${c.logic.searchHalfUDeg}° × ±${c.logic.searchHalfVDeg}° (${Math.round((2 * c.logic.searchHalfUDeg) / (c.camera.hfovDeg / c.camera.width))} px screen)`],
    ['Target', `${c.target.trajectory}, ${c.target.spotShape} spot ${c.target.spotSizePx} px, start ${c.target.startMode}`],
    ['Gimbal', `max ${c.gimbal.maxRateDegS} °/s, ${c.gimbal.maxAccelDegS2} °/s²`],
    ['Control', `PID Kp ${c.control.kp} Ki ${c.control.ki} Kd ${c.control.kd} at ${c.control.controlRateHz} Hz, feed-forward ${c.control.feedForward ? 'on' : 'off'}; Kalman ${c.kalman.enabled ? 'on' : 'off'}`],
    ['Detector', `${c.detection.provider}${c.detection.verifier ? ' + learned verifier' : ''}, threshold ${c.detection.thresholdSigma}σ`],
    ['Image noise', noise || 'none'],
    ['Atmosphere', `${d.atmosphere} (strength ${d.atmosphereStrength}), turbulence ${d.turbulence}`],
    ['Platform', `jitter ±${d.jitterPx} px/frame, vibration ${d.vibrationPx} px @ ${d.vibrationHz} Hz, motion ${d.platformMotion} ${d.platformMotionPx} px`],
    ['Outages', `${(d.dropoutProb * 100).toFixed(0)} % random dropouts${d.occlusionPeriodS > 0 ? `, ${d.occlusionDurS} s outage every ${d.occlusionPeriodS} s` : ''}${d.decoy ? ', decoy glint' : ''}`],
  ];
}

export function buildReport(inp: ReportInput): PerformanceReport {
  const generatedAt = inp.generatedAt ?? new Date().toISOString();
  const kindTitle = { live: 'Live run', recording: 'Recorded run', batch: 'Monte-Carlo batch', video: 'Video benchmark (camera bypass)' }[inp.kind];
  let rows: ReportRow[] = [];
  if (inp.video) rows = videoRows(inp.video);
  else if (inp.batch?.length) rows = batchAggregate(inp.batch);
  else if (inp.metrics) rows = metricRows(inp.metrics);
  const acceptance = rows
    .filter((r) => r.limit)
    .map((r) => ({ label: r.label, limit: r.limit as string, value: fmtVal(r.value, r.digits, r.unit), pass: r.pass ?? null }));
  return {
    format: 'astraq-performance-report',
    version: 1,
    kind: inp.kind,
    title: inp.title ?? `ASTRAQ performance report — ${kindTitle}`,
    generatedAt,
    source: inp.source,
    scenario: inp.config?.scenarioId ?? null,
    rows,
    acceptance,
    configSummary: configSummary(inp.config),
    events: (inp.events ?? []).filter((e) => e.kind === 'transition').slice(-200),
    ...(inp.batch?.length ? { batch: { rows: inp.batch, aggregate: rows } } : {}),
    ...(inp.video ? { video: inp.video } : {}),
  };
}

export function reportMarkdown(r: PerformanceReport): string {
  const L: string[] = [];
  L.push(`# ${r.title}`, '', `Generated ${r.generatedAt} · source: ${r.source}${r.scenario ? ` · scenario: ${r.scenario}` : ''}`, '');
  L.push('## Summary', '', '| Metric | Value | PS169 limit | Result |', '|---|---|---|---|');
  for (const row of r.rows) {
    const res = row.pass === undefined ? '' : row.pass === null ? 'n/a' : row.pass ? 'PASS' : 'FAIL';
    L.push(`| ${row.label} | ${fmtVal(row.value, row.digits, row.unit)} | ${row.limit ?? ''} | ${res} |`);
  }
  if (r.batch) {
    L.push('', '## Runs', '', '| Seed | End state | Acquisition s | RMS px | Max px | Loss % | Re-acq max s |', '|---|---|---|---|---|---|---|');
    for (const b of r.batch.rows) {
      const m = b.metrics;
      L.push(`| ${b.seed} | ${b.finalState} | ${fmtVal(m.acquisitionS, 2)} | ${fmtVal(m.errRmsPx, 2)} | ${fmtVal(m.errMaxPx, 2)} | ${fmtVal(m.lossPct, 2)} | ${fmtVal(m.reacqMaxS, 2)} |`);
    }
  }
  if (r.configSummary.length) {
    L.push('', '## Configuration', '');
    for (const [k, v] of r.configSummary) L.push(`- **${k}:** ${v}`);
  }
  if (r.events.length) {
    L.push('', '## State transitions', '', '| t (s) | To | Reason |', '|---|---|---|');
    for (const e of r.events) L.push(`| ${e.t.toFixed(2)} | ${e.to ?? ''} | ${e.message.replace(/\|/g, '/')} |`);
  }
  L.push('', 'Tracking error = angle between the optical axis and the true beacon direction, in pixels (0.00625 °/px at 4°), over TRACKING/LOCKED frames after the first lock.');
  L.push('Re-acquisition = LOST → TRACKING; the clock starts when the beacon is visible again (scheduled outages are not counted).');
  return L.join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function reportHtml(r: PerformanceReport): string {
  const badge = (p: boolean | null | undefined) =>
    p === undefined ? '' : p === null ? '<span class="b na">n/a</span>' : p ? '<span class="b ok">PASS</span>' : '<span class="b bad">FAIL</span>';
  const psRows = r.rows
    .map(
      (row) =>
        `<tr${row.ps ? ' class="ps"' : ''}><td>${esc(row.label)}</td><td class="v">${esc(fmtVal(row.value, row.digits, row.unit))}</td><td>${esc(row.limit ?? '')}</td><td>${badge(row.pass)}</td></tr>`,
    )
    .join('');
  const passCount = r.acceptance.filter((a) => a.pass === true).length;
  const judged = r.acceptance.filter((a) => a.pass !== null).length;
  const cards = r.acceptance
    .map((a) => `<div class="card ${a.pass === null ? 'na' : a.pass ? 'ok' : 'bad'}"><div class="k">${esc(a.label)}</div><div class="n">${esc(a.value)}</div><div class="l">limit ${esc(a.limit)}</div></div>`)
    .join('');
  const batch = r.batch
    ? `<h2>Runs</h2><table><thead><tr><th>Seed</th><th>End state</th><th>Acquisition</th><th>RMS error</th><th>Max error</th><th>Loss</th><th>Re-acq. worst</th></tr></thead><tbody>${r.batch.rows
        .map((b) => {
          const m = b.metrics;
          return `<tr><td>${b.seed}</td><td>${esc(b.finalState)}</td><td class="v">${fmtVal(m.acquisitionS, 2, 's')}</td><td class="v">${fmtVal(m.errRmsPx, 2, 'px')}</td><td class="v">${fmtVal(m.errMaxPx, 2, 'px')}</td><td class="v">${fmtVal(m.lossPct, 2, '%')}</td><td class="v">${fmtVal(m.reacqMaxS, 2, 's')}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';
  const video = r.video
    ? `<p class="meta">Video <b>${esc(r.video.fileName)}</b> · ${r.video.width}×${r.video.height} @ ${r.video.fps.toFixed(1)} fps · ground truth ${r.video.truthProvided ? 'provided' : 'not provided'}</p>`
    : '';
  const cfg = r.configSummary.length
    ? `<h2>Configuration</h2><table class="cfg"><tbody>${r.configSummary.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`
    : '';
  const ev = r.events.length
    ? `<h2>State transitions</h2><table><thead><tr><th>t (s)</th><th>State</th><th>Reason</th></tr></thead><tbody>${r.events
        .map((e) => `<tr><td class="v">${e.t.toFixed(2)}</td><td><b>${esc(e.to ?? '')}</b></td><td>${esc(e.message)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)}</title>
<style>
:root{--ink:#152231;--mute:#5d6b7a;--line:#dfe5eb;--ok:#127a4c;--bad:#b3261e;--acc:#c62828}
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 24px 60px}
header{border-bottom:3px solid var(--acc);padding-bottom:14px;margin-bottom:18px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#34465a}
.meta{color:var(--mute);margin:2px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:14px 0}
.card{background:#fff;border:1px solid var(--line);border-left:4px solid var(--mute);border-radius:8px;padding:10px 12px}
.card.ok{border-left-color:var(--ok)}.card.bad{border-left-color:var(--bad)}
.card .k{font-size:12px;color:var(--mute)}.card .n{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums}.card .l{font-size:11.5px;color:var(--mute)}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#eef2f5;font-size:12px;color:#34465a}
td.v{font-variant-numeric:tabular-nums;white-space:nowrap}tr.ps td:first-child{font-weight:600}
.b{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:10px}.b.ok{background:#dff3e8;color:var(--ok)}.b.bad{background:#fbe3e1;color:var(--bad)}.b.na{background:#eceff2;color:var(--mute)}
.cfg td:first-child{width:180px;color:var(--mute)}
.score{font-size:15px;margin-top:6px}footer{margin-top:28px;color:var(--mute);font-size:12px}
@media print{body{background:#fff}main{padding:0}table,.card{break-inside:avoid}}
</style></head><body><main>
<header><h1>${esc(r.title)}</h1>
<p class="meta">Generated ${esc(new Date(r.generatedAt).toLocaleString())} · source: <b>${esc(r.source)}</b>${r.scenario ? ` · scenario: <b>${esc(r.scenario)}</b>` : ''}</p>${video}
<p class="score">PS169 acceptance: <b>${passCount} of ${judged}</b> judged criteria passed.</p></header>
<div class="cards">${cards}</div>
<h2>Performance summary</h2><table><thead><tr><th>Metric</th><th>Value</th><th>PS169 limit</th><th>Result</th></tr></thead><tbody>${psRows}</tbody></table>
${batch}${cfg}${ev}
<footer>Bold rows are the quantities the SIH26169 problem statement asks the performance report to contain. Tracking error = angle between the optical axis and the true beacon direction, expressed in pixels, over TRACKING/LOCKED frames after the first lock. Re-acquisition = LOST → TRACKING, with the clock starting when the beacon is visible again. Generated automatically by ASTRAQ.</footer>
</main></body></html>`;
}
