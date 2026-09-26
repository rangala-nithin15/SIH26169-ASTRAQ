"""Kalman / feed-forward ablation (Python engine).

Usage (from server/): python scripts/ablation.py
Circular, sinusoidal and random targets x seeds 1-3, 15 s each; mean RMS pointing error for
(1) Kalman on az/el + rate feed-forward, (2) Kalman without feed-forward, (3) no Kalman.
"""
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from astraq_engine import DEFAULT_CONFIG, SimulationEngine, merge  # noqa: E402

CASES = [("Kalman (az/el) + rate feed-forward", {"kalman": {"enabled": True}, "control": {"feedForward": True}}),
         ("Kalman, no feed-forward", {"kalman": {"enabled": True}, "control": {"feedForward": False}}),
         ("No Kalman (raw last measurement)", {"kalman": {"enabled": False}, "control": {"feedForward": False}})]
print(f"{'configuration':40s} mean RMS px   per run")
for name, patch in CASES:
    rms = []
    for traj in ("circular", "sinusoidal", "random"):
        for seed in (1, 2, 3):
            e = SimulationEngine(merge(DEFAULT_CONFIG, {**patch, "seed": seed, "target": {"trajectory": traj}}))
            e.render_always = False
            e.start()
            for _ in range(450):
                s = e.step()
            rms.append(s["metrics"]["errRmsPx"] or float("nan"))
    print(f"{name:40s} {statistics.mean(rms):8.2f}     {' '.join(f'{x:.1f}' for x in rms)}")
