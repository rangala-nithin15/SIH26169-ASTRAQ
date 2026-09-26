"""Generate a synthetic benchmark video with known beacon positions.

Usage (from server/):
    python scripts/make_test_video.py out.mp4 [seconds] [--size 2000x2000] [--noise 12] [--spot 10]
                                       [--sp 0.02] [--outage 4:1] [--h264]
Writes out.mp4 and out_truth.csv (frame,x,y) for the video benchmark (browser panel or
POST /api/video/analyze). --h264 re-encodes with ffmpeg so browsers can decode it.
"""
import argparse
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from astraq_engine.video import synthesize_video  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("out", nargs="?", default="astraq_test.mp4")
ap.add_argument("seconds", nargs="?", type=float, default=8.0)
ap.add_argument("--size", default="640x480")
ap.add_argument("--noise", type=float, default=8.0)
ap.add_argument("--spot", type=int, default=10)
ap.add_argument("--sp", type=float, default=0.0, help="salt & pepper fraction")
ap.add_argument("--outage", default=None, help="start:duration in seconds")
ap.add_argument("--h264", action="store_true")
a = ap.parse_args()
w, h = (int(v) for v in a.size.lower().split("x"))
outage = tuple(float(v) for v in a.outage.split(":")) if a.outage else None
raw = a.out if not a.h264 else a.out + ".mp4v.mp4"
truth = synthesize_video(raw, seconds=a.seconds, size=(w, h), noise=a.noise, spot=a.spot, salt_pepper=a.sp, outage=outage)
if a.h264:
    ff = shutil.which("ffmpeg")
    if not ff:
        sys.exit("ffmpeg not found; install it or drop --h264")
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", a.out], check=True)
    os.remove(raw)
tpath = os.path.splitext(a.out)[0] + "_truth.csv"
with open(tpath, "w") as f:
    f.write(truth)
print(f"wrote {a.out} ({w}x{h}) and {tpath}")
