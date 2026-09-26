"""Remote-terminal motion model (mirror of web/src/core/target/trajectory.ts)."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .geometry import Basis, OrbitalPass, azel_from_dir, basis_from_azel, dir_from_field, field_from_dir, slant_range_km
from .mathx import Rng, clamp, normalize

PASS_START_S = -24.0


@dataclass
class TargetTruth:
    t: float
    dir: np.ndarray
    az: float
    el: float
    range_km: float
    pos_km: np.ndarray
    u: float
    v: float
    u_rate: float
    v_rate: float
    ang_rate: float
    transverse: float
    ref: Basis


class TargetModel:
    def __init__(self, sim: dict, seed: int):
        self.sim = sim
        self.cfg = sim["target"]
        self.rng = Rng((seed ^ 0x51ED27) & 0xFFFFFFFF)
        self.ref_fixed = basis_from_azel(sim["scene"]["losAzDeg"], sim["scene"]["losElDeg"])
        self.last: TargetTruth | None = None
        self.passm: OrbitalPass | None = None
        self.reset()

    def bounds(self) -> tuple[float, float]:
        lg = self.sim["logic"]
        return lg["searchHalfUDeg"] - 0.4, lg["searchHalfVDeg"] - 0.4

    def pattern_extent(self) -> float:
        k = self.cfg["trajectory"]
        return self.cfg["amplitudeDeg"] if k in ("circular", "sinusoidal", "figure8", "spiral") else 0.0

    def reset(self) -> None:
        self.t = 0.0
        self.pattern_t = 0.0
        self.wp_index = 0
        self.noise = [0.0, 0.0]
        self.last = None
        bu, bv = self.bounds()
        m = self.pattern_extent()
        if self.cfg["startMode"] == "fixed":
            start = [clamp(self.cfg["startUDeg"], -bu, bu), clamp(self.cfg["startVDeg"], -bv, bv)]
        else:
            start = [self.rng.uniform(-bu, bu), self.rng.uniform(-bv, bv)]
        self.pos = list(start)
        h = math.radians(self.cfg["headingDeg"])
        self.vel = [math.cos(h) * self.cfg["speedDegS"], math.sin(h) * self.cfg["speedDegS"]]
        f0 = self.pattern_offset(0)
        anchor = [start[0] - f0[0], start[1] - f0[1]]
        self.anchor_goal = [clamp(anchor[0], -bu + m, bu - m), clamp(anchor[1], -bv + m, bv - m)]
        self.anchor = list(self.anchor_goal)
        sc = self.sim["scene"]
        self.passm = OrbitalPass(sc["altitudeKm"], sc["passMaxElDeg"], sc["passHeadingDeg"]) if self.cfg["trajectory"] == "orbital" else None

    def set_config(self, sim: dict) -> None:
        prev = self.cfg["trajectory"]
        cur = [self.last.u, self.last.v] if self.last else list(self.pos)
        self.sim = sim
        self.cfg = sim["target"]
        self.ref_fixed = basis_from_azel(sim["scene"]["losAzDeg"], sim["scene"]["losElDeg"])
        if self.cfg["trajectory"] == "orbital":
            if prev != "orbital" or self.passm is None:
                sc = sim["scene"]
                self.passm = OrbitalPass(sc["altitudeKm"], sc["passMaxElDeg"], sc["passHeadingDeg"])
                self.t = 0.0
            return
        self.passm = None
        self.pattern_t = 0.0
        self.pos = list(cur)
        h = math.radians(self.cfg["headingDeg"])
        self.vel = [math.cos(h) * self.cfg["speedDegS"], math.sin(h) * self.cfg["speedDegS"]]
        f0 = self.pattern_offset(0)
        self.anchor = [cur[0] - f0[0], cur[1] - f0[1]]
        bu, bv = self.bounds()
        m = self.pattern_extent()
        self.anchor_goal = [clamp(self.anchor[0], -bu + m, bu - m), clamp(self.anchor[1], -bv + m, bv - m)]
        if prev == "orbital":
            self.anchor = list(self.anchor_goal)

    def pattern_offset(self, t: float) -> tuple[float, float]:
        A = self.cfg["amplitudeDeg"]
        P = max(0.5, self.cfg["periodS"])
        w = 2 * math.pi / P
        k = self.cfg["trajectory"]
        x = y = 0.0
        if k == "circular":
            x, y = A * math.cos(w * t), A * math.sin(w * t)
        elif k == "sinusoidal":
            x, y = A * math.sin(w * t), 0.45 * A * math.sin(3 * w * t)
        elif k == "figure8":
            x, y = A * math.sin(w * t), 0.6 * A * math.sin(2 * w * t)
        elif k == "spiral":
            frac = (t / P) % 1
            r = A * (0.15 + 0.85 * (1 - abs(2 * frac - 1)))
            x, y = r * math.cos(3 * w * t), r * math.sin(3 * w * t)
        h = math.radians(self.cfg["headingDeg"])
        return x * math.cos(h) - y * math.sin(h), x * math.sin(h) + y * math.cos(h)

    def step(self, dt: float, noise_deg: float) -> TargetTruth:
        self.t += dt
        self.pattern_t += dt
        k = self.cfg["trajectory"]
        bu, bv = self.bounds()
        a = math.exp(-dt / 0.8)
        s = noise_deg * math.sqrt(1 - a * a)
        self.noise = [a * self.noise[0] + s * self.rng.gauss(), a * self.noise[1] + s * self.rng.gauss()]
        ref = self.ref_fixed
        range_km = self.cfg["rangeKm"]
        if k == "orbital" and self.passm is not None:
            tp = PASS_START_S + self.t
            p = self.passm.position_km(tp)
            pp = self.passm.position_km(tp - self.sim["scene"]["ephemerisErrorS"])
            paz, pel = azel_from_dir(pp)
            ref = basis_from_azel(paz, pel)
            d = normalize(p)
            range_km = float(np.linalg.norm(p))
            f = field_from_dir(ref, d) or (0.0, 0.0)
            u, v = f[0] + self.noise[0], f[1] + self.noise[1]
            d = dir_from_field(ref, u, v)
        else:
            if k == "linear":
                self.pos[0] += self.vel[0] * dt
                self.pos[1] += self.vel[1] * dt
                if abs(self.pos[0]) > bu:
                    self.vel[0] = -math.copysign(abs(self.vel[0]), self.pos[0])
                    self.pos[0] = clamp(self.pos[0], -bu, bu)
                if abs(self.pos[1]) > bv:
                    self.vel[1] = -math.copysign(abs(self.vel[1]), self.pos[1])
                    self.pos[1] = clamp(self.pos[1], -bv, bv)
                u, v = self.pos
            elif k == "random":
                av = math.exp(-dt / 2.0)
                sv = self.cfg["speedDegS"] * math.sqrt(1 - av * av)
                for i, b in enumerate((bu, bv)):
                    acc = -math.copysign(1, self.pos[i]) * self.cfg["speedDegS"] * 1.5 if abs(self.pos[i]) > 0.7 * b else 0.0
                    self.vel[i] = av * self.vel[i] + sv * self.rng.gauss() + acc * dt
                    self.pos[i] = clamp(self.pos[i] + self.vel[i] * dt, -b, b)
                u, v = self.pos
            elif k == "custom":
                wps = self.cfg["waypoints"] if len(self.cfg["waypoints"]) >= 2 else [[0, 0], [1, 1]]
                rem = self.cfg["speedDegS"] * dt
                for _ in range(8):
                    if rem <= 0:
                        break
                    g = wps[self.wp_index % len(wps)]
                    gu, gv = clamp(g[0], -bu, bu), clamp(g[1], -bv, bv)
                    dd = math.hypot(gu - self.pos[0], gv - self.pos[1])
                    if dd <= rem:
                        self.pos = [gu, gv]
                        rem -= dd
                        self.wp_index += 1
                    else:
                        self.pos[0] += (gu - self.pos[0]) / dd * rem
                        self.pos[1] += (gv - self.pos[1]) / dd * rem
                        rem = 0
                u, v = self.pos
            else:
                mg = 0.8 * dt
                for i in range(2):
                    self.anchor[i] += clamp(self.anchor_goal[i] - self.anchor[i], -mg, mg)
                f = self.pattern_offset(self.pattern_t)
                u, v = self.anchor[0] + f[0], self.anchor[1] + f[1]
                self.pos = [u, v]
            u += self.noise[0]
            v += self.noise[1]
            d = dir_from_field(ref, u, v)
            if self.sim["scene"]["remote"] == "leo":
                range_km = slant_range_km(self.sim["scene"]["altitudeKm"], max(1.0, azel_from_dir(d)[1]))
        az, el = azel_from_dir(d)
        pos = d * range_km
        u_rate = v_rate = ang = trans = 0.0
        if self.last is not None and dt > 0:
            u_rate = (u - self.last.u) / dt
            v_rate = (v - self.last.v) / dt
            c = max(-1.0, min(1.0, float(np.dot(d, self.last.dir))))
            ang = math.degrees(math.acos(c)) / dt
            trans = float(np.linalg.norm(pos - self.last.pos_km)) / dt if k == "orbital" else math.radians(ang) * range_km
        tr = TargetTruth(self.t, d, az, el, range_km, pos, u, v, u_rate, v_rate, ang, trans, ref)
        self.last = tr
        return tr

    def preview_path(self, seconds: float, samples: int) -> list[list[float]]:
        k = self.cfg["trajectory"]
        if k in ("linear", "random", "orbital"):
            return []
        if k == "custom":
            return [list(w) for w in self.cfg["waypoints"]]
        out = []
        for i in range(samples + 1):
            f = self.pattern_offset(self.pattern_t + seconds * i / samples)
            out.append([self.anchor_goal[0] + f[0], self.anchor_goal[1] + f[1]])
        return out
