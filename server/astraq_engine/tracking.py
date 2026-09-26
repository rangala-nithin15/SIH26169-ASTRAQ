"""Supervisor state machine, metrics, link estimates and demo script (mirror of the TS modules)."""
from __future__ import annotations

import math

import numpy as np

from .config import intrinsics
from .disturbance import atmosphere_effect
from .mathx import norm_cdf

STATES = ["IDLE", "SEARCHING", "DETECTED", "ACQUIRING", "TRACKING", "LOCKED", "LOST", "REACQUIRING"]


class Supervisor:
    """Acquisition & tracking state machine. Transitions use observable data only and
    record their cause."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.reset()

    def reset(self) -> None:
        self.state = "IDLE"
        self.since = 0.0
        self.misses = 0
        self.window: list[bool] = []
        self.lock_count = 0
        self.unlock_count = 0
        self.lost_at: float | None = None

    @property
    def tracking(self) -> bool:
        return self.state in ("ACQUIRING", "TRACKING", "LOCKED")

    @property
    def has_track(self) -> bool:
        return self.tracking or self.state in ("LOST", "REACQUIRING")

    def go(self, t: float, to: str, msg: str) -> dict:
        ev = {"t": t, "kind": "transition", "from": self.state, "to": to, "message": msg}
        self.state = to
        self.since = t
        self.lock_count = self.unlock_count = 0
        if to == "DETECTED":
            self.window = []
        if to == "LOST":
            self.lost_at = t
        if to == "SEARCHING":
            self.lost_at = None
        return ev

    def step(self, t: float, detected: bool, meas_err: float | None, filt_err: float | None, conf: float) -> dict | None:
        c = self.cfg
        self.misses = 0 if detected else self.misses + 1
        err = meas_err if meas_err is not None else math.inf
        lock_err = filt_err if filt_err is not None else err
        s = self.state
        if s == "SEARCHING":
            if detected:
                return self.go(t, "DETECTED", f"candidate at {err:.0f} px from centre, confidence {conf * 100:.0f} %")
        elif s == "DETECTED":
            self.window.append(detected)
            hits = sum(self.window) + 1
            if hits >= c["confirmM"]:
                return self.go(t, "ACQUIRING", f"confirmed {hits} of {len(self.window) + 1} frames - track initialised")
            if len(self.window) + 1 >= c["confirmN"]:
                return self.go(t, "SEARCHING", f"not confirmed ({hits} of {c['confirmN']} frames) - rejected as noise")
        elif s == "ACQUIRING":
            if self.misses > c["coastFrames"]:
                return self.go(t, "LOST", f"{self.misses} consecutive misses while acquiring")
            if detected and err < c["acquirePx"]:
                return self.go(t, "TRACKING", f"measured error {err:.1f} px < {c['acquirePx']} px")
        elif s == "TRACKING":
            if self.misses > c["coastFrames"]:
                return self.go(t, "LOST", f"{self.misses} consecutive misses (coast limit {c['coastFrames']})")
            if detected and lock_err < c["lockPx"]:
                self.lock_count += 1
            elif detected:
                self.lock_count = 0
            if self.lock_count >= c["lockFrames"]:
                return self.go(t, "LOCKED", f"error < {c['lockPx']} px for {c['lockFrames']} frames")
        elif s == "LOCKED":
            if self.misses > c["coastFrames"]:
                return self.go(t, "LOST", f"{self.misses} consecutive misses (coast limit {c['coastFrames']})")
            if detected and lock_err > c["unlockPx"]:
                self.unlock_count += 1
            elif detected:
                self.unlock_count = 0
            if self.unlock_count >= 3:
                return self.go(t, "TRACKING", f"error > {c['unlockPx']} px for 3 frames")
        elif s == "LOST":
            if detected:
                return self.go(t, "TRACKING", f"reacquired after {t - (self.lost_at or t):.2f} s (coasting on prediction)")
            if t - self.since >= c["lostHoldS"]:
                return self.go(t, "REACQUIRING", f"no return after {c['lostHoldS']:.2f} s - local search around prediction")
        elif s == "REACQUIRING":
            if detected:
                return self.go(t, "TRACKING", f"reacquired after {t - (self.lost_at or t):.2f} s")
            if t - (self.lost_at if self.lost_at is not None else self.since) >= c["reacquireTimeoutS"]:
                return self.go(t, "SEARCHING", f"reacquisition timeout {c['reacquireTimeoutS']} s - global search")
        return None


class RunMetrics:
    def __init__(self) -> None:
        self.reset()
        self.fps = 0.0

    def reset(self) -> None:
        self.frames = 0
        self.t_detect = self.t_track = self.t_lock = None
        self.errs: list[float] = []
        self.cerrs: list[float] = []
        self.after_lock = self.loss_after_lock = self.locked_after_lock = 0
        self.loss_events = 0
        self.false_det = 0
        self.reacq: list[float] = []
        self.lost_at: float | None = None
        self.proc_sum = 0.0
        self.proc_max = 0.0
        self.recent: list[tuple[float, str, float | None, float]] = []

    def update(self, t: float, state: str, point_err: float | None, cerr: float | None, conf: float, proc_ms: float, false_det: bool, beacon_visible: bool = True) -> None:
        self.frames += 1
        if state == "DETECTED" and self.t_detect is None:
            self.t_detect = t
        active = state in ("TRACKING", "LOCKED")
        if active and self.t_track is None:
            self.t_track = t
        if state == "LOCKED" and self.t_lock is None:
            self.t_lock = t
        if active and point_err is not None and (self.t_lock is not None or state == "LOCKED"):
            self.errs.append(point_err)
        if cerr is not None:
            self.cerrs.append(cerr)
        if false_det:
            self.false_det += 1
        # Loss / retention over beacon-visible frames (a scheduled outage is not a tracker failure).
        if self.t_lock is not None and beacon_visible:
            self.after_lock += 1
            if not active:
                self.loss_after_lock += 1
            if state == "LOCKED":
                self.locked_after_lock += 1
        if state == "LOST" and self.lost_at is None:
            self.lost_at = t
            self.loss_events += 1
        if self.lost_at is not None and not beacon_visible:
            self.lost_at = t
        if active and self.lost_at is not None:
            self.reacq.append(t - self.lost_at)
            self.lost_at = None
        if state == "SEARCHING":
            self.lost_at = None
        self.proc_sum += proc_ms
        self.proc_max = max(self.proc_max, proc_ms)
        self.recent.append((t, state, point_err, conf))
        while self.recent and t - self.recent[0][0] > 10:
            self.recent.pop(0)

    def aqs(self, lock_px: float) -> float:
        r = self.recent
        if not r:
            return 0.0
        e = [p for (_, s, p, _) in r if p is not None and s in ("TRACKING", "LOCKED")]
        rms = math.sqrt(sum(x * x for x in e) / len(e)) if e else math.inf
        s_err = max(0.0, 1 - rms / (2 * lock_px)) if math.isfinite(rms) else 0.0
        conf = sum(c for (*_, c) in r) / len(r)
        locked = sum(1 for (_, s, _, _) in r if s == "LOCKED") / len(r)
        return 100 * (0.45 * s_err + 0.25 * conf + 0.3 * locked)

    def summary(self, elapsed: float, lock_px: float) -> dict:
        e = self.errs
        rms = math.sqrt(sum(x * x for x in e) / len(e)) if e else None
        loss = 100 * self.loss_after_lock / self.after_lock if self.after_lock else None
        reacq_max = max(self.reacq) if self.reacq else None
        return {
            "elapsedS": elapsed,
            "frames": self.frames,
            "tDetect": self.t_detect,
            "tTrack": self.t_track,
            "acquisitionS": self.t_lock,
            "errMeanPx": sum(e) / len(e) if e else None,
            "errRmsPx": rms,
            "errMaxPx": max(e) if e else None,
            "errP95Px": float(np.percentile(e[-4000:], 95)) if e else None,
            "centroidRmsPx": math.sqrt(sum(x * x for x in self.cerrs) / len(self.cerrs)) if self.cerrs else None,
            "falseDetections": self.false_det,
            "lossPct": loss,
            "lossEvents": self.loss_events,
            "reacqMeanS": sum(self.reacq) / len(self.reacq) if self.reacq else None,
            "reacqMaxS": reacq_max,
            "lockRetentionPct": 100 * self.locked_after_lock / self.after_lock if self.after_lock else None,
            "procMeanMs": self.proc_sum / self.frames if self.frames else 0.0,
            "procMaxMs": self.proc_max,
            "fps": self.fps,
            "aqs": self.aqs(lock_px),
            "acceptance": {
                "acquisition": None if self.t_lock is None else self.t_lock <= 2,
                "error": None if rms is None else rms <= 10,
                "loss": None if loss is None else loss < 5,
                "reacq": None if reacq_max is None else reacq_max <= 1,
                "fps": (self.fps >= 20) if self.fps > 0 else None,
            },
        }


def acquisition_probability(cfg: dict, T: float = 2.0) -> dict:
    cam = cfg["camera"]
    k = intrinsics(cam, cam["wideHfovDeg"] if cam["wideAcquisition"] else cam["hfovDeg"])
    a_fov = k["hfovDeg"] * k["vfovDeg"]
    a_field = 4 * cfg["logic"]["searchHalfUDeg"] * cfg["logic"]["searchHalfVDeg"]
    p_view0 = min(1.0, a_fov / a_field)
    a_cov = a_fov + cfg["gimbal"]["maxRateDegS"] * k["vfovDeg"] * T
    d = cfg["disturbance"]
    atm = atmosphere_effect(d["atmosphere"], d["atmosphereStrength"])
    signal = cfg["target"]["beaconIntensity"] * atm.transmission * atm.gain
    noise = max(0.5, math.sqrt(d["gaussianNoise"] ** 2 + (0.45 * (12 + atm.airlight) if d["poisson"] else 0)) / 3)
    snr = signal / noise
    p_det = norm_cdf(snr - 2.4 * cfg["detection"]["thresholdSigma"]) * (1 - min(0.98, d["dropoutProb"] + atm.extra_dropout))
    n = max(1, round(cam["frameRateHz"] * 0.4))
    p_acq = min(1.0, a_cov / a_field) * (1 - (1 - p_det) ** n)
    return {"pView0": p_view0, "pDet": p_det, "pAcq": p_acq, "snr": snr}


def link_estimate(cfg: dict, range_km: float, el: float, err_deg: float) -> dict:
    L = cfg["link"]
    R = range_km * 1000
    w = R * L["divergenceUrad"] * 1e-6 / 2
    a = L["rxApertureCm"] / 200
    eta = 1 - math.exp(-2 * a * a / (w * w))
    geom = -10 * math.log10(max(1e-30, eta))
    atm = atmosphere_effect(cfg["disturbance"]["atmosphere"], cfg["disturbance"]["atmosphereStrength"])
    airmass = min(10.0, 1 / max(0.1, math.sin(math.radians(max(1.0, el)))))
    atm_db = atm.attenuation_db * airmass
    fine = math.degrees(L["fineCaptureMrad"] * 1e-3)
    point = min(60.0, 10 / math.log(10) * 2 * (err_deg / fine) ** 2)
    pr = 10 * math.log10(L["txPowerMw"]) - geom - atm_db - L["systemLossDb"] - point
    acq = acquisition_probability(cfg)
    return {
        "rangeKm": range_km,
        "geomLossDb": geom,
        "atmLossDb": atm_db,
        "pointingLossDb": point,
        "prDbm": pr,
        "marginDb": pr - L["rxSensitivityDbm"],
        "fineHandover": err_deg <= fine,
        "pAcquire2s": acq["pAcq"],
        "pInitialInView": acq["pView0"],
        "pDetectFrame": acq["pDet"],
    }


_CLEAR = {"disturbance": {"atmosphere": "clear", "atmosphereStrength": 0.2, "gaussianNoise": 6, "saltPepper": 0.002, "dropoutProb": 0, "turbulence": 0.2}}
DEMO_PHASES = [
    {"start": 0, "end": 10, "title": "Acquisition - stationary beacon", "caption": "Beacon starts at a random point of the search field; wide-field scan, detection, zoom to 4 deg and lock.", "patch": {**_CLEAR, "target": {"trajectory": "stationary"}}},
    {"start": 10, "end": 25, "title": "Linear target motion", "caption": "Straight-line drift at 0.8 deg/s; Kalman velocity feeds the PID as rate feed-forward.", "patch": {"target": {"trajectory": "linear", "speedDegS": 0.8, "headingDeg": 25}}},
    {"start": 25, "end": 45, "title": "Circular target motion", "caption": "Continuous turning motion kept inside the 10 px lock circle.", "patch": {"target": {"trajectory": "circular", "amplitudeDeg": 1.8, "periodS": 12, "headingDeg": 0}}},
    {"start": 45, "end": 60, "title": "Sinusoidal target motion", "caption": "Higher-frequency cross-track component tests the loop bandwidth.", "patch": {"target": {"trajectory": "sinusoidal", "amplitudeDeg": 2.0, "periodS": 14, "headingDeg": 10}}},
    {"start": 60, "end": 70, "title": "Detection degradation", "caption": "Fog, heavy noise and 60 % dropouts: coast, LOST, local search.", "patch": {"disturbance": {"atmosphere": "fog", "atmosphereStrength": 0.8, "gaussianNoise": 14, "saltPepper": 0.04, "dropoutProb": 0.6, "turbulence": 0.5}}},
    {"start": 70, "end": 90, "title": "Recovery & reacquisition", "caption": "Conditions clear; reacquisition from the prediction and LOCKED on a figure-8.", "patch": {**_CLEAR, "target": {"trajectory": "figure8", "amplitudeDeg": 1.6, "periodS": 16, "headingDeg": 0}}},
]
DEMO_DURATION = DEMO_PHASES[-1]["end"]


def demo_phase_at(t: float) -> int:
    for i in range(len(DEMO_PHASES) - 1, -1, -1):
        if t >= DEMO_PHASES[i]["start"]:
            return i
    return 0
