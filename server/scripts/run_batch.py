"""Headless Monte-Carlo batch from the command line.

Usage (from server/):  python scripts/run_batch.py [preset] [runs] [seconds]
Example:               python scripts/run_batch.py ps-baseline 20 15
"""
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from astraq_engine import SimulationEngine, merge, preset_config  # noqa: E402

preset = sys.argv[1] if len(sys.argv) > 1 else "open-sky"
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 10
secs = float(sys.argv[3]) if len(sys.argv) > 3 else 15
cfg = preset_config(preset)
print(f"preset={preset} runs={runs} duration={secs}s")
print("seed  state     acq_s  rms_px  loss_%  losses reacq_mean_s reacq_max_s")
acq, rms, reacq, losses = [], [], [], 0
for r in range(runs):
    e = SimulationEngine(merge(cfg, {"seed": 1000 + r}))
    e.render_always = False
    e.start()
    for _ in range(int(secs * 30)):
        s = e.step()
    m = s["metrics"]
    if m["acquisitionS"] is not None:
        acq.append(m["acquisitionS"])
    if m["errRmsPx"] is not None:
        rms.append(m["errRmsPx"])
    losses += m["lossEvents"]
    reacq += e.metrics.reacq
    f = lambda v, d=2: "   -  " if v is None else f"{v:6.{d}f}"  # noqa: E731
    print(f"{1000 + r:5d} {s['state']:9s} {f(m['acquisitionS'])} {f(m['errRmsPx'])} {f(m['lossPct'])} {m['lossEvents']:6d} {f(m['reacqMeanS'])}      {f(m['reacqMaxS'])}")
print(f"locked {len(acq)}/{runs}; acquisition mean {statistics.mean(acq) if acq else float('nan'):.2f} s, max {max(acq) if acq else float('nan'):.2f} s; RMS error mean {statistics.mean(rms) if rms else float('nan'):.2f} px")
if reacq:
    print(f"re-acquisition: {len(reacq)} events after {losses} losses; mean {statistics.mean(reacq):.2f} s, max {max(reacq):.2f} s, "
          f"{100 * sum(1 for x in reacq if x <= 1) / len(reacq):.0f}% within 1 s")
