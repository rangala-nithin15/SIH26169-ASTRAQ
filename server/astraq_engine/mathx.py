"""Math helpers and the seeded PRNG shared (bit-for-bit) with the TypeScript engine."""
from __future__ import annotations

import math

import numpy as np

DEG = math.pi / 180
RAD = 180 / math.pi


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def wrap_deg(a: float) -> float:
    r = ((a + 180) % 360 + 360) % 360 - 180
    return 180.0 if r == -180 else r


def normalize(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / (n if n > 0 else 1.0)


def angle_between_deg(a: np.ndarray, b: np.ndarray) -> float:
    return math.degrees(math.acos(clamp(float(np.dot(normalize(a), normalize(b))), -1.0, 1.0)))


def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


class Rng:
    """mulberry32 + polar Box-Muller, identical to web/src/core/math.ts."""

    def __init__(self, seed: int):
        s = seed & 0xFFFFFFFF
        self.s = s if s else 0x9E3779B9
        self.spare: float | None = None

    def next(self) -> float:
        self.s = (self.s + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.s
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def uniform(self, lo: float, hi: float) -> float:
        return lo + (hi - lo) * self.next()

    def int(self, n: int) -> int:
        return int(self.next() * n)

    def gauss(self) -> float:
        if self.spare is not None:
            v = self.spare
            self.spare = None
            return v
        while True:
            u = self.next() * 2 - 1
            v = self.next() * 2 - 1
            s = u * u + v * v
            if 0 < s < 1:
                break
        m = math.sqrt(-2 * math.log(s) / s)
        self.spare = v * m
        return u * m


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))
