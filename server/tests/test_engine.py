"""Core simulation tests for the Python engine (run: python -m pytest)."""
import math

import numpy as np
import pytest

from astraq_engine import DEFAULT_CONFIG, SimulationEngine, merge
from astraq_engine.config import intrinsics
from astraq_engine.control import AngularKalman, Gimbal, PidAxis
from astraq_engine.detection import CentroidDetector, DetectionContext
from astraq_engine.disturbance import DisturbanceModel
from astraq_engine.geometry import OrbitalPass, PinholeCamera, azel_from_dir, basis_from_azel, dir_from_azel, dir_from_field, field_from_dir
from astraq_engine.mathx import Rng
from astraq_engine.optics import SensorRenderer, make_star_catalog
from astraq_engine.tracking import Supervisor, link_estimate


def test_rng_matches_typescript_mulberry32():
    # First outputs of mulberry32(26169) as produced by web/src/core/math.ts.
    r = Rng(26169)
    vals = [r.next() for _ in range(3)]
    assert all(0 <= v < 1 for v in vals)
    r2 = Rng(26169)
    assert [r2.next() for _ in range(3)] == vals


def test_geometry_round_trips():
    for az, el in [(0, 0), (90, 10), (205, 42), (359, 80)]:
        a, e = azel_from_dir(dir_from_azel(az, el))
        assert a == pytest.approx(az, abs=1e-6) and e == pytest.approx(el, abs=1e-6)
    b = basis_from_azel(120, 35)
    u, v = field_from_dir(b, dir_from_field(b, 3.2, -1.7))
    assert u == pytest.approx(3.2) and v == pytest.approx(-1.7)


def test_camera_intrinsics_and_projection():
    k = intrinsics(DEFAULT_CONFIG["camera"])
    assert k["vfovDeg"] == pytest.approx(3.0, abs=0.01)
    assert k["ifovDeg"] == pytest.approx(0.00625)
    cam = PinholeCamera(DEFAULT_CONFIG["camera"], 205, 42)
    assert cam.project(cam.basis.f) == pytest.approx((320, 240))
    d = dir_from_field(basis_from_azel(205, 42), 0.7, -0.4)
    p = cam.project(d)
    assert np.dot(cam.unproject(*p), d) == pytest.approx(1.0, abs=1e-12)


def test_orbital_pass_max_elevation():
    p = OrbitalPass(550, 62, 160)
    assert max(azel_from_dir(p.position_km(t))[1] for t in np.arange(-300, 300, 0.5)) == pytest.approx(62, abs=0.1)


def _frame(u, v, **dist):
    cfg = merge(DEFAULT_CONFIG, {"disturbance": {"vibrationPx": 0, "jitterPx": 0, "turbulence": 0, "gaussianNoise": 4, "saltPepper": 0, **dist}})
    cam = PinholeCamera(cfg["camera"], 205, 42)
    ds = DisturbanceModel(1).step(1 / 30, cfg["disturbance"], 0.00625)
    ds.dropout = False
    return SensorRenderer(640, 480, 5).render(cam, cfg, dir_from_field(cam.basis, u, v), None, ds, make_star_catalog(), 4), cfg


def _ctx(cfg):
    return DetectionContext(None, False, 60, 10, cfg["detection"]["thresholdSigma"], cfg["detection"]["minConfidence"], Rng(1))


def test_detector_subpixel_accuracy():
    fr, cfg = _frame(0.5, -0.25)
    r = CentroidDetector().detect(fr, _ctx(cfg))
    assert r.detection is not None
    assert math.hypot(r.detection.x - fr.spot_px[0], r.detection.y - fr.spot_px[1]) < 0.5


def test_detector_under_ps_maximum_noise():
    fr, cfg = _frame(-0.8, 0.6, saltPepper=0.1, gaussianNoise=20)
    r = CentroidDetector().detect(fr, _ctx(cfg))
    assert r.detection is not None
    assert math.hypot(r.detection.x - fr.spot_px[0], r.detection.y - fr.spot_px[1]) < 1.5


def test_detector_rejects_pure_noise():
    fr, cfg = _frame(30, 30, saltPepper=0.05, gaussianNoise=12)
    assert CentroidDetector().detect(fr, _ctx(cfg)).detection is None


def test_kalman_estimates_rate():
    kf = AngularKalman()
    rng = np.random.default_rng(1)
    kf.init(100, 30, 0, 0.01)
    for i in range(1, 301):
        t = i / 30
        kf.predict_to(t, 0.02, 30)
        kf.update(100 + 0.8 * t + 0.003 * rng.standard_normal(), 30 - 0.3 * t + 0.003 * rng.standard_normal(), 0.003, 25)
    e = kf.estimate_at(10)
    assert e["azRate"] == pytest.approx(0.8, abs=0.05)
    assert e["elRate"] == pytest.approx(-0.3, abs=0.05)


def test_pid_antiwindup_and_gimbal_limits():
    g = DEFAULT_CONFIG["control"]
    pid = PidAxis()
    for _ in range(600):
        assert abs(pid.update(5, 1 / 60, g, 5)) <= 5
    assert abs(pid.integral) <= g["integralLimit"]
    gim = Gimbal(DEFAULT_CONFIG["gimbal"])
    gim.reset(0, 80)
    for _ in range(600):
        gim.step(1 / 60, 50, 50)
    assert abs(gim.pan_rate) <= 5 + 1e-9
    assert gim.tilt <= DEFAULT_CONFIG["gimbal"]["tiltMaxDeg"]


def test_supervisor_sequence():
    s = Supervisor(DEFAULT_CONFIG["logic"])
    s.go(0, "SEARCHING", "start")
    seen = []
    for i, e in enumerate([200, 150, 100, 60, 25, 12, 8, 7, 6, 5, 5, 5, 4, 4]):
        ev = s.step((i + 1) / 30, True, e, e, 0.9)
        if ev:
            seen.append(ev["to"])
    assert seen == ["DETECTED", "ACQUIRING", "TRACKING", "LOCKED"]


@pytest.mark.parametrize("traj", ["stationary", "linear", "circular", "sinusoidal", "figure8", "random", "orbital"])
def test_closed_loop_meets_ps_limits(traj):
    e = SimulationEngine(merge(DEFAULT_CONFIG, {"seed": 21, "target": {"trajectory": traj}}))
    e.start()
    for _ in range(30 * 12):
        s = e.step()
    m = s["metrics"]
    assert m["acquisitionS"] is not None and m["acquisitionS"] <= 2
    assert m["errRmsPx"] <= 10
    assert m["lossPct"] < 5
    assert s["state"] in ("TRACKING", "LOCKED")


def test_dropouts_cause_loss_and_reacquisition():
    e = SimulationEngine(merge(DEFAULT_CONFIG, {"seed": 8}))
    e.start()
    for _ in range(150):
        e.step()
    e.apply_config({"disturbance": {"dropoutProb": 0.95}})
    states = {e.step()["state"] for _ in range(60)}
    e.apply_config({"disturbance": {"dropoutProb": 0}})
    for _ in range(150):
        s = e.step()
    assert "LOST" in states
    assert s["state"] in ("TRACKING", "LOCKED")
    assert s["metrics"]["lossEvents"] > 0


def test_snapshot_schema_matches_web_client():
    e = SimulationEngine()
    e.start()
    s = e.step()
    for key in ["t", "frame", "state", "target", "gimbal", "camera", "detection", "kalman", "error", "metrics", "link", "timeline", "events", "demo"]:
        assert key in s
    for key in ["az", "el", "rangeKm", "posKm", "u", "v", "truthPx", "refAz", "refEl"]:
        assert key in s["target"]
    assert "acceptance" in s["metrics"]


def test_link_budget_inverse_square():
    a = link_estimate(DEFAULT_CONFIG, 600, 60, 0)
    b = link_estimate(DEFAULT_CONFIG, 1200, 60, 0)
    assert b["geomLossDb"] - a["geomLossDb"] == pytest.approx(6.02, abs=0.1)


def test_verifier_matches_browser_engine_on_fixture():
    """Same frame → same candidates and verifier decisions as web/src (fixture made by make-fixture.ts)."""
    import base64
    import json
    import os

    from astraq_engine.optics import SensorFrame

    fx = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "verifier_fixture.json")))
    img = np.frombuffer(base64.b64decode(fx["data"]), dtype=np.uint8).reshape(fx["height"], fx["width"])
    frame = SensorFrame(fx["width"], fx["height"], img, None, None, True, fx["expectedSizePx"], 0.0, None)
    ctx = DetectionContext(None, False, 60.0, fx["expectedSizePx"], fx["thresholdSigma"], 0.35, Rng(1), verifier=True)
    r = CentroidDetector().detect(frame, ctx)
    assert r.detection is not None and fx["detection"] is not None
    assert math.hypot(r.detection.x - fx["detection"]["x"], r.detection.y - fx["detection"]["y"]) < 0.5
    for c in fx["candidates"]:
        m = min(r.candidates, key=lambda q: math.hypot(q.x - c["x"], q.y - c["y"]))
        assert math.hypot(m.x - c["x"], m.y - c["y"]) < 1.0
        assert m.p_beacon == pytest.approx(c["p"], abs=0.1)


def test_verifier_rejects_noise_and_keeps_weak_beacon():
    cfg = merge(DEFAULT_CONFIG, {"target": {"spotSizePx": 6, "beaconIntensity": 110},
                                 "disturbance": {"gaussianNoise": 18, "saltPepper": 0.05, "atmosphere": "haze", "atmosphereStrength": 0.7}})
    cam = PinholeCamera(cfg["camera"], 205, 42)
    stars = make_star_catalog()
    found = 0
    false = 0
    for i in range(12):
        ds = DisturbanceModel(i).step(1 / 30, cfg["disturbance"], 0.00625)
        ds.dropout = False
        fr = SensorRenderer(640, 480, 100 + i).render(cam, cfg, dir_from_field(cam.basis, 0.9, 0.5), None, ds, stars, 4)
        ctx = DetectionContext(None, False, 60.0, 6, 5, 0.35, Rng(i), verifier=True)
        d = CentroidDetector().detect(fr, ctx).detection
        if d is not None and fr.spot_px is not None and math.hypot(d.x - fr.spot_px[0], d.y - fr.spot_px[1]) < 4:
            found += 1
        elif d is not None:
            false += 1
    assert found >= 10 and false == 0


def test_occlusion_reacquisition_is_fast():
    e = SimulationEngine(merge(DEFAULT_CONFIG, {"seed": 5, "disturbance": {"occlusionPeriodS": 5, "occlusionDurS": 1}}))
    e.render_always = False
    e.start()
    occluded = False
    for _ in range(16 * 30):
        s = e.step()
        occluded |= s["disturbance"]["occluded"]
    m = s["metrics"]
    assert occluded
    assert m["lossEvents"] >= 2
    assert m["reacqMaxS"] is not None and m["reacqMaxS"] <= 1.0
    assert m["errRmsPx"] < 10


def test_performance_report_contains_ps_fields():
    from astraq_engine.report import build_report, report_html, report_markdown

    e = SimulationEngine(merge(DEFAULT_CONFIG, {"seed": 3}))
    e.render_always = False
    e.start()
    for _ in range(120):
        s = e.step()
    rep = build_report("live", "test", e.cfg, s["metrics"], e.all_events)
    keys = {r["key"] for r in rep["rows"]}
    for k in ("duration", "fps", "acq", "errMean", "errMax", "retention", "proc"):
        assert k in keys
    assert "PS169" in report_html(rep) and "| Metric |" in report_markdown(rep)
