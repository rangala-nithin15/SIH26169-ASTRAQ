"""Star catalogue and synthetic focal-plane renderer (mirror of stars.ts / sensor.ts, numpy)."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .disturbance import DisturbanceState
from .geometry import PinholeCamera
from .mathx import Rng, normalize


def make_star_catalog(seed: int = 7, count: int = 6000) -> tuple[np.ndarray, np.ndarray]:
    """Same generator as web/src/core/optics/stars.ts (identical sequence for the same seed)."""
    rng = Rng(seed)
    dirs = np.zeros((count, 3))
    mags = np.zeros(count)
    pole = normalize(np.array([0.35, 0.55, 0.76]))
    e1 = normalize(np.cross(pole, np.array([0.0, 1.0, 0.0])))
    e2 = np.cross(pole, e1)
    k = 0.45 * math.log(10)
    cmin, cmax = math.exp(k * -1.2), math.exp(k * 7.5)
    for i in range(count):
        if rng.next() < 0.42:
            phi = rng.uniform(0, 2 * math.pi)
            b = rng.gauss() * 0.16
            ring = e1 * math.cos(phi) + e2 * math.sin(phi)
            d = normalize(ring * math.cos(b) + pole * math.sin(b))
        else:
            z = rng.uniform(-1, 1)
            phi = rng.uniform(0, 2 * math.pi)
            r = math.sqrt(1 - z * z)
            d = np.array([r * math.cos(phi), z, r * math.sin(phi)])
        dirs[i] = d
        c = cmin + rng.next() * (cmax - cmin)
        mags[i] = math.log(c) / k
        rng.gauss()  # colour index draw (keeps the sequence aligned with the TS catalogue)
    return dirs, mags


@dataclass
class SensorFrame:
    width: int
    height: int
    data: np.ndarray  # uint8 (H, W)
    truth_px: tuple[float, float] | None
    spot_px: tuple[float, float] | None
    spot_visible: bool
    spot_size: float
    spot_peak: float
    decoy_px: tuple[float, float] | None


class SensorRenderer:
    def __init__(self, width: int, height: int, seed: int):
        self.w, self.h = width, height
        self.np_rng = np.random.default_rng(seed ^ 0x5E45)

    def resize(self, w: int, h: int) -> None:
        self.w, self.h = w, h

    def _gauss(self, buf: np.ndarray, cx: float, cy: float, sigma: float, amp: float, radius: int = 2) -> None:
        x0, x1 = max(0, int(math.floor(cx - radius))), min(self.w - 1, int(math.ceil(cx + radius)))
        y0, y1 = max(0, int(math.floor(cy - radius))), min(self.h - 1, int(math.ceil(cy + radius)))
        if x1 < x0 or y1 < y0:
            return
        xs = np.arange(x0, x1 + 1) + 0.5 - cx
        ys = np.arange(y0, y1 + 1) + 0.5 - cy
        g = amp * np.exp(-(ys[:, None] ** 2 + xs[None, :] ** 2) / (2 * sigma * sigma))
        buf[y0 : y1 + 1, x0 : x1 + 1] += g

    def _spot(self, buf: np.ndarray, cx: float, cy: float, size: float, amp: float, shape: str) -> None:
        if shape == "gaussian":
            self._gauss(buf, cx, cy, size / 2.6, amp, int(math.ceil(size * 1.3)))
            return
        half = size / 2
        x0, x1 = max(0, int(math.floor(cx - half - 1))), min(self.w - 1, int(math.ceil(cx + half + 1)))
        y0, y1 = max(0, int(math.floor(cy - half - 1))), min(self.h - 1, int(math.ceil(cy + half + 1)))
        if x1 < x0 or y1 < y0:
            return
        xs = np.arange(x0, x1 + 1, dtype=float)
        ys = np.arange(y0, y1 + 1, dtype=float)
        if shape == "square":
            ox = np.clip(np.minimum(xs + 1, cx + half) - np.maximum(xs, cx - half), 0, None)
            oy = np.clip(np.minimum(ys + 1, cy + half) - np.maximum(ys, cy - half), 0, None)
            buf[y0 : y1 + 1, x0 : x1 + 1] += amp * np.outer(oy, ox)
        else:
            sub = (np.arange(4) + 0.5) / 4
            px = xs[:, None] + sub[None, :] - cx  # (nx, 4)
            py = ys[:, None] + sub[None, :] - cy  # (ny, 4)
            inside = (py[:, None, :, None] ** 2 + px[None, :, None, :] ** 2) <= half * half
            buf[y0 : y1 + 1, x0 : x1 + 1] += amp * inside.sum(axis=(2, 3)) / 16

    def render(self, cam: PinholeCamera, cfg: dict, beacon_dir: np.ndarray, decoy_dir: np.ndarray | None, dist: DisturbanceState, stars: tuple[np.ndarray, np.ndarray], nominal_hfov: float) -> SensorFrame:
        W, H = self.w, self.h
        atm = dist.atm
        d = cfg["disturbance"]
        gain = atm.gain
        bg = (12 + atm.airlight) * gain
        buf = np.full((H, W), bg, dtype=np.float32)
        dirs, mags = stars
        f = cam.basis.f
        cos_lim = math.cos(math.radians(cam.k["hfovDeg"] * 0.75))
        for i in np.nonzero(dirs @ f >= cos_lim)[0]:
            p = cam.project(dirs[i])
            if p is None:
                continue
            amp = min(70.0, 70 * 10 ** (-0.4 * (mags[i] - 0.5))) * atm.transmission * gain
            if amp >= 1.5:
                self._gauss(buf, p[0], p[1], 0.75, amp)
        truth = cam.project(beacon_dir)
        scale = nominal_hfov / cam.k["hfovDeg"]
        size = max(1.2, cfg["target"]["spotSizePx"] * scale * (1 + 0.25 * d["turbulence"]))
        spot = None
        peak = 0.0
        visible = False
        if truth is not None:
            spot = (truth[0] + dist.aoa_x * scale, truth[1] + dist.aoa_y * scale)
            inside = -size < spot[0] < W + size and -size < spot[1] < H + size
            if inside and not dist.dropout:
                peak = cfg["target"]["beaconIntensity"] * atm.transmission * dist.scint * gain
                self._spot(buf, spot[0], spot[1], size, peak, cfg["target"]["spotShape"])
                visible = 0 <= spot[0] < W and 0 <= spot[1] < H
        decoy_px = None
        if decoy_dir is not None:
            decoy_px = cam.project(decoy_dir)
            if decoy_px is not None:
                self._spot(buf, decoy_px[0], decoy_px[1], max(1.5, size * 0.4), 0.55 * cfg["target"]["beaconIntensity"] * atm.transmission * gain, "gaussian")
        for _ in range(atm.streaks):
            x0, y0 = self.np_rng.uniform(0, W), self.np_rng.uniform(0, H)
            ln = int(self.np_rng.uniform(15, 45))
            amp = self.np_rng.uniform(6, 16) * gain
            ks = np.arange(ln)
            xs = np.round(x0 + ks * 0.25).astype(int)
            ys = np.round(y0 + ks).astype(int)
            ok = (xs >= 0) & (xs < W) & (ys >= 0) & (ys < H)
            buf[ys[ok], xs[ok]] += amp
        sg = d["gaussianNoise"]
        if d["poisson"]:
            sigma = np.sqrt(sg * sg + 0.45 * np.clip(buf, 0, None))
            buf += sigma * self.np_rng.standard_normal((H, W), dtype=np.float32)
        elif sg > 0:
            buf += sg * self.np_rng.standard_normal((H, W), dtype=np.float32)
        out = np.clip(np.rint(buf), 0, 255).astype(np.uint8)
        if d["saltPepper"] > 0:
            n = int(round(d["saltPepper"] * W * H))
            idx = self.np_rng.integers(0, W * H, n)
            vals = np.where(self.np_rng.random(n) < 0.5, 0, 255).astype(np.uint8)
            out.reshape(-1)[idx] = vals
        return SensorFrame(W, H, out, truth, spot, visible, size, peak, decoy_px)
