/**
 * Analysis sheet: one telemetry graph at a time (last 60 s) + PS169 acceptance card.
 */
import { useEffect, useRef } from 'react';
import { history, historySlice, SeriesKey, useApp } from '../state/store';
import { TRACK_STATES } from '../core/telemetry/types';
import { STATE_HEX } from '../state/store';
import { Icon, Seg, cssVar, fmt } from './ui';

interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  dash?: number[];
}
interface TabDef {
  id: string;
  label: string;
  unit: string;
  series: SeriesDef[];
  threshold?: (lockPx: number, ifov: number) => number | null;
  log?: boolean;
  fixed?: [number, number];
}

const TABS: TabDef[] = [
  {
    id: 'error',
    label: 'Pixel error',
    unit: 'px',
    series: [
      { key: 'errPx', label: 'true pointing error', color: '--ser-a' },
      { key: 'estErrPx', label: 'tracker estimate', color: '--ser-b', dash: [4, 3] },
    ],
    threshold: (l) => l,
    log: true,
  },
  { id: 'ang', label: 'Angular error', unit: '°', series: [{ key: 'angErr', label: 'angle, optical axis → target', color: '--ser-a' }], threshold: (l, ifov) => l * ifov, log: true },
  {
    id: 'rates',
    label: 'Pan / tilt response',
    unit: '°/s',
    series: [
      { key: 'panRate', label: 'pan rate', color: '--ser-a' },
      { key: 'panCmd', label: 'pan command', color: '--ser-a', dash: [3, 3] },
      { key: 'tiltRate', label: 'tilt rate', color: '--ser-c' },
      { key: 'tiltCmd', label: 'tilt command', color: '--ser-c', dash: [3, 3] },
    ],
  },
  { id: 'vel', label: 'Target rate', unit: '°/s', series: [{ key: 'tgtRate', label: 'target angular rate', color: '--ser-d' }] },
  { id: 'conf', label: 'Confidence', unit: '', series: [{ key: 'conf', label: 'detection confidence', color: '--ser-d' }], fixed: [0, 1] },
  { id: 'aqs', label: 'Quality score', unit: '', series: [{ key: 'aqs', label: 'alignment quality score (10 s window)', color: '--ser-e' }], fixed: [0, 100] },
];

function Chart({ tab }: { tab: TabDef }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lockPx = useApp((s) => s.config.logic.lockPx);
  const ifov = useApp((s) => s.hud?.camera.ifovDeg ?? 0.00625);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      if (!c || history.head === last) return;
      last = history.head;
      const rect = c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = (c.width = Math.round(rect.width * dpr));
      const H = (c.height = Math.round(rect.height * dpr));
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, W, H);
      const padL = 44 * dpr;
      const padR = 12 * dpr;
      const padT = 12 * dpr;
      const padB = 34 * dpr;
      const seconds = 60;
      const data = tab.series.map((s) => historySlice(s.key, seconds));
      const st = historySlice('state', seconds);
      if (!st.t.length) return;
      const t1 = st.t[st.t.length - 1];
      const t0 = t1 - seconds;
      let lo = Infinity;
      let hi = -Infinity;
      for (const d of data)
        for (let i = 0; i < d.v.length; i++) {
          const v = d.v[i];
          if (!Number.isFinite(v)) continue;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      const thr = tab.threshold?.(lockPx, ifov) ?? null;
      if (tab.fixed) [lo, hi] = tab.fixed;
      if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
      if (tab.log) {
        lo = Math.max(thr ? thr / 20 : 1e-3, lo > 0 ? lo : 1e-3);
        hi = Math.max(hi, thr ? thr * 4 : lo * 10);
      } else if (!tab.fixed) {
        const m = (hi - lo) * 0.1 || 0.1;
        lo -= m;
        hi += m;
      }
      const X = (t: number) => padL + ((t - t0) / seconds) * (W - padL - padR);
      const Y = (v: number) => {
        const f = tab.log ? (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo);
        return H - padB - f * (H - padT - padB);
      };
      // State band along the bottom.
      for (let i = 0; i < st.t.length; i++) {
        const s = TRACK_STATES[st.v[i]];
        ctx.fillStyle = STATE_HEX[s] + '99';
        const x = X(st.t[i]);
        ctx.fillRect(x, H - padB + 8 * dpr, Math.max(1, (W - padL - padR) / (seconds * 30)) + 0.5, 5 * dpr);
      }
      // Grid.
      ctx.strokeStyle = cssVar('--grid');
      ctx.fillStyle = cssVar('--axis-text');
      ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
      ctx.lineWidth = 1;
      const ticks = tab.log
        ? [0.001, 0.01, 0.1, 1, 10, 100, 1000].filter((v) => v >= lo && v <= hi)
        : Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
      for (const v of ticks) {
        ctx.beginPath();
        ctx.moveTo(padL, Y(v));
        ctx.lineTo(W - padR, Y(v));
        ctx.stroke();
        ctx.fillText(Math.abs(v) >= 100 || v === 0 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(1), 4 * dpr, Y(v) - 6 * dpr);
      }
      for (let s = Math.ceil(t0 / 10) * 10; s <= t1; s += 10) {
        ctx.beginPath();
        ctx.moveTo(X(s), padT);
        ctx.lineTo(X(s), H - padB);
        ctx.stroke();
        ctx.fillText(`${s.toFixed(0)}s`, X(s) + 3 * dpr, H - padB + 16 * dpr);
      }
      if (thr !== null) {
        ctx.strokeStyle = cssVar('--lock');
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(padL, Y(thr));
        ctx.lineTo(W - padR, Y(thr));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = cssVar('--lock');
        ctx.fillText(`lock threshold ${tab.unit === 'px' ? thr.toFixed(0) + ' px' : thr.toFixed(4) + '°'}`, W - padR - 190 * dpr, Y(thr) - 14 * dpr);
      }
      tab.series.forEach((s, k) => {
        const d = data[k];
        ctx.strokeStyle = cssVar(s.color);
        ctx.lineWidth = 1.4 * dpr;
        ctx.setLineDash((s.dash ?? []).map((x) => x * dpr));
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < d.v.length; i++) {
          const v = d.v[i];
          if (!Number.isFinite(v)) {
            pen = false;
            continue;
          }
          const x = X(d.t[i]);
          const y = Math.max(padT, Math.min(H - padB, Y(v)));
          if (!pen) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          pen = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      });
      // Legend.
      let lx = padL + 6 * dpr;
      ctx.font = `${10.5 * dpr}px Barlow, sans-serif`;
      tab.series.forEach((s) => {
        ctx.fillStyle = cssVar(s.color);
        ctx.fillRect(lx, padT + 2 * dpr, 12 * dpr, 2 * dpr);
        ctx.fillStyle = cssVar('--text');
        ctx.fillText(s.label, lx + 16 * dpr, padT + 7 * dpr);
        lx += (ctx.measureText(s.label).width + 34 * dpr);
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tab, lockPx, ifov]);
  return <canvas ref={ref} />;
}

function AccRow({ label, value, ok }: { label: string; value: string; ok: boolean | null }) {
  return (
    <div className="acc-row">
      <span className="muted">{label}</span>
      <span className="mono">{value}</span>
      <span className={ok === null ? 'acc-na' : ok ? 'acc-ok' : 'acc-bad'}>{ok === null ? '·' : ok ? '✓' : '✕'}</span>
    </div>
  );
}

export function Analysis() {
  const open = useApp((s) => s.analysisOpen);
  const tabId = useApp((s) => s.analysisTab);
  const set = useApp((s) => s.set);
  const m = useApp((s) => s.hud?.metrics);
  if (!open) return null;
  const tab = TABS.find((t) => t.id === tabId) ?? TABS[0];
  return (
    <section className="analysis glass">
      <div className="analysis-head">
        <span className="eyebrow">Analysis · last 60 s</span>
        <Seg value={tab.id} options={TABS.map((t) => ({ v: t.id, label: t.label }))} onChange={(v) => set({ analysisTab: v })} />
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => useApp.getState().downloadReport('live', 'html')} title="Automatic performance report for this run (P)">
          <Icon name="report" size={14} /> Report
        </button>
        <button className="btn icon sm ghost" onClick={() => set({ analysisOpen: false })}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="analysis-body">
        <div className="chart">
          <Chart tab={tab} />
        </div>
        <div className="accept">
          <div className="eyebrow">PS169 acceptance · this run</div>
          <AccRow label="Acquisition ≤ 2 s" value={fmt(m?.acquisitionS, 2, ' s')} ok={m?.acceptance.acquisition ?? null} />
          <AccRow label="Tracking error ≤ 10 px (RMS)" value={fmt(m?.errRmsPx, 2, ' px')} ok={m?.acceptance.error ?? null} />
          <AccRow label="Target loss < 5 %" value={fmt(m?.lossPct, 2, ' %')} ok={m?.acceptance.loss ?? null} />
          <AccRow label="Re-acquisition ≤ 1 s (max)" value={fmt(m?.reacqMaxS, 2, ' s')} ok={m?.acceptance.reacq ?? null} />
          <AccRow label="Processing ≥ 20 FPS" value={fmt(m?.fps, 0, ' fps')} ok={m?.acceptance.fps ?? null} />
          <div className="eyebrow" style={{ marginTop: 6 }}>
            Details
          </div>
          <AccRow label="Error mean / p95 / max" value={`${fmt(m?.errMeanPx, 1)} / ${fmt(m?.errP95Px, 1)} / ${fmt(m?.errMaxPx, 0)}`} ok={null} />
          <AccRow label="Centroid RMS vs spot" value={fmt(m?.centroidRmsPx, 2, ' px')} ok={null} />
          <AccRow label="Loss events / false det." value={`${m?.lossEvents ?? 0} / ${m?.falseDetections ?? 0}`} ok={null} />
          <AccRow label="Detect / track at" value={`${fmt(m?.tDetect, 2)} / ${fmt(m?.tTrack, 2)} s`} ok={null} />
          <AccRow label="Lock retention" value={fmt(m?.lockRetentionPct, 1, ' %')} ok={null} />
          <AccRow label="Processing mean / max" value={`${fmt(m?.procMeanMs, 2)} / ${fmt(m?.procMaxMs, 1)} ms`} ok={null} />
          <p className="note">
            Error = true angle between optical axis and beacon, in pixels, over TRACKING/LOCKED frames after first lock. AQS = 100·(0.45·S<sub>err</sub> + 0.25·S<sub>conf</sub> + 0.30·S<sub>lock</sub>), 10 s window.
          </p>
        </div>
      </div>
    </section>
  );
}
