"""Learned beacon verifier (mirror of web/src/core/detection/verifier.ts).

A small MLP (11 -> 16 -> 8 -> 1) that scores each candidate blob of the classical
detector with the probability that it is the beacon. The weights are the same JSON
file the browser engine uses (trained by web/scripts/verifier/train.py).
"""
from __future__ import annotations

import json
import math
import os

_PATH = os.path.join(os.path.dirname(__file__), "verifier_weights.json")
with open(_PATH) as _f:
    VERIFIER: dict = json.load(_f)


def candidate_features(*, area, exp_area, snr, bw, bh, mean_raw, raw_peak, median, sigma, sat, expected_size_px, ring, spread) -> list[float]:
    contrast = max(1e-3, raw_peak - median)
    return [
        math.log(area / exp_area),
        math.log(max(1.0, snr)),
        math.log((bw * bh) / area),
        abs(math.log(bw / bh)),
        max(-1.0, min(2.0, (mean_raw - median) / contrast)),
        sat,
        math.log(max(1.0, expected_size_px)),
        max(-5.0, min(60.0, (ring - median) / sigma)) / 10,
        math.log(sigma),
        contrast / 255,
        spread / math.sqrt(area),
    ]


def verifier_probability(f: list[float], W: dict = VERIFIER) -> float:
    h = [(v - m) / (s or 1) for v, m, s in zip(f, W["mean"], W["std"])]
    layers = W["layers"]
    for li, L in enumerate(layers):
        out = []
        for row, b in zip(L["w"], L["b"]):
            z = b + sum(wi * hi for wi, hi in zip(row, h))
            out.append(z if li == len(layers) - 1 else math.tanh(z))
        h = out
    return 1 / (1 + math.exp(-h[0]))
