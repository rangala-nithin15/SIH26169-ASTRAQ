/** Small UI primitives and formatting helpers for the HUD. */
import type { ReactNode } from 'react';

export const fmt = (v: number | null | undefined, d = 2, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`;
export const fmtSigned = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
export const fmtClock = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  digits?: number;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 0.01, unit = '', digits = 2, onChange } = props;
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div className="field">
      <label>{label}</label>
      <span className="val">
        {value.toFixed(digits)}
        {unit}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--p' as string]: `${p}%` }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Toggle({ label, on, onChange, hint }: { label: ReactNode; on: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} title={hint}>
      <span>{label}</span>
      <span className="sw" />
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <div className="eyebrow">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Readout({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div className="ro">
      <div className="eyebrow">{label}</div>
      <div className="v" style={color ? { color } : undefined}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

/** Line icons drawn for ASTRAQ (24 px grid, 1.5 px stroke). */
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<string, ReactNode> = {
    scenario: (
      <>
        <circle cx="12" cy="12" r="8.5" {...p} />
        <path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17" {...p} />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="3" {...p} />
        <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" {...p} />
        <path d="M5 19c3-6 8-3 14-12" {...p} strokeDasharray="2 2.5" />
      </>
    ),
    disturbance: <path d="M2.5 12c2-5 3.5-5 5 0s3 5 4.5 0 3-5 4.5 0 3 5 5 0" {...p} />,
    tracking: (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2" {...p} />
        <path d="M9 12h6M12 9v6" {...p} />
        <path d="M6.5 8.5h2M15.5 15.5h2" {...p} />
      </>
    ),
    experiment: (
      <>
        <path d="M9 3.5v6l-5 9a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2l-5-9v-6" {...p} />
        <path d="M8 3.5h8M7 15h10" {...p} />
      </>
    ),
    optics: (
      <>
        <path d="M3 12h4M17 12h4" {...p} />
        <path d="M7 6.5v11M17 9v6" {...p} />
        <path d="M7 6.5 17 9M7 17.5 17 15" {...p} />
      </>
    ),
    view: (
      <>
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" {...p} />
        <circle cx="12" cy="12" r="3" {...p} />
      </>
    ),
    measure: (
      <>
        <path d="M4 20 20 4" {...p} />
        <path d="m7 17-2-2M10 14l-1.5-1.5M13 11l-2-2M16 8l-1.5-1.5" {...p} />
      </>
    ),
    analysis: <path d="M3.5 19.5h17M5 16l4-5 4 3 6-8" {...p} />,
    help: (
      <>
        <circle cx="12" cy="12" r="8.5" {...p} />
        <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.6v.2" {...p} />
      </>
    ),
    play: <path d="M8 5.5v13l10-6.5z" {...p} />,
    pause: <path d="M8.5 5.5v13M15.5 5.5v13" {...p} />,
    reset: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4" {...p} />,
    expand: <path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6" {...p} />,
    close: <path d="M6 6l12 12M18 6 6 18" {...p} />,
    download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14" {...p} />,
    upload: <path d="M12 15.5v-11m0 0-4 4m4-4 4 4M5 19.5h14" {...p} />,
    crosshair: (
      <>
        <circle cx="12" cy="12" r="7" {...p} />
        <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" {...p} />
      </>
    ),
    palette: (
      <>
        <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.5-1.8-.3-1 .3-2.2 1.6-2.2h2a3.4 3.4 0 0 0 3.4-3.4C20.5 7.3 16.7 3.5 12 3.5Z" {...p} />
        <circle cx="7.5" cy="11" r="1.1" {...p} />
        <circle cx="10.5" cy="7.3" r="1.1" {...p} />
        <circle cx="15" cy="7.8" r="1.1" {...p} />
      </>
    ),
    film: (
      <>
        <rect x="3.5" y="5" width="17" height="14" rx="2" {...p} />
        <path d="M3.5 9h17M3.5 15h17M7.5 5v4M12 5v4M16.5 5v4M7.5 15v4M12 15v4M16.5 15v4" {...p} />
      </>
    ),
    report: (
      <>
        <path d="M6 3.5h8l4 4v13H6z" {...p} />
        <path d="M14 3.5v4h4M9 12h6M9 15.5h6M9 8.5h2" {...p} />
      </>
    ),
    screen: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" {...p} />
        <rect x="8" y="9" width="7" height="5.5" {...p} />
        <circle cx="16.5" cy="7" r="1" {...p} />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" {...p} />,
    minus: <path d="M5 12h14" {...p} />,
    hand: <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12m0-6.5V5a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.5L4 14.3a1.5 1.5 0 0 1 2.3-1.9L8 14" {...p} />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {paths[name] ?? null}
    </svg>
  );
}

export function BrandMark() {
  // Aperture diamond with a beam passing through its centre.
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="aqg" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#4f9fc7" />
          <stop offset="1" stopColor="#dff5ff" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 29.5 16 16 29.5 2.5 16Z" fill="none" stroke="url(#aqg)" strokeWidth="1.4" />
      <path style={{ fill: 'rgba(var(--accent-rgb),0.12)', stroke: 'rgba(var(--accent-rgb),0.55)' }} d="M16 8.5 23.5 16 16 23.5 8.5 16Z" strokeWidth="1" />
      <path d="M4 28 28 4" stroke="#ffb547" strokeWidth="1.3" strokeLinecap="round" />
      <circle style={{ fill: 'var(--text-strong)' }} cx="16" cy="16" r="2.2" />
    </svg>
  );
}

/** Resolve a CSS custom property of the active theme (e.g. '--ser-a'); plain colours pass through. */
const varCache = new Map<string, string>();
let varTheme = '';
export function cssVar(name: string): string {
  if (!name.startsWith('--')) return name;
  const theme = document.documentElement.dataset.theme ?? '';
  if (theme !== varTheme) {
    varCache.clear();
    varTheme = theme;
  }
  let v = varCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#8fdcff';
    varCache.set(name, v);
  }
  return v;
}
