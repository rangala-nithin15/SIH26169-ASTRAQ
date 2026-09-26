# ASTRAQ — Run Guide (v1.1)

## Option 1 — Desktop app (Windows, no install)
Extract `ASTRAQ-Windows-x64.zip` and double-click **`ASTRAQ.exe`**. It runs fully offline.
(Windows SmartScreen may say "unknown publisher" because the app is not code-signed: click *More info ▸ Run anyway*.)

## Option 2 — Browser, fastest developer start (no backend)

```bash
cd astraq-final-project/web
npm install        # first time only
npm run dev
```
Open **http://localhost:5173**. That is all you need for the full demo.
On Windows you can instead double-click `start-web.bat`. On macOS/Linux run `./start-web.sh`.

## Option 3 — With the Python engine (optional)

```bash
cd astraq-final-project/server
python -m venv .venv
.venv\Scripts\activate           # Windows  |  macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt  # first time only
python -m uvicorn app.main:app --reload --port 8000
```
Then in the browser open **Experiment** (flask icon) ▸ **Engine** ▸ **FastAPI server** ▸ **Connect**. API docs: http://localhost:8000/docs.

Command-line extras (venv active):
```bash
python scripts/run_batch.py occlusion 20 15                       # Monte-Carlo incl. re-acquisition stats
python scripts/make_test_video.py test.mp4 8                      # 640×480 video + test_truth.csv
python scripts/make_test_video.py big.mp4 6 --size 2000 --sp 0.01 --outage 3:3.6   # full-screen video
curl -F file=@test.mp4 -F truth=@test_truth.csv http://localhost:8000/api/video/analyze
python scripts/ablation.py                                        # Kalman / feed-forward ablation
```

## Rebuilding the desktop app
```bash
cd astraq-final-project/web && npm install && npm run build
cd ../desktop && npm install
npm run package:win      # → desktop/release/ASTRAQ-win32-x64/ASTRAQ.exe
npm start                # run it without packaging
```

## 4-minute judge demonstration

| When | Do | Say |
|---|---|---|
| 0:00 | App open in **Overview** | "A transportable optical ground station must point its laser link at a satellite. Before the fine laser stage, a camera has to find the satellite's red beacon and steer the gimbal onto it. That is coarse alignment, and ASTRAQ simulates it end to end." |
| 0:20 | Press **R** and watch the state badge | "Random start in a 12.5° field. The camera scans wide, **detects**, zooms to 4° and **locks** in about 1.1 s." |
| 0:40 | Point at the **sensor panel** | "This is the real 640×480 image the detector processes. The box is the detection, the cross is the centroid, the diamond is the Kalman prediction. Every bright spot is checked by our trained **AI verifier** before it is accepted." |
| 1:00 | Press **2** (Terminal), zoom with the wheel | "The terminal: a 6×6 truck with an optical shelter whose roof opens, a pier, and a pan/tilt gimbal carrying the telescope and camera. It is moving right now." |
| 1:15 | Press **3** (Spacecraft) | "The satellite: solar wings tracking the Sun, and the red beacon. The red line is the laser link." |
| 1:30 | Scenario ▸ **Occlusion & Reacquisition** | "Every 6 s the beacon is blocked for 1 s. The tracker follows its prediction and re-locks **0.03 s** after the beacon returns." |
| 2:00 | Press **A** (analysis) | "Live graphs and the PS acceptance card: acquisition, error, loss, re-acquisition, FPS — measured against ground truth." |
| 2:20 | Press **V** (video benchmark) ▸ **Built-in 2000×2000 stream** ▸ Run | "The PS also asks to bypass the camera with a video. Here is a full-screen 2000×2000 stream with salt & pepper noise and an outage: sub-pixel centroid error, re-acquisition after the outage. Judges can upload their own MP4." |
| 3:00 | Press **P** | "One click produces the performance report the PS asks for — HTML or Markdown." |
| 3:15 | Press **G**, then **T** | "The screen view on a 2000×2000 display plane, and themes — Daylight is best on a projector." |
| 3:25 | Press **3**, drag and scroll; then **F**, then **1** | "You can walk around our satellite — the camera travels with it at 7.5 km/s. Around the link is real traffic: the ISS and other satellites at true orbital speed. It is visual only; it never enters the camera image or the numbers." |
| 3:40 | Open **Experiment** | "Record, export CSV/JSON, replay, batch over many seeds. The same engine also runs in Python behind FastAPI." |

## Keyboard

`Space` run/pause · `R` reset · `D` demo · `1–5` views · `S` enlarge sensor · `G` screen view · `A` analysis · `V` video benchmark · `P` report · `T` theme · `+`/`−` zoom · `F` fly to ISS / SAT-2 / SAT-3 · `M` manual gimbal (arrows jog) · `?` help · `Esc` close

## If something goes wrong

See **docs/DETAILED_GUIDE.md — Troubleshooting**. Most common: `npm` not found (install Node.js 20+ and reopen the terminal); black 3D view (wait 5 s; at High, ASTRAQ now steps down automatically if the graphics card cannot draw it — otherwise choose View ▸ Render quality ▸ Medium or Low, or enable hardware acceleration); an MP4 that will not play in the browser (use Chrome/Edge, or analyse it on the Python server).
