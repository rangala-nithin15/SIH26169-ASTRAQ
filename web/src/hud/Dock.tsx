/**
 * Bottom dock: the coarse-alignment chain (the loop, left to right, with live values)
 * and the three readout groups TARGET · CAMERA/GIMBAL · LINK.
 */
import { useEffect, useRef } from 'react';
import { history, historySlice, live, stateColor, useApp } from '../state/store';
import type { Snapshot, TrackState } from '../core/telemetry/types';
import { Icon, Readout, cssVar, fmt, fmtSigned } from './ui';

const ACTIVE: Record<TrackState, number> = {
  IDLE: 0,
  SEARCHING: 0,
  DETECTED: 2,
  ACQUIRING: 5,
  TRACKING: 6,
  LOCKED: 7,
  LOST: 5,
  REACQUIRING: 5,
};

function Arrow({ on }: { on: boolean }) {
  return (
    <div className="chain-arrow">
      <svg width="22" height="12" viewBox="0 0 22 12">
        <path d="M1 6h17" stroke={on ? 'var(--ice)' : 'currentColor'} strokeWidth="1.2" className={on ? 'flow' : ''} fill="none" />
        <path d="M15 2.5 19.5 6 15 9.5" stroke={on ? 'var(--ice)' : 'currentColor'} strokeWidth="1.2" fill="none" />
      </svg>
    </div>
  );
}

function Spark() {
  const ref = useRef<HTMLCanvasElement>(null);
  const lockPx = useApp((s) => s.config.logic.lockPx);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (history.head === last) return;
      last = history.head;
      const c = ref.current;
      if (!c) return;
      const w = (c.width = 180);
      const h = (c.height = 44);
      const ctx = c.getContext('2d')!;
      const { v } = historySlice('errPx', 12);
      const max = 60;
      const y = (e: number) => h - 2 - (Math.log10(1 + Math.min(max, e)) / Math.log10(1 + max)) * (h - 4);
      ctx.strokeStyle = 'rgba(156,245,200,0.35)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y(lockPx));
      ctx.lineTo(w, y(lockPx));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = cssVar('--ser-a');
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < v.length; i++) {
        const x = (i / Math.max(1, v.length - 1)) * w;
        if (!Number.isFinite(v[i])) {
          started = false;
          continue;
        }
        if (!started) ctx.moveTo(x, y(v[i]));
        else ctx.lineTo(x, y(v[i]));
        started = true;
      }
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [lockPx]);
  return <canvas ref={ref} style={{ width: 90, height: 22, display: 'block', marginTop: 2 }} />;
}

export function AlignmentChain({ s }: { s: Snapshot | null }) {
  const n = s ? ACTIVE[s.state] : 0;
  const coasting = s?.state === 'LOST' || s?.state === 'REACQUIRING';
  const d = s?.detection;
  const est = s?.kalman.estPx;
  const cx = (s?.camera.width ?? 640) / 2;
  const cy = (s?.camera.height ?? 480) / 2;
  const ifov = s?.camera.ifovDeg ?? 0.00625;
  const ex = est ? est[0] - cx : d ? d.x - cx : null;
  const ey = est ? est[1] - cy : d ? d.y - cy : null;
  const nodes = [
    { k: 'Initial error', v: fmt(live.initialErrPx, 0, ' px'), s: 'at first detection' },
    { k: 'Detection', v: d ? `${(d.confidence * 100).toFixed(0)} %` : s?.state === 'SEARCHING' ? 'scanning' : '—', s: d ? `(${d.x.toFixed(0)}, ${d.y.toFixed(0)}) px` : 'centroid' },
    { k: 'Error estimate', v: ex !== null && ey !== null ? `${fmtSigned(ex)}, ${fmtSigned(ey)}` : '—', s: ex !== null && ey !== null ? `${(Math.hypot(ex, ey) * ifov).toFixed(3)}° · Kalman` : 'px' },
    { k: 'Pan / tilt command', v: s ? `${fmtSigned(s.gimbal.panCmd, 2)}, ${fmtSigned(s.gimbal.tiltCmd, 2)}` : '—', s: '°/s · PID + feed-forward' },
    { k: 'Gimbal motion', v: s ? `${s.gimbal.pan.toFixed(2)}°, ${s.gimbal.tilt.toFixed(2)}°` : '—', s: 'pan, tilt' },
    { k: 'Pixel error', v: fmt(s?.error.magPx, 1, ' px'), s: '', spark: true },
    {
      k: 'Optical lock',
      v: s?.state === 'LOCKED' ? `LOCKED` : s?.metrics.acquisitionS !== null && s?.metrics.acquisitionS !== undefined ? 'relocking' : '—',
      s: s?.metrics.acquisitionS !== null && s?.metrics.acquisitionS !== undefined ? `first lock ${s.metrics.acquisitionS.toFixed(2)} s` : 'err < 10 px × 6 frames',
    },
  ];
  return (
    <div className="chain glass" aria-label="Coarse alignment chain">
      {nodes.map((node, i) => (
        <div key={node.k} style={{ display: 'contents' }}>
          <div className={`chain-node ${i < n ? 'on' : ''} ${i === n - 1 ? 'hot' : ''}`}>
            <div className="eyebrow">{node.k}</div>
            <div className="v" style={i === 6 && s?.state === 'LOCKED' ? { color: 'var(--lock)' } : coasting && i >= 2 && i <= 4 ? { color: 'var(--warn)' } : undefined}>
              {node.v}
            </div>
            {node.spark ? <Spark /> : <div className="s">{node.s}</div>}
          </div>
          {i < nodes.length - 1 && <Arrow on={i < n - 1} />}
        </div>
      ))}
    </div>
  );
}

/** Field-of-regard map: search field, camera footprint, target, estimate, scan trace. */
function FieldMap({ s }: { s: Snapshot }) {
  const cfg = useApp((st) => st.config.logic);
  const hu = cfg.searchHalfUDeg;
  const hv = cfg.searchHalfVDeg;
  const W = 118;
  const H = 88;
  const sc = Math.min((W - 8) / (2 * hu), (H - 8) / (2 * hv));
  const X = (u: number) => W / 2 + u * sc;
  const Y = (v: number) => H / 2 - v * sc;
  const bu = s.gimbal.boresightU;
  const bv = s.gimbal.boresightV;
  const fw = s.camera.hfovDeg * sc;
  const fh = s.camera.vfovDeg * sc;
  return (
    <svg className="mini" viewBox={`0 0 ${W} ${H}`}>
      <rect style={{ fill: 'rgba(var(--accent-rgb),0.03)', stroke: 'rgba(var(--amber-rgb),0.35)' }} x={X(-hu)} y={Y(hv)} width={2 * hu * sc} height={2 * hv * sc} strokeDasharray="2 3" />
      <line style={{ stroke: 'rgba(var(--line-rgb),0.08)' }} x1={X(0)} y1={Y(-hv)} x2={X(0)} y2={Y(hv)} />
      <line style={{ stroke: 'rgba(var(--line-rgb),0.08)' }} x1={X(-hu)} y1={Y(0)} x2={X(hu)} y2={Y(0)} />
      <rect style={{ fill: 'rgba(var(--accent-rgb),0.1)' }} x={X(bu) - fw / 2} y={Y(bv) - fh / 2} width={fw} height={fh} stroke={stateColor(s.state)} strokeWidth="1" />
      {s.gimbal.goalU !== null && s.gimbal.goalV !== null && <circle cx={X(s.gimbal.goalU)} cy={Y(s.gimbal.goalV)} r="2" fill="none" stroke="var(--amber)" />}
      <circle style={{ fill: 'var(--text-strong)' }} cx={X(s.target.u)} cy={Y(s.target.v)} r="2.6" />
      <circle style={{ stroke: 'rgba(var(--accent-rgb),0.35)' }} cx={X(s.target.u)} cy={Y(s.target.v)} r="5" fill="none" />
    </svg>
  );
}

/** Pan compass + tilt arc with commanded-rate indicators. */
function GimbalDial({ s }: { s: Snapshot }) {
  const pan = (s.gimbal.pan * Math.PI) / 180;
  const tilt = (s.gimbal.tilt * Math.PI) / 180;
  const R = 34;
  const cx = 42;
  const cy = 44;
  const px = cx + R * Math.sin(pan);
  const py = cy - R * Math.cos(pan);
  const tx = 86 + 28 * Math.cos(tilt);
  const ty = 78 - 28 * Math.sin(tilt);
  return (
    <svg className="mini" viewBox="0 0 118 88">
      <circle style={{ stroke: 'rgba(var(--line-rgb),0.2)' }} cx={cx} cy={cy} r={R} fill="none" />
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i * Math.PI) / 6;
        return <line style={{ stroke: 'rgba(var(--line-rgb),0.3)' }} key={i} x1={cx + (R - 4) * Math.sin(a)} y1={cy - (R - 4) * Math.cos(a)} x2={cx + R * Math.sin(a)} y2={cy - R * Math.cos(a)} />;
      })}
      <text x={cx} y={cy - R - 3} fontSize="7" fill="var(--text-3)" textAnchor="middle" fontFamily="var(--f-cond)">
        N
      </text>
      <line x1={cx} y1={cy} x2={px} y2={py} stroke="var(--ice)" strokeWidth="1.6" />
      <circle cx={cx} cy={cy} r="2.5" fill="var(--ice)" />
      <path style={{ stroke: 'rgba(var(--line-rgb),0.2)' }} d="M86 78 A28 28 0 0 1 114 78" transform="rotate(-90 86 78)" fill="none" />
      <line style={{ stroke: 'rgba(var(--line-rgb),0.25)' }} x1="86" y1="78" x2="114" y2="78" />
      <line x1="86" y1="78" x2={tx} y2={ty} stroke="var(--amber-hi)" strokeWidth="1.6" />
      <text x="86" y="87" fontSize="7" fill="var(--text-3)" fontFamily="var(--f-cond)">
        TILT
      </text>
    </svg>
  );
}

/** Alignment Quality Score arc. */
function AqsGauge({ s }: { s: Snapshot }) {
  const v = Math.max(0, Math.min(100, s.metrics.aqs));
  const a0 = Math.PI * 0.8;
  const a1 = Math.PI * 2.2;
  const a = a0 + (a1 - a0) * (v / 100);
  const R = 32;
  const cx = 59;
  const cy = 46;
  const arc = (from: number, to: number) => {
    const x0 = cx + R * Math.cos(from);
    const y0 = cy + R * Math.sin(from);
    const x1 = cx + R * Math.cos(to);
    const y1 = cy + R * Math.sin(to);
    return `M${x0} ${y0} A${R} ${R} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const col = v > 75 ? 'var(--lock)' : v > 45 ? 'var(--ice)' : 'var(--amber)';
  return (
    <svg className="mini" viewBox="0 0 118 88">
      <path style={{ stroke: 'rgba(var(--line-rgb),0.14)' }} d={arc(a0, a1)} strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d={arc(a0, Math.max(a0 + 0.01, a))} stroke={col} strokeWidth="5" fill="none" strokeLinecap="round" />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize="17" fill="var(--text)" fontFamily="var(--f-mono)">
        {v.toFixed(0)}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="7" fill="var(--text-3)" fontFamily="var(--f-cond)" letterSpacing="1.2">
        ALIGNMENT QUALITY
      </text>
    </svg>
  );
}

export function Dock() {
  const s = useApp((st) => st.hud);
  const analysisOpen = useApp((st) => st.analysisOpen);
  const set = useApp((st) => st.set);
  const lockPx = useApp((st) => st.config.logic.lockPx);
  return (
    <div className="dock">
      <AlignmentChain s={s} />
      <div className="panels">
        <section className="panel glass">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h4>Target · remote beacon</h4>
            <div className="grid">
              <Readout label="Azimuth" value={fmt(s?.target.az, 3)} unit="°" />
              <Readout label="Elevation" value={fmt(s?.target.el, 3)} unit="°" />
              <Readout label="Range" value={fmt(s?.target.rangeKm, 1)} unit="km" />
              <Readout label="Angular rate" value={fmt(s?.target.angRateDegS, 3)} unit="°/s" />
              <Readout label="Transverse v" value={fmt(s?.target.transverseKmS, 2)} unit="km/s" />
              <Readout label="In camera FOV" value={s ? (s.target.inFov ? 'yes' : 'no') : '—'} color={s?.target.inFov ? 'var(--lock)' : 'var(--amber)'} />
            </div>
          </div>
          {s && <FieldMap s={s} />}
        </section>
        <section className="panel glass">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h4>Camera · pan/tilt gimbal</h4>
            <div className="grid">
              <Readout label="Pan (az)" value={fmt(s?.gimbal.pan, 3)} unit="°" />
              <Readout label="Tilt (el)" value={fmt(s?.gimbal.tilt, 3)} unit="°" />
              <Readout label="Pan rate" value={fmtSigned(s?.gimbal.panRate, 3)} unit="°/s" />
              <Readout label="Tilt rate" value={fmtSigned(s?.gimbal.tiltRate, 3)} unit="°/s" />
              <Readout label="Pixel error" value={fmt(s?.error.magPx, 1)} unit="px" color={s && (s.error.magPx ?? 99) < lockPx ? 'var(--lock)' : undefined} />
              <Readout label="FOV" value={s ? `${s.camera.hfovDeg.toFixed(2)}×${s.camera.vfovDeg.toFixed(2)}` : '—'} unit="°" />
            </div>
          </div>
          {s && <GimbalDial s={s} />}
        </section>
        <section className="panel glass">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h4>
              Optical link <span className="tag sim">simplified</span>
            </h4>
            <div className="grid">
              <Readout label="Status" value={s ? (s.state === 'LOCKED' ? 'Acquired' : s.state === 'TRACKING' ? 'Tracking' : 'Not acquired') : '—'} color={s ? stateColor(s.state) : undefined} />
              <Readout label="Fine hand-over" value={s ? (s.link.fineHandover ? 'ready' : 'no') : '—'} color={s?.link.fineHandover ? 'var(--lock)' : undefined} />
              <Readout label="Rx power" value={fmt(s?.link.prDbm, 1)} unit="dBm" />
              <Readout label="Link margin" value={fmtSigned(s?.link.marginDb, 1)} unit="dB" color={s && s.link.marginDb < 0 ? 'var(--lost)' : undefined} />
              <Readout label="P(acq ≤ 2 s)" value={s ? `${(s.link.pAcquire2s * 100).toFixed(0)}` : '—'} unit="%" />
              <Readout label="Lock retention" value={fmt(s?.metrics.lockRetentionPct, 1)} unit="%" />
            </div>
          </div>
          {s && <AqsGauge s={s} />}
        </section>
        <section className="panel glass side-actions">
          <button className={`btn ${analysisOpen ? 'primary' : ''}`} onClick={() => set({ analysisOpen: !analysisOpen })} title="Telemetry graphs (A)">
            <Icon name="analysis" size={16} /> Analysis
          </button>
          <button className="btn" onClick={() => useApp.getState().setDrawer('experiment')} title="Record, export, replay, batch">
            <Icon name="experiment" size={16} /> Experiment
          </button>
        </section>
      </div>
    </div>
  );
}
