"""
ASTRAQ simulation engine (Python). Same closed loop and same snapshot schema as
web/src/core/engine.ts, so the web UI can run on either engine unchanged.

Per camera frame: servo sub-steps -> world (target, disturbances) -> render sensor
frame from the actual optical axis -> detect -> measurement to az/el with the
capture-time encoder pose -> Kalman -> supervisor -> metrics against truth.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from .config import DEFAULT_CONFIG, clone, intrinsics, merge, sanitize
from .control import AngularKalman, Gimbal, PidAxis, SpiralSearch
from .detection import DetectionContext, SyntheticDetector, create_detector
from .disturbance import DisturbanceModel
from .geometry import Basis, PinholeCamera, azel_from_dir, basis_from_azel, dir_from_azel, dir_from_field, field_from_dir
from .mathx import Rng, angle_between_deg, clamp, wrap_deg

# Time spent following the prediction before the re-acquisition spiral starts, s.
REACQ_DWELL_S = 1.0
from .optics import SensorRenderer, make_star_catalog
from .target import TargetModel
from .tracking import DEMO_DURATION, DEMO_PHASES, RunMetrics, Supervisor, demo_phase_at, link_estimate

_STARS = None


def _stars():
    global _STARS
    if _STARS is None:
        _STARS = make_star_catalog()
    return _STARS


def _f(x: Any) -> Any:
    """JSON-safe float (NaN/inf -> None)."""
    if isinstance(x, float) and not math.isfinite(x):
        return None
    return x


class SimulationEngine:
    RESET_KEYS = ("seed", "scene")

    def __init__(self, cfg: dict | None = None):
        self.cfg = sanitize(cfg or DEFAULT_CONFIG)
        self.stars = _stars()
        self.running = False
        self.mode = "auto"
        self.source = "remote"
        self.render_always = True
        self.config_version = 0
        self.demo_active = False
        self.demo_phase = -1
        self.demo_t0 = 0.0
        self._build()

    # ── lifecycle ───────────────────────────────────────────────
    def _build(self) -> None:
        c = self.cfg
        self.rng = Rng(c["seed"])
        self.target = TargetModel(c, c["seed"])
        self.dist = DisturbanceModel(c["seed"])
        self.renderer = SensorRenderer(c["camera"]["width"], c["camera"]["height"], c["seed"])
        self.detector = create_detector(c["detection"])
        self.kf = AngularKalman()
        self.pid_pan, self.pid_tilt = PidAxis(), PidAxis()
        self.gimbal = Gimbal(c["gimbal"])
        self.sup = Supervisor(c["logic"])
        self.metrics = RunMetrics()
        self.enc = PinholeCamera(c["camera"])
        self.act = PinholeCamera(c["camera"])
        self.reset()

    def reset(self) -> None:
        c = self.cfg
        self.t = 0.0
        self.frame = 0
        self.target.reset()
        self.dist.reset()
        self.kf.reset()
        self.pid_pan.reset()
        self.pid_tilt.reset()
        self.sup.reset()
        self.metrics.reset()
        self.queue: list[dict] = []
        self.events: list[dict] = []
        self.all_events: list[dict] = []
        self.last_meas_dir = None
        self.last_det_dir = None
        self.reacq: SpiralSearch | None = None
        self.reacq_center: Basis | None = None
        self.reacq_t0 = 0.0
        self.search_goal = None
        self.ff = [0.0, 0.0]
        self.timeline = {"search": None, "detect": None, "acquire": None, "track": None, "lock": None}
        self.hfov = c["camera"]["wideHfovDeg"] if c["camera"]["wideAcquisition"] else c["camera"]["hfovDeg"]
        self.truth = self.target.step(0.0, 0.0)
        raz, rel = azel_from_dir(self.truth.ref.f)
        self.gimbal.reset(raz, rel)
        self.manual_goal = [self.gimbal.pan, self.gimbal.tilt]
        self.dstate = self.dist.step(0.0, c["disturbance"], intrinsics(c["camera"])["ifovDeg"])
        self.last_frame = None
        self._build_search()
        if self.running:
            self._start_tracking()

    def _build_search(self) -> None:
        k = intrinsics(self.cfg["camera"], self.hfov)
        lg = self.cfg["logic"]
        self.search = SpiralSearch(lg["searchHalfUDeg"], lg["searchHalfVDeg"], k["hfovDeg"] * 0.85, k["vfovDeg"] * 0.85)

    def _start_tracking(self) -> None:
        if self.sup.state == "IDLE":
            self.events.append(self.sup.go(self.t, "SEARCHING", "run started - scanning the search field"))
            self.timeline["search"] = self.t

    def start(self) -> None:
        self.running = True
        self._start_tracking()

    def pause(self) -> None:
        self.running = False

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        self.manual_goal = [self.gimbal.pan, self.gimbal.tilt]
        self._info("manual pointing - automatic tracking suspended" if mode == "manual" else "automatic tracking resumed")

    def set_manual_goal(self, pan: float, tilt: float) -> None:
        g = self.cfg["gimbal"]
        self.manual_goal = [wrap_deg(pan), clamp(tilt, g["tiltMinDeg"], g["tiltMaxDeg"])]

    def reacquire(self) -> None:
        self.kf.reset()
        self.sup.reset()
        cam = self.cfg["camera"]
        self.hfov = cam["wideHfovDeg"] if cam["wideAcquisition"] else cam["hfovDeg"]
        self._build_search()
        self.events.append(self.sup.go(self.t, "SEARCHING", "operator requested reacquisition"))

    def apply_config(self, patch: dict, silent: bool = False) -> None:
        nxt = sanitize(merge(self.cfg, patch))
        needs_reset = any(k in patch for k in self.RESET_KEYS) or nxt["camera"]["width"] != self.cfg["camera"]["width"] or nxt["camera"]["height"] != self.cfg["camera"]["height"]
        det_changed = nxt["detection"]["provider"] != self.cfg["detection"]["provider"]
        self.cfg = nxt
        self.config_version += 1
        self.gimbal.cfg = nxt["gimbal"]
        self.sup.cfg = nxt["logic"]
        self.enc.cfg = nxt["camera"]
        self.act.cfg = nxt["camera"]
        if det_changed:
            self.detector = create_detector(nxt["detection"])
        elif isinstance(self.detector, SyntheticDetector):
            self.detector.noise_px = nxt["detection"]["syntheticNoisePx"]
            self.detector.miss_prob = nxt["detection"]["syntheticMissProb"]
        if needs_reset:
            self.renderer.resize(nxt["camera"]["width"], nxt["camera"]["height"])
            self.target = TargetModel(nxt, nxt["seed"])
            self.dist = DisturbanceModel(nxt["seed"])
            self.reset()
            if not silent:
                self._info("configuration applied - run restarted")
        else:
            if "target" in patch:
                self.target.set_config(nxt)
            if "logic" in patch or "camera" in patch:
                self._build_search()
            if not silent:
                self._info("configuration applied")

    def set_demo(self, on: bool) -> None:
        if on:
            self.cfg = sanitize(merge(clone(DEFAULT_CONFIG), {"seed": self.cfg["seed"]}))
            self.demo_active = True
            self.config_version += 1
            self.demo_phase = -1
            self.running = True
            self.mode = "auto"
            self._build()
            self.demo_t0 = self.t
            self._start_tracking()
            self._info("demo started")
        else:
            self.demo_active = False
            self._info("demo ended")

    def _info(self, msg: str, kind: str = "info") -> None:
        self.events.append({"t": self.t, "kind": kind, "message": msg})

    # ── estimation / control ────────────────────────────────────
    def _estimate_dir(self, t: float):
        if self.cfg["kalman"]["enabled"]:
            if not self.kf.initialized:
                return None
            e = self.kf.estimate_at(t)
            return dir_from_azel(e["az"], e["el"]), e["azRate"], e["elRate"]
        if self.last_meas_dir is not None:
            return self.last_meas_dir, 0.0, 0.0
        return None

    def _reacq_center_at(self, t: float) -> Basis | None:
        est = self._estimate_dir(t)
        if est is None:
            return None
        az, el = azel_from_dir(est[0])
        return basis_from_azel(az, el)

    def _control(self, ts: float, dt: float) -> tuple[float, float]:
        g = self.gimbal
        if self.mode == "manual":
            return g.rate_toward(*self.manual_goal)
        st = self.sup.state
        self.ff = [0.0, 0.0]
        self.search_goal = None
        if st == "IDLE":
            return 0.0, 0.0
        if st == "SEARCHING" or (st == "DETECTED" and self.last_det_dir is None):
            ref = self.truth.ref
            bf = field_from_dir(ref, dir_from_azel(g.pan, g.tilt)) or (0.0, 0.0)
            k = intrinsics(self.cfg["camera"], self.hfov)
            goal = self.search.update(bf[0], bf[1], min(0.3, k["hfovDeg"] * 0.08), min(0.3, k["vfovDeg"] * 0.08))
            self.search_goal = goal
            az, el = azel_from_dir(dir_from_field(ref, goal[0], goal[1]))
            return g.rate_toward(az, el)
        if st == "DETECTED" and self.last_det_dir is not None:
            return g.rate_toward(*azel_from_dir(self.last_det_dir))
        dwelling = st == "REACQUIRING" and ts - self.reacq_t0 < REACQ_DWELL_S
        if st == "REACQUIRING" and not dwelling and self.reacq is not None and self.reacq_center is not None:
            center = self._reacq_center_at(ts) or self.reacq_center
            bf = field_from_dir(center, dir_from_azel(g.pan, g.tilt)) or (0.0, 0.0)
            k = intrinsics(self.cfg["camera"], self.hfov)
            goal = self.reacq.update(bf[0], bf[1], min(0.3, k["hfovDeg"] * 0.08), min(0.3, k["vfovDeg"] * 0.08))
            gd = dir_from_field(center, goal[0], goal[1])
            gf = field_from_dir(self.truth.ref, gd)
            self.search_goal = list(gf) if gf else None
            return g.rate_toward(*azel_from_dir(gd))
        est = self._estimate_dir(ts)
        if est is None:
            return 0.0, 0.0
        self.enc.set_pose(g.pan, g.tilt)
        e = self.enc.angular_error(est[0])
        if e is None:
            return 0.0, 0.0
        gains = self.cfg["control"]
        lim = self.cfg["gimbal"]["maxRateDegS"]
        cos_t = max(0.2, math.cos(math.radians(g.tilt)))
        ff_pan = est[1] if gains["feedForward"] else 0.0
        ff_tilt = est[2] if gains["feedForward"] else 0.0
        self.ff = [ff_pan, ff_tilt]
        return self.pid_pan.update(e[0] / cos_t, dt, gains, lim, ff_pan), self.pid_tilt.update(e[1], dt, gains, lim, ff_tilt)

    # ── main step ───────────────────────────────────────────────
    def step(self) -> dict:
        c = self.cfg
        fps = c["camera"]["frameRateHz"]
        dtf = 1 / fps
        nsub = max(1, round(c["control"]["controlRateHz"] / fps))
        dts = dtf / nsub
        t_prev = self.t
        for s in range(nsub):
            ts = t_prev + (s + 1) * dts
            cp, ct = self._control(ts, dts) if self.running else (0.0, 0.0)
            wp, wt = (self.dstate.wind_pan, self.dstate.wind_tilt) if self.running else (0.0, 0.0)
            self.gimbal.step(dts, cp, ct, wp, wt)
        self.t = t_prev + dtf
        self.frame += 1

        if self.demo_active:
            td = self.t - self.demo_t0
            idx = demo_phase_at(td)
            if idx != self.demo_phase:
                self.demo_phase = idx
                ph = DEMO_PHASES[idx]
                self.apply_config(ph["patch"], silent=True)
                self._info(f"demo phase {idx + 1}/{len(DEMO_PHASES)}: {ph['title']}")
            if td >= DEMO_DURATION:
                self.demo_active = False
                self._info("demo complete - simulation continues")

        ifov_nom = intrinsics(c["camera"])["ifovDeg"]
        self.truth = self.target.step(dtf, c["disturbance"]["targetNoiseDeg"])
        self.dstate = self.dist.step(dtf, c["disturbance"], ifov_nom)
        ds = self.dstate

        st0 = self.sup.state
        cam = c["camera"]
        want_wide = cam["wideAcquisition"] and st0 in ("SEARCHING", "DETECTED", "REACQUIRING", "IDLE")
        if cam["wideAcquisition"] and st0 == "ACQUIRING":
            e0 = self._estimate_dir(self.t)
            if e0 is not None:
                half_v = intrinsics(cam)["vfovDeg"] / 2
                want_wide = angle_between_deg(dir_from_azel(self.gimbal.pan, self.gimbal.tilt), e0[0]) > 0.5 * half_v
        goal_fov = cam["wideHfovDeg"] if want_wide else cam["hfovDeg"]
        prev_fov = self.hfov
        self.hfov += clamp(goal_fov - self.hfov, -cam["zoomRateDegS"] * dtf, cam["zoomRateDegS"] * dtf)
        if abs(self.hfov - prev_fov) > 1e-9 and self.hfov == goal_fov and st0 in ("SEARCHING", "IDLE"):
            self._build_search()

        g = self.gimbal
        self.act.set_fov(self.hfov)
        self.act.set_pose(g.pan + ds.d_pan, g.tilt + ds.d_tilt)
        self.enc.set_fov(self.hfov)
        self.enc.set_pose(g.pan, g.tilt)
        decoy = None
        if c["disturbance"]["decoy"]:
            decoy = dir_from_field(self.truth.ref, self.truth.u + 1.1 * math.sin(self.t * 0.37) + 0.6, self.truth.v + 0.9 * math.cos(self.t * 0.29) - 0.4)
        frame = None
        if self.detector.needs_image or self.render_always:
            frame = self.renderer.render(self.act, c, self.truth.dir, decoy, ds, self.stars, cam["hfovDeg"])
            self.last_frame = frame
        truth_px = self.act.project(self.truth.dir)
        spot_visible = frame.spot_visible if frame else (self.act.in_frame(truth_px) and not ds.dropout)

        has_track = self.sup.has_track and (self.kf.initialized or not c["kalman"]["enabled"])
        est = self._estimate_dir(self.t)
        pred_px = self.enc.project(est[0]) if has_track and est is not None else None
        kest = self.kf.estimate_at(self.t) if c["kalman"]["enabled"] and self.kf.initialized else None
        sigma_px = max(kest["sigmaAz"], kest["sigmaEl"]) / self.enc.k["ifovDeg"] if kest else 0.0
        lost_time = self.t - self.sup.lost_at if self.sup.lost_at is not None else 0.0
        gate = c["detection"]["gateRadiusPx"] + min(200.0, 3 * sigma_px) + (80 * lost_time if self.sup.state == "REACQUIRING" else 0.0)
        size_scale = cam["hfovDeg"] / self.hfov
        spot_px = frame.spot_px if frame and frame.spot_px else truth_px
        ctx = DetectionContext(
            predicted=pred_px,
            tracking=has_track and pred_px is not None,
            gate_px=gate,
            expected_size_px=c["target"]["spotSizePx"] * size_scale,
            threshold_sigma=c["detection"]["thresholdSigma"],
            min_confidence=c["detection"]["minConfidence"],
            rng=self.rng,
            verifier=bool(c["detection"].get("verifier", False)),
            truth={"px": spot_px, "visible": spot_visible, "transmission": ds.atm.transmission * ds.atm.gain, "noiseSigma": c["disturbance"]["gaussianNoise"]},
        )
        result = self.detector.detect(frame, ctx)
        self.queue.append({"t": self.t, "pan": g.pan, "tilt": g.tilt, "hfov": self.hfov, "result": result, "spot": spot_px})
        cap = self.queue.pop(0) if len(self.queue) > c["detection"]["latencyFrames"] else None

        accepted = False
        meas_err = None
        det = cap["result"].detection if cap else None
        meas_dir = None
        cap_cam = None
        if cap and det is not None:
            cap_cam = PinholeCamera(cam, cap["pan"], cap["tilt"], cap["hfov"])
            meas_dir = cap_cam.unproject(det.x, det.y)
            meas_err = math.hypot(det.x - cap_cam.k["cx"], det.y - cap_cam.k["cy"])
        q = c["kalman"]["processNoise"]
        if self.kf.initialized and cap:
            ref_dir = meas_dir if meas_dir is not None else (est[0] if est is not None else self.truth.ref.f)
            self.kf.predict_to(cap["t"], q, azel_from_dir(ref_dir)[1])
        if meas_dir is not None and cap:
            maz, mel = azel_from_dir(meas_dir)
            r_deg = c["kalman"]["measurementNoisePx"] * intrinsics(cam, cap["hfov"])["ifovDeg"]
            if self.sup.state == "SEARCHING":
                accepted = True
            elif self.sup.state == "DETECTED":
                tol = max(0.15, 3 * c["target"]["spotSizePx"] * ifov_nom + c["target"]["speedDegS"] * 0.2)
                accepted = self.last_det_dir is None or angle_between_deg(self.last_det_dir, meas_dir) < tol
            elif c["kalman"]["enabled"]:
                if not self.kf.initialized:
                    self.kf.init(maz, mel, cap["t"], max(r_deg, 0.01))
                    accepted = True
                else:
                    accepted = self.kf.update(maz, mel, r_deg, c["kalman"]["gate"])
                    if not accepted and self.sup.state in ("LOST", "REACQUIRING"):
                        self.kf.init(maz, mel, cap["t"], max(r_deg, 0.01) * 2, True)
                        accepted = True
            else:
                accepted = True
            if accepted:
                self.last_det_dir = meas_dir
                if self.sup.has_track or self.sup.state == "DETECTED":
                    self.last_meas_dir = meas_dir

        if self.running and self.mode == "auto":
            prev = self.sup.state
            filt_err = None
            if accepted and c["kalman"]["enabled"] and self.kf.initialized and cap:
                e = self.kf.estimate_at(cap["t"])
                cc = cap_cam or PinholeCamera(cam, cap["pan"], cap["tilt"], cap["hfov"])
                p = cc.project(dir_from_azel(e["az"], e["el"]))
                if p is not None:
                    filt_err = math.hypot(p[0] - cc.k["cx"], p[1] - cc.k["cy"])
            ev = self.sup.step(self.t, accepted, meas_err if accepted else None, filt_err, det.confidence if det else 0.0)
            if ev:
                self.events.append(ev)
                self._on_transition(prev, self.sup.state, meas_dir, cap["t"] if cap else self.t)

        k = self.act.k
        point_vec = [truth_px[0] - k["cx"], truth_px[1] - k["cy"]] if truth_px else None
        ang_err = angle_between_deg(self.act.basis.f, self.truth.dir)
        point_err = ang_err / k["ifovDeg"]
        cerr = math.hypot(det.x - cap["spot"][0], det.y - cap["spot"][1]) if det is not None and cap and cap["spot"] else None
        false_det = det is not None and accepted and (cerr is None or cerr > max(15.0, 3 * c["target"]["spotSizePx"] * size_scale))
        if false_det:
            cerr = None
        self.metrics.update(self.t, self.sup.state, point_err, cerr if accepted else None, det.confidence if det else 0.0, result.proc_ms, false_det, not ds.occluded)
        tl = self.timeline
        s = self.sup.state
        for key, name in (("detect", "DETECTED"), ("acquire", "ACQUIRING"), ("track", "TRACKING"), ("lock", "LOCKED")):
            if s == name and tl[key] is None:
                tl[key] = self.t
        return self._snapshot(result, cap, accepted, meas_err, point_vec, point_err, ang_err, pred_px, decoy)

    def _on_transition(self, frm: str, to: str, meas_dir, t_cap: float) -> None:
        c = self.cfg
        if to == "ACQUIRING":
            self.pid_pan.reset()
            self.pid_tilt.reset()
            if c["kalman"]["enabled"] and meas_dir is not None and not self.kf.initialized:
                az, el = azel_from_dir(meas_dir)
                self.kf.init(az, el, t_cap, c["kalman"]["measurementNoisePx"] * intrinsics(c["camera"], self.hfov)["ifovDeg"] * 2)
        if to == "SEARCHING":
            self.kf.reset()
            self.last_meas_dir = None
            self.last_det_dir = None
            self.reacq = None
            self._build_search()
        if to == "REACQUIRING":
            self.reacq_t0 = self.t
            center = self._reacq_center_at(self.t)
            self.reacq_center = center or basis_from_azel(self.gimbal.pan, self.gimbal.tilt)
            cam = c["camera"]
            k = intrinsics(cam, cam["wideHfovDeg"] if cam["wideAcquisition"] else cam["hfovDeg"])
            self.reacq = SpiralSearch(k["hfovDeg"] * 1.5, k["vfovDeg"] * 1.5, k["hfovDeg"] * 0.8, k["vfovDeg"] * 0.8, 2)
        if to == "TRACKING" and frm == "ACQUIRING":
            self.pid_pan.integral = 0.0
            self.pid_tilt.integral = 0.0
        if to == "TRACKING" and frm in ("LOST", "REACQUIRING"):
            self.reacq = None
            self.pid_pan.reset()
            self.pid_tilt.reset()

    def plan_preview(self) -> dict:
        return {"path": self.target.preview_path(self.cfg["target"]["periodS"], 96), "search": self.search.points[:400]}

    def _snapshot(self, result, cap, accepted, meas_err, point_vec, point_err, ang_err, pred_px, decoy) -> dict:
        c = self.cfg
        g = self.gimbal
        tr = self.truth
        k = self.enc.k
        det = cap["result"].detection if cap else None
        ax_az, ax_el = azel_from_dir(self.act.basis.f)
        bf = field_from_dir(tr.ref, self.act.basis.f) or (0.0, 0.0)
        raz, rel = azel_from_dir(tr.ref.f)
        kest = self.kf.estimate_at(self.t) if c["kalman"]["enabled"] and self.kf.initialized else None
        est = self._estimate_dir(self.t)
        est_px = self.enc.project(est[0]) if est is not None else None
        events, self.events = self.events, []
        self.all_events = (self.all_events + events)[-500:]
        spot = self.last_frame.spot_px if self.last_frame else None
        in_fov = self.act.in_frame(spot) if self.last_frame else self.act.in_frame(self.act.project(tr.dir))
        di = self.demo_phase if self.demo_phase >= 0 else 0
        snap = {
            "t": self.t,
            "frame": self.frame,
            "state": self.sup.state,
            "stateSince": self.sup.since,
            "mode": self.mode,
            "running": self.running,
            "source": self.source,
            "target": {
                "az": tr.az,
                "el": tr.el,
                "rangeKm": tr.range_km,
                "posKm": [float(x) for x in tr.pos_km],
                "u": tr.u,
                "v": tr.v,
                "angRateDegS": tr.ang_rate,
                "transverseKmS": tr.transverse,
                "inFov": bool(in_fov),
                "truthPx": list(self.act.project(tr.dir)) if self.act.project(tr.dir) else None,
                "decoyPx": list(self.act.project(decoy)) if decoy is not None and self.act.project(decoy) else None,
                "refAz": raz,
                "refEl": rel,
            },
            "gimbal": {
                "pan": g.pan,
                "tilt": g.tilt,
                "panRate": g.pan_rate,
                "tiltRate": g.tilt_rate,
                "panCmd": g.pan_cmd,
                "tiltCmd": g.tilt_cmd,
                "atLimit": g.at_limit,
                "axisAz": ax_az,
                "axisEl": ax_el,
                "boresightU": bf[0],
                "boresightV": bf[1],
                "goalU": self.search_goal[0] if self.search_goal else None,
                "goalV": self.search_goal[1] if self.search_goal else None,
            },
            "camera": {"width": c["camera"]["width"], "height": c["camera"]["height"], "hfovDeg": k["hfovDeg"], "vfovDeg": k["vfovDeg"], "ifovDeg": k["ifovDeg"], "focalMm": k["focalMm"], "fx": k["fx"]},
            "detection": (
                {"valid": True, "x": det.x, "y": det.y, "bbox": list(det.bbox), "confidence": det.confidence, "snr": det.snr, "area": det.area, "candidates": cap["result"].n_candidates, "accepted": accepted}
                if det is not None
                else None
            ),
            "candidates": [{"x": q.x, "y": q.y, "confidence": q.confidence} for q in (cap["result"].candidates if cap else [])],
            "procMs": result.proc_ms,
            "roi": list(result.roi) if result.roi else None,
            "kalman": {
                "enabled": c["kalman"]["enabled"],
                "initialized": self.kf.initialized,
                "measPx": [det.x, det.y] if det is not None else None,
                "estPx": list(est_px) if est_px else None,
                "predPx": list(pred_px) if pred_px else None,
                "sigmaPx": [kest["sigmaAz"] / k["ifovDeg"], kest["sigmaEl"] / k["ifovDeg"]] if kest else [0, 0],
                "azRate": kest["azRate"] if kest else 0.0,
                "elRate": kest["elRate"] if kest else 0.0,
                "innovationPx": self.kf.last_innov / k["ifovDeg"],
            },
            "error": {
                "px": point_vec,
                "magPx": point_err,
                "angDeg": ang_err,
                "estMagPx": math.hypot(est_px[0] - k["cx"], est_px[1] - k["cy"]) if est_px else meas_err,
            },
            "control": {
                "p": [self.pid_pan.last_p, self.pid_tilt.last_p],
                "i": [self.pid_pan.last_i, self.pid_tilt.last_i],
                "d": [self.pid_pan.last_d, self.pid_tilt.last_d],
                "ff": list(self.ff),
            },
            "disturbance": {"dPanDeg": self.dstate.d_pan, "dTiltDeg": self.dstate.d_tilt, "transmission": self.dstate.atm.transmission, "scint": self.dstate.scint, "dropout": self.dstate.dropout, "occluded": self.dstate.occluded},
            "metrics": self.metrics.summary(self.t, c["logic"]["lockPx"]),
            "link": link_estimate(c, tr.range_km, tr.el, ang_err),
            "timeline": dict(self.timeline),
            "events": events,
            "demo": (
                {"active": True, "phase": di, "phases": len(DEMO_PHASES), "title": DEMO_PHASES[di]["title"], "caption": DEMO_PHASES[di]["caption"], "progress": min(1.0, (self.t - self.demo_t0) / DEMO_DURATION)}
                if self.demo_active
                else None
            ),
        }
        if self.frame % 15 == 1:
            snap["plan"] = self.plan_preview()
        return snap


def json_safe(o: Any) -> Any:
    if isinstance(o, dict):
        return {k: json_safe(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [json_safe(v) for v in o]
    if isinstance(o, (np.floating,)):
        o = float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return _f(o)
