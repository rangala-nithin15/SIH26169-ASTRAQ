"""Evaluate the shipped verifier weights on a held-out candidate set (from gen-data.ts).

Usage: python evaluate.py test.csv ../../src/core/detection/verifier_weights.json
"""
import json
import sys

import numpy as np

import train as T

X, conf, y, fr, gr = T.load(sys.argv[1])
w = json.load(open(sys.argv[2]))
L = [[np.array(l["w"]), np.array(l["b"])] for l in w["layers"]]
p = T.predict(L, (X - np.array(w["mean"])) / np.array(w["std"]))
thr = w["threshold"]
print(f"held-out candidates: {len(y)} ({y.sum()} beacon, {len(y) - y.sum()} other) from {len(set(fr))} frames")
print(f"candidate ROC AUC: hand-tuned confidence {T.auc(conf, y):.4f} | learned verifier {T.auc(p, y):.4f}")
hand = T.frame_eval(conf, y, fr, gr, 0.35)
mlp = T.frame_eval(p, y, fr, gr, thr)
print(f"\nframe-level, operating points: hand-tuned conf >= 0.35 | verifier p >= {thr}")
print(f"{'condition (atmosphere | FOV | decoy)':38s} {'frames':>6s} {'Pd hand':>8s} {'Pd AI':>8s} {'FA hand':>8s} {'FA AI':>8s}")
for g in sorted(hand):
    b, v = hand[g], mlp[g]
    pdb = 100 * b[1] / b[0] if b[0] else float("nan")
    pdv = 100 * v[1] / v[0] if v[0] else float("nan")
    print(f"{g:38s} {b[2]:6d} {pdb:7.1f}% {pdv:7.1f}% {100 * b[3] / b[2]:7.2f}% {100 * v[3] / v[2]:7.2f}%")
print("\nPd = beacon correctly detected (frames where it is visible); FA = frames with a wrong detection accepted.")
