"""
Video benchmark path (PS "Benchmark-2"): bypass the simulated pan/tilt camera and
feed a recorded video (.mp4 at ~30 fps, noise + moving beacon spot) straight into
the coarse-pointing pipeline:

    frame -> grayscale -> CentroidDetector -> pixel-space Kalman filter
          -> pointing error vs image centre (px and deg) -> track state -> log

Outputs a per-frame centroid log (CSV) and a summary. If a ground-truth CSV
(frame,x,y) is supplied, centroiding error statistics (RMSE, max) are computed.
"""
from __future__ import annotations

import csv
import io
import math
import time
from dataclasses import dataclass

import numpy as np

from .control import _Axis
from .detection import CentroidDetector, DetectionContext
from .mathx import Rng
from .optics import SensorFrame

try:
    import cv2

    HAVE_CV2 = True
except Exception:  # pragma: no cover
    HAVE_CV2 = False


class PixelKalman:
    """Constant-velocity Kalman filter in image pixels (used when there is no gimbal)."""

    def __init__(self, q: float = 400.0, r: float = 1.5, gate_px: float = 40.0):
        self.x, self.y = _Axis(), _Axis()
        self.q, self.r, self.gate_px = q, r, gate_px
        self.ok = False

    def step(self, dt: float, meas: tuple[float, float] | None, gate: float = 25.0) -> bool:
        if not self.ok:
            if meas is None:
                return False
            self.x.init(meas[0], 25, 400 * self.q / 400)
            self.y.init(meas[1], 25, 400 * self.q / 400)
            self.ok = True
            return True
        self.x.predict(dt, self.q)
        self.y.predict(dt, self.q)
        if meas is None:
            return False
        nx, ny = meas[0] - self.x.x, meas[1] - self.y.x
        nis = nx * nx / (self.x.p00 + self.r**2) + ny * ny / (self.y.p00 + self.r**2)
        if nis > gate and math.hypot(nx, ny) > self.gate_px:
            return False
        self.x.update(nx, self.r**2)
        self.y.update(ny, self.r**2)
        return True


@dataclass
class VideoParams:
    hfov_deg: float = 4.0
    # 0 = estimate from the first confident detections
    spot_size_px: float = 0.0
    threshold_sigma: float = 5.0
    min_confidence: float = 0.35
    coast_frames: int = 5
    confirm_frames: int = 2
    verifier: bool = True


LOG_COLUMNS = ["frame", "t_s", "state", "detected", "x_px", "y_px", "confidence", "kf_x_px", "kf_y_px", "err_x_px", "err_y_px", "err_px", "err_deg", "proc_ms", "truth_x_px", "truth_y_px", "centroid_err_px"]


def analyze_frames(frames, fps: float, params: VideoParams, truth: dict[int, tuple[float, float]] | None = None) -> dict:
    """Run the pipeline over an iterable of 2-D uint8 frames."""
    det = CentroidDetector()
    kf = None
    rng = Rng(1)
    rows = []
    state = "SEARCHING"
    misses = hits = 0
    t_acq = None
    lost_at = None
    reacq: list[float] = []
    losses = 0
    proc = []
    cerrs = []
    dt = 1 / fps
    W = H = 0
    spot = params.spot_size_px if params.spot_size_px > 0 else 10.0
    size_samples: list[float] = []
    for i, img in enumerate(frames):
        H, W = img.shape
        if kf is None:
            # Motion model scaled to the frame: a full-screen video moves many more pixels per second.
            sc = max(1.0, W / 640)
            kf = PixelKalman(q=400 * sc * sc, gate_px=40 * sc)
            gate_roi = 60 * sc
        t = i * dt
        t0 = time.perf_counter()
        pred = (kf.x.x + kf.x.v * dt, kf.y.x + kf.y.v * dt) if kf.ok else None
        estimating = params.spot_size_px <= 0 and len(size_samples) < 5
        ctx = DetectionContext(pred, kf.ok and state != "SEARCHING", gate_roi, spot, params.threshold_sigma, 0.0 if estimating else params.min_confidence, rng,
                               verifier=params.verifier and not estimating)
        frame = SensorFrame(W, H, img, None, None, False, spot, 0.0, None)
        r = det.detect(frame, ctx)
        d = r.detection
        if estimating:
            # Strongest compact blob by integrated signal (impulse noise is 1-2 px and is skipped).
            big = [c for c in r.candidates if c.area >= 9]
            best = max(big, key=lambda c: c.snr * math.sqrt(c.area), default=None)
            if best is not None and best.snr > 12:
                size_samples.append(math.sqrt(best.area))
                spot = max(3.0, min(40.0, sorted(size_samples)[len(size_samples) // 2] - 1))
            d = None
        accepted = kf.step(dt, (d.x, d.y) if d else None)
        if accepted:
            misses = 0
            hits += 1
        else:
            misses += 1
        if state == "SEARCHING" and hits >= params.confirm_frames:
            state = "TRACKING"
            if t_acq is None:
                t_acq = t
            if lost_at is not None:
                reacq.append(t - lost_at)
                lost_at = None
        elif state == "TRACKING" and misses > params.coast_frames:
            state = "SEARCHING"
            hits = 0
            losses += 1
            lost_at = t
            kf.ok = False
        elif state == "SEARCHING" and misses > 0:
            hits = 0
        proc_ms = (time.perf_counter() - t0) * 1000
        proc.append(proc_ms)
        ifov = params.hfov_deg / W
        kx, ky = (kf.x.x, kf.y.x) if kf.ok else (None, None)
        ex = (kx - W / 2) if kx is not None else None
        ey = (ky - H / 2) if ky is not None else None
        e = math.hypot(ex, ey) if ex is not None else None
        tx = ty = ce = None
        if truth and i in truth:
            tx, ty = truth[i]
            if d is not None:
                ce = math.hypot(d.x - tx, d.y - ty)
                cerrs.append(ce)
        rows.append([i, round(t, 4), state, int(d is not None), _r(d.x if d else None), _r(d.y if d else None), _r(d.confidence if d else None, 3), _r(kx), _r(ky), _r(ex), _r(ey), _r(e), _r(e * ifov if e is not None else None, 5), round(proc_ms, 3), _r(tx), _r(ty), _r(ce, 3)])
    n = len(rows)
    detected = sum(1 for r in rows if r[3])
    tracked = sum(1 for r in rows if r[2] == "TRACKING")
    after = [r for r in rows if t_acq is not None and r[1] >= t_acq]
    loss_pct = 100 * sum(1 for r in after if r[2] != "TRACKING") / len(after) if after else None
    retention = 100 * sum(1 for r in after if r[2] == "TRACKING") / len(after) if after else None
    summary = {
        "frames": n,
        "width": W,
        "height": H,
        "videoFps": fps,
        "processingFps": 1000 / (sum(proc) / n) if n and sum(proc) > 0 else None,
        "procMeanMs": sum(proc) / n if n else None,
        "detectionRatePct": 100 * detected / n if n else None,
        "trackingPct": 100 * tracked / n if n else None,
        "acquisitionS": t_acq,
        "lossEvents": losses,
        "lossPct": loss_pct,
        "reacqMaxS": max(reacq) if reacq else None,
        "lockRetentionPct": retention,
        "spotSizePx": spot,
        "centroidRmsePx": math.sqrt(sum(c * c for c in cerrs) / len(cerrs)) if cerrs else None,
        "centroidMaxPx": max(cerrs) if cerrs else None,
        "truthProvided": bool(truth),
    }
    return {"summary": summary, "rows": rows}


def _r(v, d: int = 2):
    return None if v is None else round(float(v), d)


def rows_to_csv(rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(LOG_COLUMNS)
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
    return buf.getvalue()


def parse_truth_csv(text: str) -> dict[int, tuple[float, float]]:
    out: dict[int, tuple[float, float]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            out[int(row["frame"])] = (float(row["x"]), float(row["y"]))
        except (KeyError, ValueError):
            continue
    return out


def analyze_video_file(path: str, params: VideoParams, truth: dict | None = None, max_frames: int = 20000) -> dict:
    if not HAVE_CV2:
        raise RuntimeError("opencv-python-headless is required for video input (pip install opencv-python-headless)")
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError("Could not open video (unsupported format or corrupt file)")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    def gen():
        n = 0
        while n < max_frames:
            ok, fr = cap.read()
            if not ok:
                break
            n += 1
            yield cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY) if fr.ndim == 3 else fr

    try:
        return analyze_frames(gen(), fps, params, truth)
    finally:
        cap.release()


def synthesize_video(path: str, seconds: float = 6.0, fps: int = 30, size=(640, 480), seed: int = 3, noise: float = 8.0,
                     spot: int = 10, salt_pepper: float = 0.0, outage: tuple[float, float] | None = None) -> str:
    """Write a test MP4 (noise + moving square beacon on a Lissajous path over the whole
    frame) and return the ground-truth CSV text (frame,x,y). `outage` = (start_s, dur_s)
    hides the beacon (re-acquisition test). Used by tests and scripts/make_test_video.py."""
    if not HAVE_CV2:
        raise RuntimeError("opencv-python-headless is required")
    W, H = size
    rng = np.random.default_rng(seed)
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H), isColor=False)
    lines = ["frame,x,y"]
    n = int(seconds * fps)
    for i in range(n):
        t = i / fps
        x = W / 2 + 0.33 * W * math.sin(2 * math.pi * t / 5.0)
        y = H / 2 + 0.3 * H * math.sin(2 * math.pi * t / 3.3 + 0.7)
        img = np.full((H, W), 14.0, np.float32)
        h = spot / 2
        x0, y0 = int(round(x - h)), int(round(y - h))
        hidden = outage is not None and outage[0] <= t < outage[0] + outage[1]
        if not hidden:
            img[max(0, y0) : y0 + spot, max(0, x0) : x0 + spot] += 220
        img += rng.normal(0, noise, (H, W))
        if salt_pepper > 0:
            m = rng.random((H, W))
            img[m < salt_pepper / 2] = 0
            img[m > 1 - salt_pepper / 2] = 255
        vw.write(np.clip(img, 0, 255).astype(np.uint8))
        # Pixel-centre convention: a block covering columns x0..x0+spot-1 has centroid x0+spot/2.
        if not hidden:
            lines.append(f"{i},{x0 + h:.2f},{y0 + h:.2f}")
    vw.release()
    return "\n".join(lines) + "\n"
