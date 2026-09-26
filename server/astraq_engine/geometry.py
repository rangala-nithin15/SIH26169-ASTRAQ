"""Site-local ENU geometry (East-Up-South), pinhole camera, orbital pass. Mirrors geometry.ts / camera.ts."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .config import intrinsics
from .mathx import RAD, normalize

EARTH_RADIUS_KM = 6371.0
MU_EARTH = 398600.4418


def dir_from_azel(az: float, el: float) -> np.ndarray:
    a, e = math.radians(az), math.radians(el)
    return np.array([math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e)])


def azel_from_dir(d: np.ndarray) -> tuple[float, float]:
    n = normalize(np.asarray(d, dtype=float))
    el = math.degrees(math.asin(max(-1.0, min(1.0, n[1]))))
    az = math.degrees(math.atan2(n[0], -n[2]))
    if az < 0:
        az += 360
    return az, el


@dataclass
class Basis:
    f: np.ndarray
    r: np.ndarray
    u: np.ndarray


def basis_from_azel(az: float, el: float) -> Basis:
    f = dir_from_azel(az, el)
    a = math.radians(az)
    r = np.array([math.cos(a), 0.0, math.sin(a)])
    u = np.cross(r, f)
    return Basis(f, normalize(r), normalize(u))


def dir_from_field(b: Basis, u: float, v: float) -> np.ndarray:
    return normalize(b.f + b.r * math.tan(math.radians(u)) + b.u * math.tan(math.radians(v)))


def field_from_dir(b: Basis, d: np.ndarray) -> tuple[float, float] | None:
    z = float(np.dot(d, b.f))
    if z <= 1e-9:
        return None
    return math.degrees(math.atan(float(np.dot(d, b.r)) / z)), math.degrees(math.atan(float(np.dot(d, b.u)) / z))


def slant_range_km(alt: float, el: float) -> float:
    R = EARTH_RADIUS_KM
    e = math.radians(el)
    return math.sqrt((R + alt) ** 2 - (R * math.cos(e)) ** 2) - R * math.sin(e)


class OrbitalPass:
    def __init__(self, alt_km: float, max_el: float, heading: float):
        R = EARTH_RADIUS_KM
        self.r = R + alt_km
        self.omega = math.sqrt(MU_EARTH / self.r**3)
        self.speed = self.omega * self.r
        k = R / self.r
        target = math.radians(max(1.0, min(89.9, max_el)))
        lo, hi = 1e-6, math.acos(k) - 1e-6
        for _ in range(80):
            mid = (lo + hi) / 2
            el = math.atan2(math.cos(mid) - k, math.sin(mid))
            if el > target:
                lo = mid
            else:
                hi = mid
        lam = (lo + hi) / 2
        h = math.radians(heading)
        along = np.array([math.sin(h), 0.0, -math.cos(h)])
        cross_dir = np.array([math.cos(h), 0.0, math.sin(h)])
        up = np.array([0.0, 1.0, 0.0])
        self.a = normalize(up * math.cos(lam) + cross_dir * math.sin(lam))
        self.b = along

    def position_km(self, t: float) -> np.ndarray:
        th = self.omega * t
        p = (self.a * math.cos(th) + self.b * math.sin(th)) * self.r
        return np.array([p[0], p[1] - EARTH_RADIUS_KM, p[2]])


class PinholeCamera:
    def __init__(self, cam: dict, pan: float = 0.0, tilt: float = 0.0, hfov: float | None = None):
        self.cfg = cam
        self.k = intrinsics(cam, hfov)
        self.set_pose(pan, tilt)

    def set_pose(self, pan: float, tilt: float) -> None:
        self.pan, self.tilt = pan, tilt
        self.basis = basis_from_azel(pan, tilt)

    def set_fov(self, hfov: float) -> None:
        self.k = intrinsics(self.cfg, hfov)

    def project(self, d: np.ndarray) -> tuple[float, float] | None:
        b = self.basis
        z = float(np.dot(d, b.f))
        if z <= 1e-9:
            return None
        return (self.k["cx"] + self.k["fx"] * float(np.dot(d, b.r)) / z, self.k["cy"] - self.k["fy"] * float(np.dot(d, b.u)) / z)

    def unproject(self, px: float, py: float) -> np.ndarray:
        b = self.basis
        return normalize(b.f + b.r * ((px - self.k["cx"]) / self.k["fx"]) - b.u * ((py - self.k["cy"]) / self.k["fy"]))

    def in_frame(self, p: tuple[float, float] | None, margin: float = 0) -> bool:
        return p is not None and -margin <= p[0] < self.cfg["width"] + margin and -margin <= p[1] < self.cfg["height"] + margin

    def angular_error(self, d: np.ndarray) -> tuple[float, float] | None:
        b = self.basis
        z = float(np.dot(d, b.f))
        if z <= 1e-9:
            return None
        return math.atan(float(np.dot(d, b.r)) / z) * RAD, math.atan(float(np.dot(d, b.u)) / z) * RAD
