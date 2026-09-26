"""
ASTRAQ simulation configuration (Python mirror of web/src/core/config.ts).

Configs are plain nested dicts with exactly the same keys as the TypeScript
`SimConfig`, so the web client can send its config to this engine unchanged.
"""
from __future__ import annotations

import copy
import math
from typing import Any

DEFAULT_CONFIG: dict[str, Any] = {
    "scenarioId": "open-sky",
    "seed": 26169,
    "target": {
        "trajectory": "circular",
        "speedDegS": 0.6,
        "amplitudeDeg": 1.6,
        "periodS": 16,
        "headingDeg": 30,
        "startMode": "random",
        "startUDeg": 2.5,
        "startVDeg": 1.5,
        "waypoints": [[-2, -1], [1.5, -2], [2.5, 1.5], [-1, 2.2]],
        "spotSizePx": 10,
        "spotShape": "square",
        "beaconIntensity": 230,
        "rangeKm": 780,
    },
    "camera": {
        "width": 640,
        "height": 480,
        "hfovDeg": 4,
        "wideAcquisition": True,
        "wideHfovDeg": 12,
        "zoomRateDegS": 10,
        "frameRateHz": 30,
        "pixelPitchUm": 5,
    },
    "gimbal": {
        "maxRateDegS": 5,
        "maxAccelDegS2": 30,
        "rateLagS": 0.04,
        "panMinDeg": -180,
        "panMaxDeg": 180,
        "tiltMinDeg": -5,
        "tiltMaxDeg": 88,
    },
    "control": {
        "kp": 8.0,
        "ki": 1.0,
        "kd": 0.05,
        "integralLimit": 0.05,
        "integralZone": 0.1,
        "derivativeFilterS": 0.05,
        "feedForward": True,
        "controlRateHz": 60,
    },
    "kalman": {"enabled": True, "processNoise": 2, "measurementNoisePx": 1.5, "gate": 25},
    "detection": {
        "provider": "centroid",
        "thresholdSigma": 5,
        "minConfidence": 0.35,
        "gateRadiusPx": 60,
        "latencyFrames": 0,
        "syntheticNoisePx": 0.8,
        "syntheticMissProb": 0.01,
        "verifier": True,
    },
    "disturbance": {
        "vibrationPx": 1.5,
        "vibrationHz": 6,
        "jitterPx": 1,
        "platformMotion": "none",
        "platformMotionPx": 0,
        "windDegS": 0.05,
        "targetNoiseDeg": 0.01,
        "gaussianNoise": 6,
        "saltPepper": 0.002,
        "poisson": True,
        "atmosphere": "clear",
        "atmosphereStrength": 0.3,
        "turbulence": 0.2,
        "dropoutProb": 0,
        "occlusionPeriodS": 0,
        "occlusionDurS": 1,
        "decoy": False,
    },
    "scene": {
        "siteName": "Bengaluru ground terminal",
        "siteLatDeg": 13.03,
        "siteLonDeg": 77.51,
        "losAzDeg": 205,
        "losElDeg": 42,
        "sunAzDeg": 290,
        "sunElDeg": -6,
        "remote": "leo",
        "altitudeKm": 550,
        "ephemerisErrorS": 2.5,
        "passMaxElDeg": 62,
        "passHeadingDeg": 160,
    },
    "link": {
        "txPowerMw": 500,
        "divergenceUrad": 150,
        "rxApertureCm": 20,
        "wavelengthNm": 1550,
        "systemLossDb": 3,
        "rxSensitivityDbm": -45,
        "fineCaptureMrad": 1.0,
    },
    "logic": {
        "lockPx": 10,
        "unlockPx": 15,
        "lockFrames": 6,
        "acquirePx": 30,
        "confirmM": 2,
        "confirmN": 3,
        "coastFrames": 5,
        "lostHoldS": 0.25,
        "reacquireTimeoutS": 3,
        "searchHalfUDeg": 6.25,
        "searchHalfVDeg": 6.25,
    },
}


def clone(c: dict) -> dict:
    return copy.deepcopy(c)


def merge(base: dict, patch: dict | None) -> dict:
    """Deep-merge `patch` into a copy of `base` (lists are replaced)."""
    out = copy.deepcopy(base)
    if not patch:
        return out
    for k, v in patch.items():
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def intrinsics(cam: dict, hfov: float | None = None) -> dict:
    h = cam["hfovDeg"] if hfov is None else hfov
    fx = cam["width"] / 2 / math.tan(math.radians(h) / 2)
    vfov = math.degrees(2 * math.atan(cam["height"] / 2 / fx))
    return {
        "fx": fx,
        "fy": fx,
        "cx": cam["width"] / 2,
        "cy": cam["height"] / 2,
        "hfovDeg": h,
        "vfovDeg": vfov,
        "ifovDeg": h / cam["width"],
        "focalMm": fx * cam["pixelPitchUm"] / 1000,
    }


def _lim(v: Any, lo: float, hi: float, d: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return d
    if not math.isfinite(f):
        return d
    return min(hi, max(lo, f))


def sanitize(c: dict) -> dict:
    """Clamp user-supplied values into safe ranges (same rules as the web client)."""
    s = merge(DEFAULT_CONFIG, c)
    cam, t, d = s["camera"], s["target"], s["disturbance"]
    cam["width"] = int(round(_lim(cam["width"], 160, 1280, 640)))
    cam["height"] = int(round(_lim(cam["height"], 120, 960, 480)))
    cam["hfovDeg"] = _lim(cam["hfovDeg"], 0.5, 30, 4)
    cam["wideHfovDeg"] = _lim(cam["wideHfovDeg"], cam["hfovDeg"], 40, 12)
    cam["frameRateHz"] = _lim(cam["frameRateHz"], 10, 60, 30)
    t["spotSizePx"] = _lim(t["spotSizePx"], 2, 40, 10)
    t["amplitudeDeg"] = _lim(t["amplitudeDeg"], 0, 6, 1.6)
    t["periodS"] = _lim(t["periodS"], 2, 120, 16)
    t["speedDegS"] = _lim(t["speedDegS"], 0, 5, 0.6)
    s["gimbal"]["maxRateDegS"] = _lim(s["gimbal"]["maxRateDegS"], 0.5, 30, 5)
    d["gaussianNoise"] = _lim(d["gaussianNoise"], 0, 40, 6)
    d["saltPepper"] = _lim(d["saltPepper"], 0, 0.2, 0)
    d["jitterPx"] = _lim(d["jitterPx"], 0, 30, 0)
    d["vibrationPx"] = _lim(d["vibrationPx"], 0, 30, 0)
    d["atmosphereStrength"] = _lim(d["atmosphereStrength"], 0, 1, 0.3)
    d["turbulence"] = _lim(d["turbulence"], 0, 1, 0)
    d["dropoutProb"] = _lim(d["dropoutProb"], 0, 0.95, 0)
    d["occlusionPeriodS"] = _lim(d.get("occlusionPeriodS", 0), 0, 120, 0)
    d["occlusionDurS"] = _lim(d.get("occlusionDurS", 1), 0.1, 10, 1)
    s["detection"]["latencyFrames"] = int(round(_lim(s["detection"]["latencyFrames"], 0, 10, 0)))
    s["control"]["controlRateHz"] = _lim(s["control"]["controlRateHz"], 10, 240, 60)
    return s


# Scenario presets (mirror of web/src/core/presets.ts)
PRESETS: list[dict] = [
    {"id": "open-sky", "name": "Open Sky", "summary": "Clear night sky, LEO remote terminal on a circular residual motion.", "patch": {}},
    {
        "id": "ps-baseline",
        "name": "PS169 Baseline",
        "summary": "Problem-statement defaults: 4x3 deg FOV only, square 10 px beacon, random start, 5 deg/s gimbal.",
        "patch": {"camera": {"wideAcquisition": False}, "target": {"trajectory": "linear", "speedDegS": 0.5}},
    },
    {
        "id": "moving-platform",
        "name": "Moving Platform",
        "summary": "Terminal on a vehicle: platform motion, 8 Hz vibration and wind torque.",
        "patch": {
            "target": {"trajectory": "figure8", "amplitudeDeg": 1.5, "periodS": 14},
            "disturbance": {"platformMotion": "circular", "platformMotionPx": 12, "vibrationPx": 4, "vibrationHz": 8, "windDegS": 0.25, "jitterPx": 3},
        },
    },
    {
        "id": "high-jitter",
        "name": "High Jitter",
        "summary": "Camera jitter at the PS maximum (+-20 px/frame).",
        "patch": {"disturbance": {"jitterPx": 20, "vibrationPx": 6, "vibrationHz": 12}},
    },
    {
        "id": "weak-beacon",
        "name": "Weak Beacon",
        "summary": "Haze, dim 6 px beacon, strong turbulence, heavy noise.",
        "patch": {
            "target": {"spotSizePx": 6, "beaconIntensity": 120, "trajectory": "sinusoidal"},
            "disturbance": {"atmosphere": "haze", "atmosphereStrength": 0.7, "turbulence": 0.6, "gaussianNoise": 18, "saltPepper": 0.03},
        },
    },
    {
        "id": "fast-target",
        "name": "Fast Target",
        "summary": "Random manoeuvring target at 1.5 deg/s with a 10 deg/s gimbal.",
        "patch": {"target": {"trajectory": "random", "speedDegS": 1.5}, "gimbal": {"maxRateDegS": 10, "maxAccelDegS2": 60}},
    },
    {
        "id": "acquisition-challenge",
        "name": "Acquisition Challenge",
        "summary": "Beacon in a field corner, rain, 30% dropouts, decoy glint.",
        "patch": {
            "target": {"startMode": "fixed", "startUDeg": 5.6, "startVDeg": -5.4, "trajectory": "stationary"},
            "disturbance": {"atmosphere": "rain", "atmosphereStrength": 0.6, "dropoutProb": 0.3, "decoy": True},
        },
    },
    {
        "id": "occlusion",
        "name": "Occlusion & Reacquisition",
        "summary": "A passing cloud hides the beacon for 1 s every 6 s on a circular path. Measures re-acquisition time.",
        "patch": {"target": {"trajectory": "circular", "amplitudeDeg": 1.4, "periodS": 14}, "disturbance": {"occlusionPeriodS": 6, "occlusionDurS": 1}},
    },
    {
        "id": "leo-pass",
        "name": "LEO Pass",
        "summary": "Real circular-orbit pass (550 km, 62 deg max elevation) with 2.5 s ephemeris timing error.",
        "patch": {"target": {"trajectory": "orbital"}},
    },
]


def preset_config(pid: str, seed: int | None = None) -> dict:
    p = next((x for x in PRESETS if x["id"] == pid), PRESETS[0])
    c = merge(DEFAULT_CONFIG, p["patch"])
    c["scenarioId"] = p["id"]
    if seed is not None:
        c["seed"] = int(seed)
    return c
