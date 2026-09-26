# ASTRAQ — Test Report (final)

Environment: Linux x86-64 · Node.js 22.22 · npm 10.9 · Python 3.11.15 · Chromium 141 (headless, SwiftShader software WebGL) · 2026-09-25.
Every number below comes from commands run on the delivered code. Raw outputs are in `docs/test-results/`.

## 1. Build and static checks

| Check | Command | Result |
|---|---|---|
| Dependency installation | `cd web && npm install` · `pip install -r server/requirements.txt` | ✅ 0 npm vulnerabilities; all Python packages installed |
| TypeScript compilation | `npm run typecheck` (`tsc -b`, strict) | ✅ 0 errors |
| Lint | `npm run lint` (ESLint 9 + typescript-eslint + react-hooks) | ✅ 0 problems |
| Production build | `npm run build` | ✅ app 1.55 MB (437 kB gzip), coastline data 546 kB (lazy-loaded), engine worker 58 kB, batch worker 57 kB |
| Backend import / startup | `python -m uvicorn app.main:app --port 8000`, then `GET /api/health` | ✅ `{"ok":true,"engine":"astraq-python","video":true}` |
| Frontend startup | `npm run dev` / `npm run preview` in headless Chromium | ✅ scene loads, engine starts, state LOCKED |
| Desktop app (Linux build) | `desktop/release/ASTRAQ-linux-x64/ASTRAQ` | ✅ window opens, engine reaches LOCKED, no network needed |
| Desktop app (Windows build) | `npm run package:win` → `ASTRAQ.exe` | ⚠️ built and packaged; **not executed on Windows** (no Windows machine in the test environment) |

## 2. Automated tests — 103 / 103 passed

### 2.1 Simulation core, TypeScript: `cd web && npm test` → **67 / 67 passed**
| Area | Tests |
|---|---|
| Geometry | az/el and gnomonic round-trips; orbital pass reaches 62° max elevation; LEO speed 7.4–7.7 km/s; slant range |
| Camera | PS intrinsics (640×480, 4°×3°, 0.00625°/px, principal point 320,240); unproject∘project = identity |
| Trajectories | 8 patterns stay inside the field, no jumps > 6°/s; pattern switch without teleport |
| Sensor + detector | sub-pixel centroid (< 0.5 px); detection under PS maxima (10 % salt & pepper, σ = 20); no detection on pure noise |
| **Large frames (new)** | beacon found beneath > 64 noise blobs (strongest kept, not first in raster order); coarse-to-fine search on large frames keeps sub-pixel accuracy |
| **AI verifier (new)** | trained weights and operating point ship with the app; accepts a clean 10 px beacon and rejects single-pixel impulses; probability monotone in the expected direction |
| Kalman | constant-velocity convergence and rate; 2° outlier gated |
| PID / gimbal / search | anti-windup, rate/tilt limits, independent pan and tilt, spiral covers the field |
| State machine | full SEARCHING→…→LOCKED and LOST→REACQUIRING paths |
| Closed loop | 7 trajectories acquire ≤ 2 s, RMS ≤ 10 px; Kalman+FF beats raw; **scheduled occlusion → re-acquired < 1 s after the beacon returns** (new) |
| **Space-traffic orbits (v1.2)** | visual traffic stays at its stated altitude on a circular orbit; moves at the real speed √(μ/r); each pass is centred on the link's line of sight; passes fade at the window ends and not while followed; starting a fly-to does not make the craft jump |
| **Report (new)** | contains every quantity the PS asks for, in JSON, Markdown and HTML; batch aggregation |
| **Video analyzer (new)** | full-screen video with automatic spot size; built-in 2000×2000 stream with salt & pepper; ground-truth CSV parser |

### 2.2 Python engine and API: `cd server && python -m pytest` → **36 / 36 passed**
Same core checks as above, plus REST (health, control, config, presets, recording, CSV/JSON export, batch, sensor PGM), WebSocket telemetry and commands, and:
* **Video**: 640×480 MP4 with truth → > 90 % detection, acquisition < 0.5 s, RMSE < 1.5 px; full-screen video with automatic spot-size estimation.
* **Reports**: live and batch performance reports contain every PS field (plus a unit test of the report builder).
* **Verifier parity**: Python and TypeScript verifiers give the same probabilities on the shared fixture (`tests/fixtures/verifier_fixture.json`); noise rejected, weak beacon kept.
* **Occlusion**: scheduled outages are re-acquired quickly.

## 3. Closed-loop performance — Monte-Carlo batch

`python scripts/run_batch.py <preset> 20 15`: 20 random starts per preset (seeds 1000–1019), 15 s each, image-based detector with the AI verifier on (default), all disturbances as configured.

| Preset | Locked | Acquisition mean / max | RMS pointing error | Re-acquisition (events, max) | Verdict vs PS |
|---|---|---|---|---|---|
| **Open Sky** (default) | 20/20 | **1.13 / 1.50 s** | **2.97 px** | — | ✅ ≤ 2 s, ≤ 10 px |
| **PS Baseline** (4°×3° optics only) | 20/20 | 6.67 / 12.70 s | 2.78 px | — | error ✅; acquisition ≤ 2 s only near centre (full raster of 12.5° with a 4° FOV needs ≈ 11 s at 5°/s) |
| Moving Platform | 20/20 | 1.20 / 1.50 s | 7.02 px | — | ✅ |
| High Jitter (±20 px/frame) | 20/20 | 1.13 / 1.47 s | 17.44 px | — | ✕ error: ±20 px white jitter alone is ≈ 16 px RMS — a physical floor for a coarse gimbal |
| **Weak Beacon** (haze, dim spot, σ = 18) | 20/20 | **1.29 / 1.70 s** | 4.09 px | 8, 0.17 s | ✅ (was 4.03 / 9.30 s before the verifier) |
| Fast Target (1.5°/s) | 20/20 | 1.03 / 2.33 s | 9.79 px | — | ✅ marginal |
| Acquisition Challenge (corner start, rain, 30 % dropouts, decoy) | 20/20 | 3.88 / 4.07 s | 3.08 px | 14, 0.13 s | error ✅ |
| **Occlusion** (1 s outage every 6 s, new) | 20/20 | 1.16 / 1.53 s | 3.73 px | **40, 0.03 s** | ✅ 100 % re-acquired within 1 s; loss 0 % over visible frames |
| LEO Pass (550 km, 62°, 2.5 s ephemeris error) | 20/20 | 0.99 / 1.00 s | 2.86 px | — | ✅ |

Re-acquisition time is measured from the moment the beacon becomes visible again to the next confirmed track. Loss and retention count only frames where the beacon is actually visible, so a scheduled outage is not counted as a tracking failure.

## 4. AI beacon verifier (learned candidate classifier)

A small MLP (11 → 16 → 8 → 1) scores every detected blob with 11 physically meaningful features (size vs expected size, SNR, fill, aspect, flatness, saturation, ring contrast, blur width, contrast, spread). Trained offline on simulated frames (`web/scripts/verifier/`), weights shipped as JSON and run identically in TypeScript and Python.

### 4.1 Offline evaluation — `docs/test-results/verifier_offline_eval.txt`
3,879 held-out frames (109,230 candidates) across 5 atmospheres × 2 FOVs × with/without decoy:

| Metric | Hand-tuned confidence | AI verifier |
|---|---|---|
| Candidate ROC AUC | 0.9817 | **0.9997** |
| Frame detection rate (Pd) | 89.9 % | **98.7 %** |
| Frames with a wrong detection accepted (FA) | 8.40 % | **0.59 %** |
| Worst condition (fog, wide FOV) Pd | 63.2 % | 88.7 % |

### 4.2 Closed-loop ablation — `docs/test-results/verifier_closed_loop_ablation.txt` (TS engine, 20 seeds × 15 s)

| Preset | Verifier | Locked | Acq. mean / max | RMS | False detections |
|---|---|---|---|---|---|
| Weak Beacon | hand-tuned | 17/20 | 4.61 / 12.80 s | 5.37 px | 66 |
| Weak Beacon | **AI** | **20/20** | **1.36 / 1.83 s** | **4.08 px** | **0** |
| All other presets | hand vs AI | identical | identical | identical | 0 |

The verifier improves the hard case and does not regress any other preset. It is a learned classifier on simulated data — not YOLO and not trained on real sky images (see §9).

## 5. Kalman filter and feed-forward ablation
Python engine, circular / sinusoidal / random targets × seeds 1–3, 15 s (`kalman_ablation.txt`):

| Configuration | Mean RMS pointing error |
|---|---|
| Kalman (az/el) + rate feed-forward (default) | **3.74 px** |
| Kalman, no feed-forward | 12.80 px |
| No Kalman (raw last measurement) | 14.91 px |

## 6. Video benchmark (camera bypassed — PS "upload a video" mode)

| Video | Engine | Detection / retention | Acquisition | Centroid RMSE | Re-acq. after outage | Speed |
|---|---|---|---|---|---|---|
| 640×480 @ 30 fps, σ = 8, MP4 | Python | 100 % | 0.03 s | **0.057 px** | — | 280 fps |
| 2000×2000, 1 % salt & pepper, 0.6 s outage, MP4 | Python | retention 92 % | 0.20 s | **0.121 px** | 0.47 s | 32 fps |
| Built-in 2000×2000 stream (same disturbances) | Browser | retention 92 % | 0.20 s | **0.082 px** | 0.47 s | 30 fps |
| 2000×2000 WebM file uploaded in the browser | Browser (headless) | 97 % detection, 100 % retention | — | — | — | — |

The 92 % retention on the outage videos is exactly the 0.6 s the beacon is hidden plus the re-acquisition interval — during visible frames the lock is not lost.

## 7. UI and 3D verification (headless Chromium, screenshots in `docs/screenshots/`)

| Verified | Result |
|---|---|
| 3D scene, all views (Orbit, Terminal, Sensor, Spacecraft/link, Globe) | ✅ Earth, **6×6 truck with ISO optical shelter (opened roof), pier-mounted telescope**, **satellite with two sun-tracking solar wings**, red beacon and **red laser link** |
| Target moves, gimbal responds, states change, telemetry updates | ✅ |
| Theme switcher (5 themes) — `T` key / palette button / View drawer | ✅ every panel, chart and overlay recolours (screenshots 15, 16) |
| Zoom — wheel (faster dolly, zoom-to-cursor), `+`/`−` keys and buttons | ✅ |
| Screen view (2000×2000 display plane) — `G` | ✅ screenshot 13 |
| Video benchmark panel — `V`: built-in stream, file upload, truth CSV, report | ✅ screenshot 17 |
| Performance report — `P`, after recording, from batch and from video | ✅ HTML and Markdown download |
| Space environment: SAT-2, SAT-3, ISS, meteors, aurora, galaxies; fly-to cameras (`F`) | ✅ screenshots 18–20; 5 unit tests of the orbit maths (altitude, real orbital speed √(μ/r), pass centred on the line of sight, fades, no jump when a fly-to starts) |
| Spacecraft and fly-to views are explorable | ✅ with the mouse: camera idle for 6 s → no movement (distance 0.0211 km, craft fixed on screen); drag → orbits around the craft; scroll → zooms straight in to the minimum distance; the craft stays at the same screen point throughout (screenshot 21) |
| Full UI sweep (views 1–5, fly-to ×3, all 7 drawers, all 9 presets, analysis, screen view, help, themes, report, manual mode, demo, recording, video panel, reset) | ✅ no console errors or warnings from the app |
| **High quality on high-DPI screens** (2× device pixel ratio, 2560×1440 buffer) | ✅ renders with SMAA; no black frame |
| Render guard: automatic step-down | ✅ on software GL, High ran at 0.4 fps → stepped down to Medium with an on-screen notice; no false step-down at Medium |
| Lost WebGL context (forced with `WEBGL_lose_context`) | ✅ 3D view recreated one level lower and rendering again |
| Every button does something; YOLO still shown **disabled / planned** | ✅ |
| Console errors caused by the app | ✅ none in the production build |

## 8. Clean-install check of the delivered ZIP
Extracted into an empty directory:
* `cd web && npm install && npm run build && npm test` → build OK, **67/67**.
* `cd server && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && python -m pytest` → **36/36**.

## 9. Not tested / limitations
* No real GPU in the test environment; rendering checked with software WebGL, so frame rates there are not representative. The original High-quality black screen could not be reproduced on software GL; the fix removes the known driver-specific causes and adds automatic recovery, but it has not been confirmed on the affected laptop.
* Headless Chromium has no H.264 decoder, so MP4 upload in the browser was tested with WebM/VP9. Desktop Chrome and Edge decode H.264 normally; the Python server decodes MP4 in all cases.
* The Windows `.exe` was built but not run on Windows.
* The AI verifier is trained on simulated frames only; it has not seen a real camera.
* Physical hardware (camera, gimbal) and YOLO are not implemented.
