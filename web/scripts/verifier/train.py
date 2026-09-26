"""Train the learned beacon verifier (MLP 11-16-8-1) on candidates from gen-data.ts.

Usage: python train.py train.csv test.csv out_weights.json
Prints candidate-level AUC and frame-level detection/false-detection rates against the
hand-tuned confidence score, per condition group, and writes the weights JSON used by
both engines.
"""
import json
import sys
from collections import defaultdict

import numpy as np

rng = np.random.default_rng(7)


def load(path):
    import csv
    X, conf, y, frame, group = [], [], [], [], []
    with open(path) as f:
        r = csv.DictReader(f)
        for row in r:
            X.append([float(row[f"f{i}"]) for i in range(11)])
            conf.append(float(row["conf"]))
            y.append(int(row["label"]))
            frame.append(int(row["frame"]))
            group.append(row["group"])
    return np.array(X), np.array(conf), np.array(y), np.array(frame), np.array(group)


def auc(score, y):
    order = np.argsort(score)
    ranks = np.empty(len(score))
    ranks[order] = np.arange(1, len(score) + 1)
    pos = y == 1
    n1, n0 = pos.sum(), (~pos).sum()
    return (ranks[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def init(sizes):
    L = []
    for a, b in zip(sizes[:-1], sizes[1:]):
        L.append([rng.normal(0, np.sqrt(1 / a), (b, a)), np.zeros(b)])
    return L


def forward(L, X):
    hs = [X]
    h = X
    for i, (W, b) in enumerate(L):
        z = h @ W.T + b
        h = z if i == len(L) - 1 else np.tanh(z)
        hs.append(h)
    return hs


def train(X, y, epochs=60, lr=3e-3, bs=512, wd=1e-4):
    L = init([X.shape[1], 16, 8, 1])
    m = [[np.zeros_like(W), np.zeros_like(b)] for W, b in L]
    v = [[np.zeros_like(W), np.zeros_like(b)] for W, b in L]
    pw = (y == 0).sum() / max(1, (y == 1).sum())
    pw = min(pw, 8.0)
    t = 0
    for ep in range(epochs):
        idx = rng.permutation(len(X))
        for s in range(0, len(X), bs):
            j = idx[s : s + bs]
            hs = forward(L, X[j])
            logit = hs[-1][:, 0]
            p = 1 / (1 + np.exp(-logit))
            w = np.where(y[j] == 1, pw, 1.0)
            g = (w * (p - y[j]))[:, None] / len(j)
            t += 1
            for i in range(len(L) - 1, -1, -1):
                W, b = L[i]
                gW = g.T @ hs[i] + wd * W
                gb = g.sum(0)
                if i > 0:
                    g = (g @ W) * (1 - hs[i] ** 2)
                for k, gr in enumerate((gW, gb)):
                    m[i][k] = 0.9 * m[i][k] + 0.1 * gr
                    v[i][k] = 0.999 * v[i][k] + 0.001 * gr * gr
                    mh = m[i][k] / (1 - 0.9**t)
                    vh = v[i][k] / (1 - 0.999**t)
                    L[i][k] = L[i][k] - lr * mh / (np.sqrt(vh) + 1e-8)
        if ep in (10, 30):
            lr *= 0.5
    return L


def predict(L, X):
    return 1 / (1 + np.exp(-forward(L, X)[-1][:, 0]))


def frame_eval(score, y, frame, group, thr, snr_min=None, feat=None):
    """Per frame: pick the best-scoring candidate; count correct and false detections."""
    by = defaultdict(list)
    for i, fr in enumerate(frame):
        by[fr].append(i)
    stats = defaultdict(lambda: [0, 0, 0, 0])  # frames with beacon, correct, frames, false
    for fr, ids in by.items():
        ids = np.array(ids)
        if snr_min is not None:
            ids = ids[np.exp(feat[ids, 1]) >= snr_min]
        g = group[by[fr][0]]
        has = bool(y[by[fr]].sum() > 0)
        st = stats[g]
        stats["ALL"][2] += 1
        st[2] += 1
        if has:
            st[0] += 1
            stats["ALL"][0] += 1
        if len(ids) == 0:
            continue
        k = ids[np.argmax(score[ids])]
        if score[k] < thr:
            continue
        if y[k] == 1:
            st[1] += 1
            stats["ALL"][1] += 1
        else:
            st[3] += 1
            stats["ALL"][3] += 1
    return stats


def main():
    tr, te, out = sys.argv[1], sys.argv[2], sys.argv[3]
    X, conf, y, fr, gr = load(tr)
    Xt, conft, yt, frt, grt = load(te)
    mu = X.mean(0)
    sd = X.std(0) + 1e-6
    Xn, Xtn = (X - mu) / sd, (Xt - mu) / sd
    print(f"train candidates {len(y)} (beacon {y.sum()}), test {len(yt)} (beacon {yt.sum()})")
    L = train(Xn, y)
    p = predict(L, Xtn)
    print(f"candidate AUC  hand-tuned confidence {auc(conft, yt):.4f}   learned verifier {auc(p, yt):.4f}")
    # Frame-level comparison at each method's operating point.
    base = frame_eval(conft, yt, frt, grt, 0.35, snr_min=None)
    k5 = frame_eval(conft, yt, frt, grt, 0.35, snr_min=5.0, feat=Xt)["ALL"]
    print(f"hand-tuned at the deployed 5-sigma threshold: Pd {100*k5[1]/k5[0]:.1f}%  FA {100*k5[3]/k5[2]:.2f}%")
    best = None
    for thr in np.arange(0.3, 0.96, 0.05):
        s = frame_eval(p, yt, frt, grt, thr)["ALL"]
        fa = s[3] / s[2]
        if fa <= base["ALL"][3] / base["ALL"][2] and (best is None or s[1] > best[1][1]):
            best = (thr, s)
    thr = float(best[0]) if best else 0.5
    ver = frame_eval(p, yt, frt, grt, thr)
    rows = []
    print(f"\noperating point p >= {thr:.2f}")
    print(f"{'condition':28s} {'frames':>6s} {'Pd hand':>8s} {'Pd MLP':>8s} {'FA hand':>8s} {'FA MLP':>8s}")
    for g in sorted(base.keys()):
        b, v = base[g], ver[g]
        pd_b = b[1] / b[0] if b[0] else float("nan")
        pd_v = v[1] / v[0] if v[0] else float("nan")
        print(f"{g:28s} {b[2]:6d} {100*pd_b:7.1f}% {100*pd_v:7.1f}% {100*b[3]/b[2]:7.2f}% {100*v[3]/v[2]:7.2f}%")
        rows.append((g, b, v))
    A = ver["ALL"]
    B = base["ALL"]
    wts = {
        "version": 1,
        "trained": True,
        "features": ["log_area_ratio", "log_snr", "log_fill", "abs_log_aspect", "flatness", "saturation", "log_expected_size", "ring_contrast", "log_sigma", "contrast", "spread"],
        "mean": [round(float(x), 6) for x in mu],
        "std": [round(float(x), 6) for x in sd],
        "layers": [{"w": [[round(float(x), 6) for x in r] for r in W], "b": [round(float(x), 6) for x in b]} for W, b in L],
        "threshold": round(thr, 3),
        "segmentSigma": 4.0,
        "metrics": {
            "trainCandidates": int(len(y)),
            "testCandidates": int(len(yt)),
            "aucHand": round(float(auc(conft, yt)), 4),
            "aucMlp": round(float(auc(p, yt)), 4),
            "pdHand": round(B[1] / B[0], 4),
            "pdMlp": round(A[1] / A[0], 4),
            "faHand": round(B[3] / B[2], 4),
            "faMlp": round(A[3] / A[2], 4),
            "pdHand5sigma": round(k5[1] / k5[0], 4),
            "faHand5sigma": round(k5[3] / k5[2], 4),
        },
    }
    json.dump(wts, open(out, "w"))
    print("\nweights ->", out, wts["metrics"])


if __name__ == "__main__":
    main()
