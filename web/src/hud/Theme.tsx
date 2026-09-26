/** Theme picker: a small palette popover in the top bar and a section in the View drawer. */
import { THEMES, useApp } from '../state/store';

export function ThemeList() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <div className="theme-list" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} className={`theme-sw ${theme === t.id ? 'on' : ''}`} onClick={() => setTheme(t.id)} role="radio" aria-checked={theme === t.id} title={t.note}>
          <span className="bar">
            {t.swatch.map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </span>
          <b style={{ fontWeight: 600 }}>{t.name}</b>
        </button>
      ))}
    </div>
  );
}

export function ThemePopover() {
  const open = useApp((s) => s.themeOpen);
  const set = useApp((s) => s.set);
  if (!open) return null;
  return (
    <div className="theme-pop glass" onMouseLeave={() => set({ themeOpen: false })}>
      <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>Theme</span>
        <span className="dim">saved on this device</span>
      </div>
      <ThemeList />
      <p className="note" style={{ marginBottom: 0 }}>
        Changes the interface colours only. The 3D scene, the camera image and the laser stay physically coloured.
      </p>
    </div>
  );
}
