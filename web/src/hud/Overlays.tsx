/** Measurement readout and the "what am I looking at" help overlay. */
import { useApp, live } from '../state/store';
import { azElFromDir, basisFromAzEl } from '../core/geometry';
import { Icon } from './ui';

const len = (p: number[]) => Math.hypot(p[0], p[1], p[2]);

export function MeasurePanel() {
  const measure = useApp((s) => s.measure);
  const set = useApp((s) => s.set);
  const drawer = useApp((s) => s.drawer);
  useApp((s) => s.tick);
  if (!measure.enabled) return null;
  const axis = live.snap ? basisFromAzEl(live.snap.gimbal.axisAz, live.snap.gimbal.axisEl).f : null;
  const describe = (p: [number, number, number]) => {
    const r = len(p);
    if (r < 1e-6) return { r: 0, az: null, el: null, off: null };
    const d: [number, number, number] = [p[0] / r, p[1] / r, p[2] / r];
    const ae = azElFromDir(d);
    const off = axis ? (Math.acos(Math.max(-1, Math.min(1, d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]))) * 180) / Math.PI : null;
    return { r, az: ae.az, el: ae.el, off };
  };
  const [a, b] = measure.picks;
  return (
    <section className="measure glass" style={drawer ? { left: 410 } : undefined}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow">3D measurement</span>
        <button className="btn icon sm ghost" onClick={() => set({ measure: { enabled: false, picks: [] } })}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {!a && <p className="note">Click the terminal, the spacecraft, the Moon or any point on the Earth. Click a second object to measure the separation between them.</p>}
      {measure.picks.map((p) => {
        const d = describe(p.pos);
        return (
          <dl className="kv" key={p.id} style={{ marginTop: 8 }}>
            <dt style={{ color: 'var(--text)' }}>{p.name}</dt>
            <dd />
            <dt>Range from terminal</dt>
            <dd>{d.r < 1 ? `${(d.r * 1000).toFixed(1)} m` : `${d.r.toLocaleString(undefined, { maximumFractionDigits: 1 })} km`}</dd>
            {d.az !== null && (
              <>
                <dt>Azimuth / elevation</dt>
                <dd>
                  {d.az.toFixed(2)}° / {d.el!.toFixed(2)}°
                </dd>
                <dt>Off optical axis</dt>
                <dd>{d.off !== null ? `${d.off.toFixed(3)}°` : '—'}</dd>
              </>
            )}
            <dt>ENU position</dt>
            <dd>
              {p.pos.map((x) => x.toFixed(x > 100 ? 0 : 2)).join(', ')} km
            </dd>
          </dl>
        );
      })}
      {a && b && (() => {
        const dist = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
        const ra = len(a.pos);
        const rb = len(b.pos);
        const sep = ra > 1e-6 && rb > 1e-6 ? (Math.acos(Math.max(-1, Math.min(1, (a.pos[0] * b.pos[0] + a.pos[1] * b.pos[1] + a.pos[2] * b.pos[2]) / (ra * rb)))) * 180) / Math.PI : null;
        return (
          <dl className="kv" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
            <dt style={{ color: 'var(--ice)' }}>Separation</dt>
            <dd />
            <dt>Distance</dt>
            <dd>{dist < 1 ? `${(dist * 1000).toFixed(1)} m` : `${dist.toLocaleString(undefined, { maximumFractionDigits: 1 })} km`}</dd>
            <dt>Angle seen from terminal</dt>
            <dd>{sep !== null ? `${sep.toFixed(3)}°` : '—'}</dd>
          </dl>
        );
      })()}
      <p className="note">True geometry (km). Models are drawn enlarged; measurements use their real positions.</p>
    </section>
  );
}

export function Help() {
  const open = useApp((s) => s.helpOpen);
  const set = useApp((s) => s.set);
  if (!open) return null;
  return (
    <div className="help" onClick={() => set({ helpOpen: false })}>
      <div className="help-card glass" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>ASTRAQ</h2>
            <div className="muted">Autonomous Spatial Tracking &amp; Alignment for Optical Links — coarse pointing of a mobile free-space optical terminal.</div>
          </div>
          <button className="btn icon ghost" onClick={() => set({ helpOpen: false })}>
            <Icon name="close" />
          </button>
        </div>
        <div className="help-grid">
          <div>
            <h5>What you are looking at</h5>
            <ol>
              <li>A <b>mobile ground terminal</b> carries a telescope camera on a pan/tilt gimbal.</li>
              <li>A <b>remote terminal</b> (here a LEO spacecraft) shines an <b>optical beacon</b> toward it.</li>
              <li>The <b>camera</b> images the sky; the frame at top right is exactly what it records.</li>
              <li>The <b>detector</b> finds the beacon spot and measures its pixel offset from the image centre.</li>
              <li>A <b>Kalman filter</b> estimates where the beacon is going; a <b>PID</b> commands pan and tilt rates.</li>
              <li>When the error stays under 10 px the terminal is <b>LOCKED</b> — coarse alignment is done and a fine-pointing stage could take over the <b>optical link</b>.</li>
            </ol>
          </div>
          <div>
            <h5>Legend</h5>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              <li>
                <span className="legend-sw" style={{ background: 'var(--amber)' }} />
                Searching / acquiring · search field · scan path
              </li>
              <li>
                <span className="legend-sw" style={{ background: 'var(--ice)' }} />
                Tracking · camera FOV frustum · beacon trajectory
              </li>
              <li>
                <span className="legend-sw" style={{ background: 'var(--lock)' }} />
                Locked · optical link (pulses = data)
              </li>
              <li>
                <span className="legend-sw" style={{ background: 'var(--lost)' }} />
                Lost — coasting on the Kalman prediction
              </li>
              <li>
                <span className="legend-sw" style={{ background: 'var(--amber-hi)' }} />
                Kalman estimate (diamond) and its 3σ ellipse
              </li>
            </ul>
            <p style={{ marginTop: 8 }}>Distances and directions are true (km). The terminal and spacecraft are enlarged when far away, the Moon is ×3 and the beacon cone is widened for visibility.</p>
          </div>
          <div>
            <h5>What is real and what is not</h5>
            <ul>
              <li>Real: camera projection, rendered sensor image, image detector, Kalman filter, PID, gimbal limits, state machine, disturbances, metrics, recording, video benchmark.</li>
              <li>AI: a trained neural network (learned beacon verifier) scores every detected blob; switch it off in Tracking to compare.</li>
              <li>Simplified: link budget, acquisition probability, atmosphere model.</li>
              <li>Synthetic detector = a statistical model (clearly labelled).</li>
              <li>YOLO detection and hardware cameras are <b>planned</b>, not implemented.</li>
            </ul>
          </div>
          <div>
            <h5>Keyboard</h5>
            <ul>
              <li>
                <span className="mono">Space</span> run / pause · <span className="mono">R</span> reset · <span className="mono">D</span> demo
              </li>
              <li>
                <span className="mono">1–5</span> views · <span className="mono">S</span> sensor · <span className="mono">A</span> analysis · <span className="mono">M</span> manual mode
              </li>
              <li>
                <span className="mono">←↑→↓</span> jog the gimbal in manual mode (Shift ×10) · <span className="mono">?</span> this help
              </li>
              <li>
                <span className="mono">+ / −</span> zoom (the mouse wheel zooms towards the cursor) · <span className="mono">G</span> 2000² screen view
              </li>
              <li>
                <span className="mono">V</span> video benchmark · <span className="mono">P</span> performance report · <span className="mono">T</span> theme
              </li>
              <li>
                <span className="mono">F</span> fly to the other spacecraft (ISS → SAT-2 → SAT-3) · <span className="mono">1</span> back to overview
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
