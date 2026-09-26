"""Kalman filter, PID, gimbal and search patterns (mirror of the TS estimation/ and control/ modules)."""
from __future__ import annotations

import math

from .mathx import clamp, wrap_deg


class _Axis:
    def __init__(self) -> None:
        self.x = self.v = 0.0
        self.p00, self.p01, self.p11 = 1.0, 0.0, 1.0

    def init(self, x: float, pv: float, rv: float, v: float = 0.0) -> None:
        self.x, self.v = x, v
        self.p00, self.p01, self.p11 = pv, 0.0, rv

    def predict(self, dt: float, q: float) -> None:
        self.x += self.v * dt
        p00 = self.p00 + dt * (2 * self.p01 + dt * self.p11)
        p01 = self.p01 + dt * self.p11
        self.p00 = p00 + q * dt**3 / 3
        self.p01 = p01 + q * dt**2 / 2
        self.p11 = self.p11 + q * dt

    def update(self, nu: float, r: float) -> None:
        S = self.p00 + r
        k0, k1 = self.p00 / S, self.p01 / S
        self.x += k0 * nu
        self.v += k1 * nu
        p00, p01, p11 = (1 - k0) * self.p00, (1 - k0) * self.p01, self.p11 - k1 * self.p01
        self.p00, self.p01, self.p11 = p00, p01, p11


class AngularKalman:
    """Constant-velocity filter on target azimuth/elevation with innovation gating and
    innovation-based adaptive measurement noise."""

    def __init__(self) -> None:
        self.az, self.el = _Axis(), _Axis()
        self.reset()

    def reset(self) -> None:
        self.initialized = False
        self.updates = 0
        self.t = 0.0
        self.last_innov = 0.0
        self.r_scale = 1.0
        self.nis_avg = 1.0

    def init(self, az: float, el: float, t: float, sigma: float, keep_rate: bool = False) -> None:
        va = self.az.v if keep_rate and self.initialized else 0.0
        ve = self.el.v if keep_rate and self.initialized else 0.0
        self.az.init(az, sigma**2, 1 if keep_rate else 4, va)
        self.el.init(el, sigma**2, 1 if keep_rate else 4, ve)
        self.t = t
        self.initialized = True
        self.updates = 1

    def predict_to(self, t: float, q: float, el: float) -> None:
        if not self.initialized:
            return
        dt = t - self.t
        if dt <= 0:
            return
        c = max(0.2, math.cos(math.radians(el)))
        self.az.predict(dt, q / (c * c))
        self.el.predict(dt, q)
        self.t = t

    def update(self, az: float, el: float, r_deg: float, gate: float) -> bool:
        c = max(0.2, math.cos(math.radians(self.el.x)))
        r_az = (r_deg / c) ** 2 * self.r_scale
        r_el = r_deg**2 * self.r_scale
        z_az = self.az.x + wrap_deg(az - self.az.x)
        nu_az, nu_el = z_az - self.az.x, el - self.el.x
        nis = nu_az**2 / (self.az.p00 + r_az) + nu_el**2 / (self.el.p00 + r_el)
        self.last_innov = math.hypot(nu_az * c, nu_el)
        ratio = min(nis, 4 * gate) / 2
        self.nis_avg += 0.08 * (ratio - self.nis_avg)
        self.r_scale = min(900.0, max(1.0, self.r_scale * self.nis_avg**0.08))
        if nis > gate * max(1.0, self.nis_avg) and self.updates > 2:
            return False
        self.az.update(nu_az, r_az)
        self.el.update(nu_el, r_el)
        self.updates += 1
        return True

    def estimate_at(self, t: float) -> dict:
        dt = max(0.0, t - self.t)
        c = max(0.2, math.cos(math.radians(self.el.x)))
        return {
            "az": self.az.x + self.az.v * dt,
            "el": self.el.x + self.el.v * dt,
            "azRate": self.az.v,
            "elRate": self.el.v,
            "sigmaAz": math.sqrt(max(0.0, self.az.p00 + dt * dt * self.az.p11)) * c,
            "sigmaEl": math.sqrt(max(0.0, self.el.p00 + dt * dt * self.el.p11)),
        }


class PidAxis:
    def __init__(self) -> None:
        self.reset()
        self.last_p = self.last_i = self.last_d = 0.0

    def reset(self) -> None:
        self.integral = 0.0
        self.d_filt = 0.0
        self.prev: float | None = None

    def update(self, err: float, dt: float, g: dict, limit: float, ff: float = 0.0) -> float:
        if dt <= 0:
            return 0.0
        raw_d = 0.0 if self.prev is None else (err - self.prev) / dt
        self.prev = err
        a = dt / (g["derivativeFilterS"] + dt) if g["derivativeFilterS"] > 0 else 1.0
        self.d_filt += a * (raw_d - self.d_filt)
        p = g["kp"] * err
        d = g["kd"] * self.d_filt
        unsat = p + g["ki"] * self.integral + d + ff
        saturated = abs(unsat) >= limit and math.copysign(1, unsat) == math.copysign(1, err)
        near = abs(err) <= g.get("integralZone", float("inf"))
        if not saturated and near:
            self.integral = clamp(self.integral + err * dt, -g["integralLimit"], g["integralLimit"])
        i = g["ki"] * self.integral
        self.last_p, self.last_i, self.last_d = p, i, d
        return clamp(p + i + d + ff, -limit, limit)


class Gimbal:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.reset(0.0, 0.0)

    def reset(self, pan: float, tilt: float) -> None:
        self.pan = wrap_deg(pan)
        self.tilt = clamp(tilt, self.cfg["tiltMinDeg"], self.cfg["tiltMaxDeg"])
        self.pan_rate = self.tilt_rate = self.pan_cmd = self.tilt_cmd = 0.0
        self.at_limit = False

    def step(self, dt: float, pan_cmd: float, tilt_cmd: float, wind_pan: float = 0.0, wind_tilt: float = 0.0) -> None:
        c = self.cfg
        mr = c["maxRateDegS"]
        self.pan_cmd, self.tilt_cmd = clamp(pan_cmd, -mr, mr), clamp(tilt_cmd, -mr, mr)
        lag = max(1e-3, c["rateLagS"])
        mdv = c["maxAccelDegS2"] * dt
        self.pan_rate = clamp(self.pan_rate + clamp((self.pan_cmd - self.pan_rate) * dt / lag, -mdv, mdv), -mr, mr)
        self.tilt_rate = clamp(self.tilt_rate + clamp((self.tilt_cmd - self.tilt_rate) * dt / lag, -mdv, mdv), -mr, mr)
        pan = self.pan + (self.pan_rate + wind_pan) * dt
        tilt = self.tilt + (self.tilt_rate + wind_tilt) * dt
        self.at_limit = False
        if c["panMaxDeg"] - c["panMinDeg"] >= 360:
            pan = wrap_deg(pan)
        elif pan < c["panMinDeg"] or pan > c["panMaxDeg"]:
            pan = clamp(pan, c["panMinDeg"], c["panMaxDeg"])
            self.pan_rate = 0.0
            self.at_limit = True
        if tilt < c["tiltMinDeg"] or tilt > c["tiltMaxDeg"]:
            tilt = clamp(tilt, c["tiltMinDeg"], c["tiltMaxDeg"])
            self.tilt_rate = 0.0
            self.at_limit = True
        self.pan, self.tilt = pan, tilt

    def rate_toward(self, pan_goal: float, tilt_goal: float, gain: float = 3.0) -> tuple[float, float]:
        c = self.cfg

        def prof(e: float) -> float:
            a = abs(e)
            v = min(c["maxRateDegS"], gain * a, math.sqrt(2 * c["maxAccelDegS2"] * 0.6 * a))
            return math.copysign(v, e)

        return prof(wrap_deg(pan_goal - self.pan)), prof(tilt_goal - self.tilt)


class SpiralSearch:
    def __init__(self, half_u: float, half_v: float, step_u: float, step_v: float, max_rings: int = 99):
        self.lim_u = max(0.0, half_u - step_u / 1.7 + 0.1)
        self.lim_v = max(0.0, half_v - step_v / 1.7 + 0.1)
        pts = [[0.0, 0.0]]
        x = y = 0
        ln = 1
        dirs = [(1, 0), (0, 1), (-1, 0), (0, -1)]
        d = 0
        nu = math.ceil(half_u / step_u)
        nv = math.ceil(half_v / step_v)
        max_len = min(2 * max(nu, nv) + 2, 2 * max_rings + 2)
        while ln <= max_len:
            for _ in range(2):
                for _ in range(ln):
                    x += dirs[d][0]
                    y += dirs[d][1]
                    if abs(x) <= nu and abs(y) <= nv:
                        p = [clamp(x * step_u, -self.lim_u, self.lim_u), clamp(y * step_v, -self.lim_v, self.lim_v)]
                        if abs(pts[-1][0] - p[0]) > 1e-6 or abs(pts[-1][1] - p[1]) > 1e-6:
                            pts.append(p)
                d = (d + 1) % 4
            ln += 1
        self.points = pts
        self.index = 0
        self.cycles = 0

    def update(self, u: float, v: float, tol_u: float, tol_v: float) -> list[float]:
        pu, pv = self.points[self.index]
        if abs(u - pu) < tol_u and abs(v - pv) < tol_v:
            self.index += 1
            if self.index >= len(self.points):
                self.index = 0
                self.cycles += 1
        return self.points[self.index]
