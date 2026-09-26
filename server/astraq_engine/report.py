"""Automatic performance report (mirror of web/src/core/analysis/report.ts).

Produces the PS "Performance Log" — simulation duration, FPS, acquisition time,
average and maximum tracking error, lock retention rate, processing time — plus the
other PS169 metrics, a configuration summary and the state-transition log, as a dict
(JSON), Markdown and a self-contained printable HTML page.
"""
from __future__ import annotations

import html
import math
from datetime import datetime, timezone


def _f(v, d: int, unit: str = "") -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "—"
    return f"{v:.{d}f}" + (f" {unit}" if unit else "")


def _row(key, label, value, unit, digits, limit=None, ok=None, ps=False, judged=False):
    r = {"key": key, "label": label, "value": value, "unit": unit, "digits": digits, "ps": ps}
    if limit is not None:
        r["limit"] = limit
        r["pass"] = ok
    return r


def metric_rows(m: dict) -> list[dict]:
    a = m["acceptance"]
    return [
        _row("duration", "Simulation duration", m["elapsedS"], "s", 1, ps=True),
        _row("frames", "Frames processed", m["frames"], "", 0),
        _row("fps", "Processing speed (engine FPS)", m["fps"] or None, "FPS", 1, "≥ 20", a["fps"], True),
        _row("acq", "Acquisition time (start → first LOCK)", m["acquisitionS"], "s", 2, "≤ 2 s", a["acquisition"], True),
        _row("tdet", "First confirmed detection", m["tDetect"], "s", 2),
        _row("errMean", "Average tracking error", m["errMeanPx"], "px", 2, ps=True),
        _row("errRms", "RMS tracking error", m["errRmsPx"], "px", 2, "≤ 10 px", a["error"], True),
        _row("errP95", "95th-percentile tracking error", m["errP95Px"], "px", 2),
        _row("errMax", "Maximum tracking error", m["errMaxPx"], "px", 2, ps=True),
        _row("retention", "Lock retention rate (after first lock)", m["lockRetentionPct"], "%", 1, ps=True),
        _row("loss", "Target loss (after first lock)", m["lossPct"], "%", 2, "< 5 %", a["loss"], True),
        _row("lossEvents", "Loss events", m["lossEvents"], "", 0),
        _row("reacqMean", "Re-acquisition time, mean", m["reacqMeanS"], "s", 2),
        _row("reacqMax", "Re-acquisition time, worst", m["reacqMaxS"], "s", 2, "≤ 1 s", a["reacq"], True),
        _row("proc", "Processing time per frame, mean", m["procMeanMs"], "ms", 2, ps=True),
        _row("procMax", "Processing time per frame, max", m["procMaxMs"], "ms", 2),
        _row("centroid", "Centroid error vs rendered spot (RMS)", m["centroidRmsPx"], "px", 3),
        _row("false", "False detections accepted", m["falseDetections"], "", 0),
        _row("aqs", "Alignment Quality Score (last 10 s)", m["aqs"], "/100", 0),
    ]


def batch_rows(rows: list[dict]) -> list[dict]:
    def nn(k):
        return [r["metrics"][k] for r in rows if r["metrics"].get(k) is not None]

    def mean(a):
        return sum(a) / len(a) if a else None

    acq, rms, emax, loss, ret, reacq, fps, proc = (nn(k) for k in ("acquisitionS", "errRmsPx", "errMaxPx", "lossPct", "lockRetentionPct", "reacqMaxS", "fps", "procMeanMs"))
    n = len(rows)
    return [
        _row("runs", "Runs", n, "", 0),
        _row("locked", "Runs that reached LOCK", len(acq), f"of {n}", 0),
        _row("acqMean", "Acquisition time, mean", mean(acq), "s", 2),
        _row("acqMax", "Acquisition time, worst", max(acq) if acq else None, "s", 2, "≤ 2 s", (max(acq) <= 2) if acq else None),
        _row("acqPass", "Runs acquiring within 2 s", 100 * sum(1 for x in acq if x <= 2) / n if n else None, "%", 0),
        _row("rmsMean", "RMS tracking error, mean over runs", mean(rms), "px", 2, "≤ 10 px", (mean(rms) <= 10) if rms else None),
        _row("errMax", "Maximum tracking error, worst run", max(emax) if emax else None, "px", 2),
        _row("lossMean", "Target loss, mean", mean(loss), "%", 2, "< 5 %", (mean(loss) < 5) if loss else None),
        _row("retMean", "Lock retention, mean", mean(ret), "%", 1),
        _row("reacqMax", "Re-acquisition, worst", max(reacq) if reacq else None, "s", 2, "≤ 1 s", (max(reacq) <= 1) if reacq else None),
        _row("fps", "Engine capacity (headless), mean", mean(fps), "FPS", 0, "≥ 20", (mean(fps) >= 20) if fps else None),
        _row("proc", "Detection time per frame, mean", mean(proc), "ms", 2),
    ]


def video_rows(v: dict) -> list[dict]:
    return [
        _row("frames", "Frames analysed", v["frames"], "", 0),
        _row("duration", "Video duration", v["frames"] / max(1.0, v["fps"]), "s", 2, ps=True),
        _row("det", "Detection rate", 100 * v["detectionRate"], "%", 1),
        _row("acq", "Acquisition time", v["acquisitionS"], "s", 3, "≤ 2 s", None if v["acquisitionS"] is None else v["acquisitionS"] <= 2, True),
        _row("retention", "Lock retention", v.get("lockRetentionPct"), "%", 1, ps=True),
        _row("loss", "Target loss", v["lossPct"], "%", 2, "< 5 %", None if v["lossPct"] is None else v["lossPct"] < 5, True),
        _row("reacq", "Re-acquisition, worst", v.get("reacqMaxS"), "s", 2, "≤ 1 s", None if v.get("reacqMaxS") is None else v["reacqMaxS"] <= 1),
        _row("rmse", "Centroid RMSE vs ground truth", v.get("centroidRmsePx"), "px", 3, ps=True),
        _row("cmax", "Centroid error, max", v.get("centroidMaxPx"), "px", 3),
        _row("proc", "Processing time per frame, mean", v["procMeanMs"], "ms", 2, ps=True),
        _row("fps", "Processing speed", v["processingFps"], "FPS", 1, "≥ 20", v["processingFps"] >= 20, True),
    ]


def config_summary(c: dict | None) -> list[list[str]]:
    if not c:
        return []
    d, cam, t, g, k, det, lg = c["disturbance"], c["camera"], c["target"], c["gimbal"], c["control"], c["detection"], c["logic"]
    noise = ", ".join(x for x in [f"Gaussian σ {d['gaussianNoise']}" if d["gaussianNoise"] > 0 else "", f"salt & pepper {d['saltPepper'] * 100:.1f} %" if d["saltPepper"] > 0 else "", "Poisson" if d["poisson"] else ""] if x)
    out = [
        ["Scenario", c["scenarioId"]],
        ["Seed", str(c["seed"])],
        ["Camera", f"{cam['width']}×{cam['height']} mono, {cam['hfovDeg']}° HFOV, {cam['frameRateHz']} Hz" + (f", wide-field acquisition {cam['wideHfovDeg']}°" if cam["wideAcquisition"] else "")],
        ["Search field", f"±{lg['searchHalfUDeg']}° × ±{lg['searchHalfVDeg']}°"],
        ["Target", f"{t['trajectory']}, {t['spotShape']} spot {t['spotSizePx']} px, start {t['startMode']}"],
        ["Gimbal", f"max {g['maxRateDegS']} °/s, {g['maxAccelDegS2']} °/s²"],
        ["Control", f"PID Kp {k['kp']} Ki {k['ki']} Kd {k['kd']} at {k['controlRateHz']} Hz, feed-forward {'on' if k['feedForward'] else 'off'}; Kalman {'on' if c['kalman']['enabled'] else 'off'}"],
        ["Detector", f"{det['provider']}{' + learned verifier' if det.get('verifier') else ''}, threshold {det['thresholdSigma']}σ"],
        ["Image noise", noise or "none"],
        ["Atmosphere", f"{d['atmosphere']} (strength {d['atmosphereStrength']}), turbulence {d['turbulence']}"],
        ["Platform", f"jitter ±{d['jitterPx']} px/frame, vibration {d['vibrationPx']} px @ {d['vibrationHz']} Hz, motion {d['platformMotion']} {d['platformMotionPx']} px"],
    ]
    occ = f", {d.get('occlusionDurS', 1)} s outage every {d['occlusionPeriodS']} s" if d.get("occlusionPeriodS", 0) > 0 else ""
    out.append(["Outages", f"{d['dropoutProb'] * 100:.0f} % random dropouts{occ}{', decoy glint' if d['decoy'] else ''}"])
    return out


def build_report(kind: str, source: str, config: dict | None, metrics: dict | None = None, events: list | None = None,
                 batch: list | None = None, video: dict | None = None, title: str | None = None) -> dict:
    names = {"live": "Live run", "recording": "Recorded run", "batch": "Monte-Carlo batch", "video": "Video benchmark (camera bypass)"}
    if video:
        rows = video_rows(video)
    elif batch:
        rows = batch_rows(batch)
    elif metrics:
        rows = metric_rows(metrics)
    else:
        rows = []
    acc = [{"label": r["label"], "limit": r["limit"], "value": _f(r["value"], r["digits"], r["unit"]), "pass": r.get("pass")} for r in rows if "limit" in r]
    rep = {
        "format": "astraq-performance-report",
        "version": 1,
        "kind": kind,
        "title": title or f"ASTRAQ performance report — {names.get(kind, kind)}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "scenario": (config or {}).get("scenarioId"),
        "rows": rows,
        "acceptance": acc,
        "configSummary": config_summary(config),
        "events": [e for e in (events or []) if e.get("kind") == "transition"][-200:],
    }
    if batch:
        rep["batch"] = {"rows": batch, "aggregate": rows}
    if video:
        rep["video"] = video
    return rep


def report_markdown(r: dict) -> str:
    L = [f"# {r['title']}", "", f"Generated {r['generatedAt']} · source: {r['source']}" + (f" · scenario: {r['scenario']}" if r["scenario"] else ""), ""]
    L += ["## Summary", "", "| Metric | Value | PS169 limit | Result |", "|---|---|---|---|"]
    for row in r["rows"]:
        res = "" if "limit" not in row else ("n/a" if row["pass"] is None else ("PASS" if row["pass"] else "FAIL"))
        L.append(f"| {row['label']} | {_f(row['value'], row['digits'], row['unit'])} | {row.get('limit', '')} | {res} |")
    if "batch" in r:
        L += ["", "## Runs", "", "| Seed | End state | Acquisition s | RMS px | Max px | Loss % | Re-acq max s |", "|---|---|---|---|---|---|---|"]
        for b in r["batch"]["rows"]:
            m = b["metrics"]
            L.append(f"| {b['seed']} | {b['finalState']} | {_f(m['acquisitionS'], 2)} | {_f(m['errRmsPx'], 2)} | {_f(m['errMaxPx'], 2)} | {_f(m['lossPct'], 2)} | {_f(m['reacqMaxS'], 2)} |")
    if r["configSummary"]:
        L += ["", "## Configuration", ""] + [f"- **{k}:** {v}" for k, v in r["configSummary"]]
    if r["events"]:
        L += ["", "## State transitions", "", "| t (s) | To | Reason |", "|---|---|---|"]
        L += [f"| {e['t']:.2f} | {e.get('to', '')} | {e['message'].replace('|', '/')} |" for e in r["events"]]
    return "\n".join(L)


PS_CLASS = ' class="ps"'


def report_html(r: dict) -> str:
    e = html.escape

    def badge(row):
        if "limit" not in row:
            return ""
        p = row.get("pass")
        return '<span class="b na">n/a</span>' if p is None else ('<span class="b ok">PASS</span>' if p else '<span class="b bad">FAIL</span>')

    rows = "".join(
        f'<tr{PS_CLASS if row.get("ps") else ""}><td>{e(row["label"])}</td><td class="v">{e(_f(row["value"], row["digits"], row["unit"]))}</td><td>{e(row.get("limit", ""))}</td><td>{badge(row)}</td></tr>'
        for row in r["rows"]
    )
    judged = [a for a in r["acceptance"] if a["pass"] is not None]
    cards = "".join(
        f'<div class="card {"na" if a["pass"] is None else ("ok" if a["pass"] else "bad")}"><div class="k">{e(a["label"])}</div><div class="n">{e(a["value"])}</div><div class="l">limit {e(a["limit"])}</div></div>'
        for a in r["acceptance"]
    )
    cfg = ""
    if r["configSummary"]:
        cfg = '<h2>Configuration</h2><table class="cfg"><tbody>' + "".join(f"<tr><td>{e(k)}</td><td>{e(v)}</td></tr>" for k, v in r["configSummary"]) + "</tbody></table>"
    ev = ""
    if r["events"]:
        ev = "<h2>State transitions</h2><table><thead><tr><th>t (s)</th><th>State</th><th>Reason</th></tr></thead><tbody>" + "".join(
            f'<tr><td class="v">{x["t"]:.2f}</td><td><b>{e(x.get("to", ""))}</b></td><td>{e(x["message"])}</td></tr>' for x in r["events"]
        ) + "</tbody></table>"
    batch = ""
    if "batch" in r:
        batch = "<h2>Runs</h2><table><thead><tr><th>Seed</th><th>End state</th><th>Acquisition</th><th>RMS error</th><th>Max error</th><th>Loss</th><th>Re-acq. worst</th></tr></thead><tbody>" + "".join(
            f'<tr><td>{b["seed"]}</td><td>{e(b["finalState"])}</td><td class="v">{_f(b["metrics"]["acquisitionS"], 2, "s")}</td><td class="v">{_f(b["metrics"]["errRmsPx"], 2, "px")}</td><td class="v">{_f(b["metrics"]["errMaxPx"], 2, "px")}</td><td class="v">{_f(b["metrics"]["lossPct"], 2, "%")}</td><td class="v">{_f(b["metrics"]["reacqMaxS"], 2, "s")}</td></tr>'
            for b in r["batch"]["rows"]
        ) + "</tbody></table>"
    vid = ""
    if "video" in r:
        v = r["video"]
        vid = f'<p class="meta">Video <b>{e(v["fileName"])}</b> · {v["width"]}×{v["height"]} @ {v["fps"]:.1f} fps · ground truth {"provided" if v.get("truthProvided") else "not provided"}</p>'
    style = (
        ":root{--ink:#152231;--mute:#5d6b7a;--line:#dfe5eb;--ok:#127a4c;--bad:#b3261e;--acc:#c62828}*{box-sizing:border-box}"
        "body{margin:0;background:#f4f6f8;color:var(--ink);font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}main{max-width:980px;margin:0 auto;padding:32px 24px 60px}"
        "header{border-bottom:3px solid var(--acc);padding-bottom:14px;margin-bottom:18px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#34465a}"
        ".meta{color:var(--mute);margin:2px 0}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:14px 0}"
        ".card{background:#fff;border:1px solid var(--line);border-left:4px solid var(--mute);border-radius:8px;padding:10px 12px}.card.ok{border-left-color:var(--ok)}.card.bad{border-left-color:var(--bad)}"
        ".card .k{font-size:12px;color:var(--mute)}.card .n{font-size:20px;font-weight:650}.card .l{font-size:11.5px;color:var(--mute)}"
        "table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line)}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}"
        "th{background:#eef2f5;font-size:12px;color:#34465a}td.v{white-space:nowrap}tr.ps td:first-child{font-weight:600}"
        ".b{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:10px}.b.ok{background:#dff3e8;color:var(--ok)}.b.bad{background:#fbe3e1;color:var(--bad)}.b.na{background:#eceff2;color:var(--mute)}"
        ".cfg td:first-child{width:180px;color:var(--mute)}footer{margin-top:28px;color:var(--mute);font-size:12px}@media print{body{background:#fff}main{padding:0}}"
    )
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{e(r["title"])}</title><style>{style}</style></head><body><main>'
        f'<header><h1>{e(r["title"])}</h1><p class="meta">Generated {e(r["generatedAt"])} · source: <b>{e(r["source"])}</b>'
        + (f' · scenario: <b>{e(r["scenario"])}</b>' if r["scenario"] else "")
        + f"</p>{vid}<p>PS169 acceptance: <b>{sum(1 for a in judged if a['pass'])} of {len(judged)}</b> judged criteria passed.</p></header>"
        f'<div class="cards">{cards}</div><h2>Performance summary</h2><table><thead><tr><th>Metric</th><th>Value</th><th>PS169 limit</th><th>Result</th></tr></thead><tbody>{rows}</tbody></table>'
        f"{batch}{cfg}{ev}<footer>Generated automatically by ASTRAQ. Tracking error = angle between the optical axis and the true beacon direction in pixels, "
        "over TRACKING/LOCKED frames after the first lock. Re-acquisition = LOST → TRACKING, clock starting when the beacon is visible again.</footer></main></body></html>"
    )
