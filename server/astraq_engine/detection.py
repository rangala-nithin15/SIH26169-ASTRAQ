"""
Detection providers (mirror of web/src/core/detection/*).

`DetectionProvider` is the extension point: implement `detect(frame, ctx)` and
register it in `create_detector`. A YOLO provider is NOT implemented — see
`YoloDetectionProvider` below, which raises a clear error instead of pretending.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

try:  # OpenCV is optional; used only for fast connected-component labelling.
    import cv2

    HAVE_CV2 = True
except Exception:  # pragma: no cover
    HAVE_CV2 = False

from .optics import SensorFrame
from .verifier import VERIFIER, candidate_features, verifier_probability


@dataclass
class Candidate:
    x: float
    y: float
    bbox: tuple[int, int, int, int]
    area: int
    peak: float
    snr: float
    size_score: float
    confidence: float
    features: list[float] | None = None
    p_beacon: float | None = None


@dataclass
class DetectionContext:
    predicted: tuple[float, float] | None
    tracking: bool
    gate_px: float
    expected_size_px: float
    threshold_sigma: float
    min_confidence: float
    rng: object
    truth: dict | None = None
    verifier: bool = False


@dataclass
class DetectionResult:
    detection: Candidate | None
    candidates: list[Candidate] = field(default_factory=list)
    proc_ms: float = 0.0
    roi: tuple[int, int, int, int] | None = None
    n_candidates: int = 0


class DetectionProvider(Protocol):
    id: str
    label: str
    needs_image: bool

    def detect(self, frame: SensorFrame | None, ctx: DetectionContext) -> DetectionResult: ...


def _label(mask: np.ndarray) -> tuple[int, np.ndarray]:
    if HAVE_CV2:
        n, lab = cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)
        return n, lab
    # Pure-numpy/python fallback (4-connected flood fill over mask pixels only).
    lab = np.zeros(mask.shape, dtype=np.int32)
    h, w = mask.shape
    nid = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        nid += 1
        stack = [(y0, x0)]
        lab[y0, x0] = nid
        while stack:
            y, x = stack.pop()
            for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = nid
                    stack.append((yy, xx))
    return nid + 1, lab


class CentroidDetector:
    """Classical CV beacon detector: impulse repair, 3x3 box filter, robust threshold,
    connected components, size/SNR scoring, prediction gating, weighted centroid."""

    id = "centroid"
    label = "Image centroid detector (threshold + connected components)"
    needs_image = True

    # Frames larger than this are searched coarse-to-fine (half resolution, then refined).
    PYRAMID_PIXELS = 1_500_000
    # Candidates scored per frame (strongest first).
    MAX_CANDIDATES = 64

    def detect(self, frame: SensorFrame | None, ctx: DetectionContext) -> DetectionResult:
        t0 = time.perf_counter()
        if frame is None:
            return DetectionResult(None)
        H, W = frame.data.shape
        if not ctx.tracking and W * H > self.PYRAMID_PIXELS and not getattr(ctx, "_no_pyramid", False):
            return self._detect_pyramid(frame, ctx, t0)
        return self._detect(frame, ctx, t0)

    def _detect_pyramid(self, frame: SensorFrame, ctx: DetectionContext, t0: float) -> DetectionResult:
        """Search a 2x2-mean decimated copy, then refine around the best hit at full resolution."""
        # Remove salt & pepper at full resolution first: averaged impulses would otherwise
        # survive decimation as thousands of faint blobs.
        img = _repair_impulses(frame.data)
        H, W = img.shape
        h2, w2 = H // 2, W // 2
        small = img[: h2 * 2, : w2 * 2].reshape(h2, 2, w2, 2).astype(np.float32).mean(axis=(1, 3)).astype(np.uint8)
        sf = SensorFrame(w2, h2, small, None, None, False, frame.spot_size / 2, 0.0, None)
        c1 = DetectionContext(None, False, ctx.gate_px / 2, max(1.5, ctx.expected_size_px / 2), ctx.threshold_sigma, ctx.min_confidence, ctx.rng, verifier=ctx.verifier)
        c1._no_pyramid = True  # type: ignore[attr-defined]
        r1 = self._detect(sf, c1, t0)
        if r1.detection is None:
            cands = [_scaled(c, 2) for c in r1.candidates]
            return DetectionResult(None, cands, (time.perf_counter() - t0) * 1000, None, r1.n_candidates)
        d = r1.detection
        c2 = DetectionContext((d.x * 2, d.y * 2), True, max(12.0, ctx.expected_size_px * 1.5), ctx.expected_size_px, ctx.threshold_sigma, ctx.min_confidence, ctx.rng, verifier=ctx.verifier)
        c2._no_pyramid = True  # type: ignore[attr-defined]
        r2 = self._detect(frame, c2, t0)
        if r2.detection is None:  # refinement failed: keep the coarse position
            r2.detection = _scaled(d, 2)
        r2.n_candidates = r1.n_candidates
        r2.proc_ms = (time.perf_counter() - t0) * 1000
        return r2

    def _detect(self, frame: SensorFrame, ctx: DetectionContext, t0: float) -> DetectionResult:
        img = frame.data
        H, W = img.shape
        x0, y0, x1, y1 = 0, 0, W - 1, H - 1
        if ctx.tracking and ctx.predicted is not None:
            half = int(round(max(48, ctx.gate_px + ctx.expected_size_px * 1.5)))
            px, py = ctx.predicted
            if -half < px < W + half and -half < py < H + half:
                x0, y0 = max(0, int(np.floor(px - half))), max(0, int(np.floor(py - half)))
                x1, y1 = min(W - 1, int(np.ceil(px + half))), min(H - 1, int(np.ceil(py + half)))
        if x1 - x0 < 2 or y1 - y0 < 2:
            return DetectionResult(None, roi=(x0, y0, x1, y1))
        h, w = y1 - y0 + 1, x1 - x0 + 1
        v = img[y0 : y1 + 1, x0 : x1 + 1].astype(np.float32)
        work = v.copy()
        # Impulse repair (8-neighbourhood), evaluated only at extreme pixels.
        ey, ex = np.nonzero((v >= 250) | (v <= 4))
        if len(ey):
            gy, gx = ey + y0, ex + x0
            val = v[ey, ex]
            same = np.zeros(len(ey), np.int16)
            s_sum = np.zeros(len(ey), np.float32)
            s_cnt = np.zeros(len(ey), np.int16)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    yy, xx = gy + dy, gx + dx
                    ok = (yy >= 0) & (yy < H) & (xx >= 0) & (xx < W)
                    q = img[np.clip(yy, 0, H - 1), np.clip(xx, 0, W - 1)].astype(np.float32)
                    sim = ok & (np.abs(q - val) <= 12)
                    dis = ok & ~sim
                    same += sim
                    s_sum += np.where(dis, q, 0)
                    s_cnt += dis
            rep = (same < 3) & (s_cnt > 0)
            work[ey[rep], ex[rep]] = s_sum[rep] / s_cnt[rep]
        # 3x3 box mean (border-aware) from an integral image.
        I = np.zeros((h + 1, w + 1), np.float64)
        I[1:, 1:] = work.cumsum(0).cumsum(1)
        ya, yb = np.maximum(0, np.arange(h) - 1), np.minimum(h, np.arange(h) + 2)
        xa, xb = np.maximum(0, np.arange(w) - 1), np.minimum(w, np.arange(w) + 2)
        s = (I[yb][:, xb] - I[ya][:, xb] - I[yb][:, xa] + I[ya][:, xa]) / ((yb - ya)[:, None] * (xb - xa)[None, :])
        s = s.astype(np.float32)
        sample = s.ravel()[:: 3 if s.size > 40000 else 1]
        median = float(np.median(sample))
        mad = float(np.median(np.abs(sample - median)))
        sigma = max(0.35, 1.4826 * mad)
        use_ver = ctx.verifier and VERIFIER["trained"]
        k_seg = min(ctx.threshold_sigma, VERIFIER["segmentSigma"]) if use_ver else ctx.threshold_sigma
        cands = None
        for mult in (1.0, 2.5):
            thr = median + k_seg * mult * sigma
            mask = s > thr
            if mask.sum() > 0.2 * s.size:
                continue
            cands = self._components(mask, work, s, median, sigma, x0, y0, ctx)
            break
        cands = cands or []
        if use_ver:
            for c in cands:
                if c.features is not None:
                    c.p_beacon = verifier_probability(c.features)
                    c.confidence = c.p_beacon
        min_conf = VERIFIER["threshold"] if use_ver else ctx.min_confidence
        best, best_score = None, 0.0
        for c in cands:
            score = c.confidence
            if ctx.tracking and ctx.predicted is not None:
                d2 = (c.x - ctx.predicted[0]) ** 2 + (c.y - ctx.predicted[1]) ** 2
                g = ctx.gate_px
                if d2 > 6.25 * g * g:
                    continue
                score *= float(np.exp(-d2 / (2 * g * g)))
            if score > best_score:
                best, best_score = c, score
        cands.sort(key=lambda c: -c.confidence)
        det = best if best is not None and best.confidence >= min_conf else None
        return DetectionResult(det, cands[:6], (time.perf_counter() - t0) * 1000, (x0, y0, x1, y1), len(cands))

    def _components(self, mask, work, s, median, sigma, ox, oy, ctx) -> list[Candidate]:
        n, lab = _label(mask)
        if n <= 1:
            return []
        h, w = mask.shape
        # Work only on above-threshold pixels (a tiny subset of the ROI).
        pix = np.flatnonzero(mask)
        L = lab.ravel()[pix]
        yy, xx = np.divmod(pix, w)
        wr = work.ravel()[pix]
        sv = s.ravel()[pix]
        wt = np.clip(wr - median, 0, None)
        area = np.bincount(L, minlength=n)
        sw = np.bincount(L, weights=wt, minlength=n)
        swx = np.bincount(L, weights=wt * (xx + 0.5), minlength=n)
        swy = np.bincount(L, weights=wt * (yy + 0.5), minlength=n)
        swxx = np.bincount(L, weights=wt * (xx + 0.5) ** 2, minlength=n)
        swyy = np.bincount(L, weights=wt * (yy + 0.5) ** 2, minlength=n)
        raw_sum = np.bincount(L, weights=wr, minlength=n)
        sat = np.bincount(L, weights=(wr >= 250).astype(np.float64), minlength=n)
        order = np.argsort(L, kind="stable")
        Ls = L[order]
        starts = np.searchsorted(Ls, np.arange(n))
        valid = np.nonzero((area >= 2) & (sw > 0))[0]
        valid = valid[valid > 0]
        if not len(valid):
            return []
        peak = np.full(n, -np.inf)
        raw_peak = np.full(n, -np.inf)
        bx0 = np.zeros(n, int)
        bx1 = np.zeros(n, int)
        by0 = np.zeros(n, int)
        by1 = np.zeros(n, int)
        nz = np.nonzero(area)[0]
        ends = starts + area
        for arr, out, fn in ((sv, peak, np.maximum), (wr, raw_peak, np.maximum)):
            srt = arr[order]
            out[nz] = fn.reduceat(srt, starts[nz])
        xs, ys = xx[order], yy[order]
        bx0[nz], bx1[nz] = np.minimum.reduceat(xs, starts[nz]), np.maximum.reduceat(xs, starts[nz])
        by0[nz], by1[nz] = np.minimum.reduceat(ys, starts[nz]), np.maximum.reduceat(ys, starts[nz])
        del ends
        # Keep the strongest components (integrated signal) — not the first in raster order.
        strength = (peak[valid] - median) / sigma * np.sqrt(area[valid])
        valid = valid[np.argsort(-strength)][: self.MAX_CANDIDATES]
        exp_area = (ctx.expected_size_px + 1.5) ** 2
        out: list[Candidate] = []
        for i in valid:
            snr = (peak[i] - median) / sigma
            lr = np.log(area[i] / exp_area)
            size_score = float(np.exp(-(lr * lr) / (2 * 0.8 * 0.8)))
            snr_score = float(min(1.0, max(0.0, (snr - 6) / 24)) ** 0.6)
            conf = size_score**0.7 * snr_score
            cx, cy = swx[i] / sw[i], swy[i] / sw[i]
            feats = candidate_features(
                area=float(area[i]),
                exp_area=exp_area,
                snr=float(snr),
                bw=int(bx1[i] - bx0[i] + 1),
                bh=int(by1[i] - by0[i] + 1),
                mean_raw=float(raw_sum[i] / area[i]),
                raw_peak=float(raw_peak[i]),
                median=median,
                sigma=sigma,
                sat=float(sat[i] / area[i]),
                expected_size_px=ctx.expected_size_px,
                ring=_ring_mean(s, int(bx0[i]), int(by0[i]), int(bx1[i]), int(by1[i])),
                spread=float(np.sqrt(max(0.0, swxx[i] / sw[i] - cx * cx + swyy[i] / sw[i] - cy * cy))),
            )
            out.append(
                Candidate(
                    float(ox + cx),
                    float(oy + cy),
                    (int(ox + bx0[i]), int(oy + by0[i]), int(ox + bx1[i]), int(oy + by1[i])),
                    int(area[i]),
                    float(peak[i]),
                    float(snr),
                    size_score,
                    conf,
                    feats,
                )
            )
        return out


def _repair_impulses(img: np.ndarray) -> np.ndarray:
    """Copy of an 8-bit image with isolated saturated/black pixels replaced by their neighbours' mean."""
    H, W = img.shape
    out = img.copy()
    ey, ex = np.nonzero((img >= 250) | (img <= 4))
    if not len(ey):
        return out
    val = img[ey, ex].astype(np.float32)
    same = np.zeros(len(ey), np.int16)
    s_sum = np.zeros(len(ey), np.float32)
    s_cnt = np.zeros(len(ey), np.int16)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            yy, xx = ey + dy, ex + dx
            ok = (yy >= 0) & (yy < H) & (xx >= 0) & (xx < W)
            q = img[np.clip(yy, 0, H - 1), np.clip(xx, 0, W - 1)].astype(np.float32)
            sim = ok & (np.abs(q - val) <= 12)
            dis = ok & ~sim
            same += sim
            s_sum += np.where(dis, q, 0)
            s_cnt += dis
    rep = (same < 3) & (s_cnt > 0)
    out[ey[rep], ex[rep]] = (s_sum[rep] / s_cnt[rep]).astype(np.uint8)
    return out


def _scaled(c: Candidate, k: float) -> Candidate:
    b = c.bbox
    return Candidate(c.x * k, c.y * k, (int(b[0] * k), int(b[1] * k), int(b[2] * k + k - 1), int(b[3] * k + k - 1)), int(c.area * k * k), c.peak, c.snr,
                     c.size_score, c.confidence, c.features, c.p_beacon)


def _ring_mean(s: np.ndarray, bx0: int, by0: int, bx1: int, by1: int) -> float:
    """Mean smoothed level in a 2-px ring just outside a component's bounding box."""
    h, w = s.shape
    xa, xb = max(0, bx0 - 3), min(w - 1, bx1 + 3)
    ya, yb = max(0, by0 - 3), min(h - 1, by1 + 3)
    block = s[ya : yb + 1, xa : xb + 1]
    ia, ib = max(ya, by0 - 1), min(yb, by1 + 1)
    ja, jb = max(xa, bx0 - 1), min(xb, bx1 + 1)
    inner = s[ia : ib + 1, ja : jb + 1]
    cnt = block.size - inner.size
    return float((block.sum() - inner.sum()) / cnt) if cnt > 0 else 0.0


class SyntheticDetector:
    """Statistical model of a detector (truth + noise + misses). Labelled as a model."""

    id = "synthetic"
    label = "Synthetic measurement model (truth + noise + misses)"
    needs_image = False

    def __init__(self, noise_px: float, miss_prob: float):
        self.noise_px, self.miss_prob = noise_px, miss_prob

    def detect(self, frame, ctx: DetectionContext) -> DetectionResult:
        tr = ctx.truth
        if not tr or tr.get("px") is None or not tr.get("visible"):
            return DetectionResult(None, proc_ms=0.01)
        T = tr["transmission"]
        ns = tr["noiseSigma"]
        rng = ctx.rng
        p_miss = min(0.99, self.miss_prob + 0.5 * (1 - T) ** 2 + 0.002 * ns)
        if rng.next() < p_miss:
            return DetectionResult(None, proc_ms=0.01)
        sigma = self.noise_px * (1 + ns / 10)
        x = tr["px"][0] + sigma * rng.gauss()
        y = tr["px"][1] + sigma * rng.gauss()
        conf = max(0.05, min(0.99, 0.97 * T**0.5 - ns / 150 + 0.02 * rng.gauss()))
        if conf < ctx.min_confidence:
            return DetectionResult(None, proc_ms=0.01)
        hf = ctx.expected_size_px / 2
        c = Candidate(x, y, (int(x - hf), int(y - hf), int(x + hf), int(y + hf)), int(ctx.expected_size_px**2), 0.0, 0.0, 1.0, conf)
        return DetectionResult(c, [c], 0.01, None, 1)


class YoloDetectionProvider:  # pragma: no cover - planned, not implemented
    """PLANNED. Integration point for a trained YOLO beacon model (e.g. ultralytics).

    Not implemented: ASTRAQ ships no trained model and makes no YOLO claims.
    To add one: load the model in __init__, run it on `frame.data` in detect(),
    convert the best box to a `Candidate` (centre = box centre or intensity
    centroid inside the box) and return a `DetectionResult`.
    """

    id = "yolo"
    label = "YOLO detector (planned)"
    needs_image = True

    def __init__(self, *_: object, **__: object):
        raise NotImplementedError("YOLO detection is planned, not implemented. See README section 20.")


def create_detector(cfg: dict):
    if cfg["provider"] == "synthetic":
        return SyntheticDetector(cfg["syntheticNoisePx"], cfg["syntheticMissProb"])
    return CentroidDetector()
