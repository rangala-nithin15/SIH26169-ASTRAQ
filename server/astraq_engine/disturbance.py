"""Disturbance models (mirror of web/src/core/disturbance/disturbance.ts)."""
from __future__ import annotations

import math
from dataclasses import dataclass

from .mathx import Rng


@dataclass
class Atmosphere:
    transmission: float
    airlight: float
    gain: float
    attenuation_db: float
    extra_dropout: float
    streaks: int


def atmosphere_effect(mode: str, strength: float) -> Atmosphere:
    s = min(1.0, max(0.0, strength))
    T, A, g, drop, streaks = 1.0, 0.0, 1.0, 0.0, 0
    if mode == "clear":
        T = 1 - 0.12 * s
    elif mode == "haze":
        T, A = 1 - 0.6 * s, 38 * s
    elif mode == "fog":
        T, A = 1 - 0.93 * s, 85 * s
    elif mode == "rain":
        T, A, drop, streaks = 1 - 0.5 * s, 18 * s, 0.12 * s, round(30 * s)
    elif mode == "low_light":
        g = 1 - 0.75 * s
    return Atmosphere(T, A, g, -10 * math.log10(max(1e-4, T)), drop, streaks)


@dataclass
class DisturbanceState:
    d_pan: float
    d_tilt: float
    wind_pan: float
    wind_tilt: float
    scint: float
    aoa_x: float
    aoa_y: float
    dropout: bool
    atm: Atmosphere
    occluded: bool = False


class DisturbanceModel:
    def __init__(self, seed: int):
        self.rng = Rng((seed ^ 0xD157) & 0xFFFFFFFF)
        self.phases = [self.rng.uniform(0, 2 * math.pi) for _ in range(4)]
        self.reset()

    def reset(self) -> None:
        self.t = 0.0
        self.wind = [0.0, 0.0]
        self.log_scint = 0.0
        self.aoa = [0.0, 0.0]
        self.drift = [0.0, 0.0]
        self.drift_vel = [0.0, 0.0]

    def step(self, dt: float, c: dict, ifov: float) -> DisturbanceState:
        self.t += dt
        t, r = self.t, self.rng
        vib = c["vibrationPx"] * ifov
        w = 2 * math.pi * c["vibrationHz"]
        ph = self.phases
        dpan = vib * (0.7 * math.sin(w * t + ph[0]) + 0.3 * math.sin(1.73 * w * t + ph[1]))
        dtilt = vib * (0.7 * math.sin(1.11 * w * t + ph[2]) + 0.3 * math.sin(2.07 * w * t + ph[3]))
        dpan += r.uniform(-1, 1) * c["jitterPx"] * ifov
        dtilt += r.uniform(-1, 1) * c["jitterPx"] * ifov
        A = c["platformMotionPx"] * ifov
        pm = c["platformMotion"]
        if pm == "linear":
            tri = 2 * abs(((t / 10) % 1) * 2 - 1) - 1
            dpan += A * tri
            dtilt += 0.4 * A * tri
        elif pm == "circular":
            dpan += A * math.cos(2 * math.pi * t / 8)
            dtilt += A * math.sin(2 * math.pi * t / 8)
        elif pm == "random":
            for i in range(2):
                self.drift_vel[i] = 0.97 * self.drift_vel[i] + 0.25 * A * r.gauss() * math.sqrt(dt)
                self.drift[i] = max(-A, min(A, self.drift[i] + self.drift_vel[i]))
            dpan += self.drift[0]
            dtilt += self.drift[1]
        aw = math.exp(-dt / 1.5)
        sw = c["windDegS"] * math.sqrt(1 - aw * aw)
        self.wind = [aw * self.wind[0] + sw * r.gauss(), aw * self.wind[1] + sw * r.gauss()]
        sig = 0.55 * c["turbulence"]
        a_s = math.exp(-dt / 0.05)
        self.log_scint = a_s * self.log_scint + sig * math.sqrt(1 - a_s * a_s) * r.gauss()
        scint = math.exp(self.log_scint - sig * sig / 2)
        aa = math.exp(-dt / 0.1)
        sa = 2.5 * c["turbulence"] * math.sqrt(1 - aa * aa)
        self.aoa = [aa * self.aoa[0] + sa * r.gauss(), aa * self.aoa[1] + sa * r.gauss()]
        atm = atmosphere_effect(c["atmosphere"], c["atmosphereStrength"])
        period = c.get("occlusionPeriodS", 0) or 0
        occluded = period > 0 and (t % period) >= period - min(c.get("occlusionDurS", 1), period * 0.9)
        dropout = r.next() < min(0.98, c["dropoutProb"] + atm.extra_dropout)
        dropout = occluded or dropout
        return DisturbanceState(dpan, dtilt, self.wind[0], self.wind[1], scint, self.aoa[0], self.aoa[1], dropout, atm, occluded)
