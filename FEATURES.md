# ASTRAQ — Features

Status legend: **✅ Implemented** (real computation, tested) · **◐ Simplified** (a documented approximation, labelled in the UI) · **○ Planned** (not implemented, shown as "planned" in the UI).

## Requirement coverage

| # | Requirement | Status | Where / notes |
|---|---|---|---|
| 6 | Realistic Earth (day/night, atmosphere, clouds, city lights, grid, site marker) | ✅ | Natural Earth coastlines; procedural biomes; Earth-shadow twilight atmosphere; cloud layer (Medium/High); city lights are **illustrative (procedural)** |
| 6 | Space: star field, brightness range, galactic band, Sun, Moon, flare | ✅ | Shared star catalogue (6,000 stars); Sun sprite with screen-space flare ghosts, hidden when the Earth blocks the Sun; Moon at true distance, ×3 radius |
| 7 | Detailed satellite | ✅ | Bus in crinkled gold MLI, white radiators, two deployable solar-array wings (yoke + 3 hinged panels each, cell grid, frames) on sun-tracking drives, star trackers, thrusters, magnetorquers, GNSS, RF dish, optical head on a coarse-pointing mount that points at the terminal, **red beacon laser**. True-size chase camera in the Spacecraft view |
| 8 | Mobile FSOC ground terminal | ✅ | Transportable optical ground station: 6×6 truck (cab, grille, mirrors, fenders, fuel tank) carrying an ISO-style shelter whose roof opens; equipment racks inside; a pier lifts the azimuth-over-elevation fork mount with the telescope, acquisition camera and **red uplink beacon laser**; stabiliser jacks down, diesel generator with cable, floodlight, traffic cones |
| 9 | Hierarchical pan/tilt gimbal | ✅ | base → north-referenced mount → pan → tilt → payload; independent manual control; limits, rates, commands shown |
| 10 | Virtual optical camera | ✅ | pinhole (fx 9163.6 px @ 4°/640 px, f 45.8 mm @ 5 µm), projection, principal point, IFOV |
| 11 | Camera view | ✅ | the real rendered frame plus reticle, lock/acquisition circles, ROI, detection box, centroid, error vector, Kalman prediction and 3σ ellipse, pixel coordinates, FOV, confidence, state, optional calibration grid and truth marker |
| 12 | Optical beacon & laser link | ✅ | **red** emissive beacon + glow; beacon cone (divergence **exaggerated**, labelled); optical link drawn as a red laser (constant-width core + glow) with moving data pulses when LOCKED |
| 13 | FOV visualisation | ✅ | true-angle frustum to the target range, optical axis, search field, recent scan path; follows zoom |
| 14 | Trajectories | ✅ | stationary, linear, circular, sinusoidal, figure-8, spiral, random (bounded), **custom waypoints (click to draw)**, **LEO pass (real orbit geometry)**; speed, amplitude, period, direction, start |
| 15 | Tracking state machine | ✅ | SEARCHING → DETECTED → ACQUIRING → TRACKING → LOCKED → LOST → REACQUIRING → TRACKING / SEARCHING, driven by observations, with a reason logged for every transition |
| 16 | Modular detection | ✅ | image centroid detector (CV) + **learned beacon verifier (neural network, AI)**, synthetic model; noise, confidence, misses, latency; YOLO ○ planned |
| 17 | Kalman filter | ✅ | az/el constant velocity, gating, adaptive R, toggle; measured, filtered and predicted values displayed |
| 18 | PID alignment | ✅ | Kp/Ki/Kd, integral limit and zone, rate and acceleration limits, angle limits, Kalman feed-forward |
| 19 | Disturbances | ✅ | vibration, jitter (±20 px/frame), platform motion, wind torque, target motion noise, Gaussian/Poisson/salt & pepper noise, atmosphere (clear/haze/fog/rain/low-light), turbulence (scintillation + angle-of-arrival wander), random dropouts, **scheduled cloud outages**, decoy |
| 20 | Coarse-alignment visualisation | ✅ | 7-node alignment chain with live values and an error sparkline |
| 21 | Telemetry | ✅ | target, camera/gimbal and link panels; everything else in drawers |
| 22 | Live graphs | ✅ | one expandable panel: pixel error, angular error, pan/tilt response, target rate, confidence, quality score, with a state band |
| 23 | Experiment mode | ✅ | presets, start/stop/reset, record, CSV + JSON export |
| PS | **Automatic performance report** | ✅ | duration, FPS, acquisition, average / max tracking error, lock retention, loss, re-acquisition, processing time, PS169 pass/fail, configuration, state log — HTML (printable), Markdown, JSON; saved automatically when a recording stops; for live runs, batches and videos; also `GET /api/report` |
| PS | **Benchmark-2 video input (camera bypass)** | ✅ | Video Benchmark panel: MP4/WebM decoded **in the browser** (no server needed) or on the FastAPI server (OpenCV); any size incl. 2000×2000; automatic beacon-size estimate; centroid log CSV; RMSE vs optional ground truth; report; built-in 2000×2000 test stream |
| PS | **2000 × 2000 screen view** | ✅ | Sensor panel ▸ *Screen 2000²*: the PS's own picture — the search field as a 2000×2000 px screen with the moving 640×480 camera window, beacon path, scan path, Kalman estimate |
| PS | **Standalone executable** | ✅ | Windows desktop app (Electron, `ASTRAQ.exe`), no installation of Node/Python/browser needed; build scripts for Windows/Linux/macOS in `desktop/` |
| 24 | Demo mode | ✅ | 90 s, 6 phases, captions |
| 25A | Acquisition probability | ◐ | coverage × detection model with the formula shown; measured rates come from Batch |
| 25B | Link budget preview | ◐ | Gaussian far-field, atmosphere × airmass, receive pointing loss, margin, fine hand-over flag |
| 25C | Alignment Quality Score | ✅ | transparent weighted sum (not AI) |
| 25D | Mission timeline | ✅ | |
| 25E | Replay | ✅ | in-memory or loaded JSON; play, pause, seek |
| 25F | Scenario presets | ✅ | Open Sky, PS169 Baseline, Moving Platform, High Jitter, Weak Beacon, Fast Target, Acquisition Challenge, **Occlusion & Reacquisition**, LEO Pass |
| 25G | Camera calibration view | ✅ | calibration table, pinhole diagram, degree grid on the sensor view |
| 25H | 3D measurement | ✅ | click terminal / spacecraft / Moon / any Earth point: range, az/el, angle off the optical axis, pairwise distance and separation |
| 27 | Quality LOW / MEDIUM / HIGH | ✅ | post-processing, clouds, MSAA, shadows, DPR, texture size, sensor image rate |
| UI | Themes | ✅ | Deep Space, Laser Red, Aurora, Solar Gold, Daylight (light panels for projectors); palette button in the top bar, View drawer, key T |
| UI | Zoom | ✅ | mouse wheel zooms towards the cursor (faster), + / − buttons in the view bar and keys |
| 29 | Provider interfaces | ✅ | `DetectionProvider`, `TelemetryProvider` (Local / Remote / Replay); the camera provider is the renderer seam, and the video path accepts any frame iterator |
| 30 | FastAPI backend + WebSocket | ✅ | status, start, stop, reset, config, presets, telemetry, experiments, batch, video benchmark |

## Additional features

| Feature | Why it matters |
|---|---|
| **Learned beacon verifier (AI)** | A small neural network (MLP 11→16→8→1) re-scores every candidate blob. Trained on 328 k labelled blobs from frames spanning every PS disturbance; on 3,879 held-out frames it finds the beacon in 98.7 % of frames (hand-tuned score 89.9 %) with 0.59 % false detections (8.4 %). Closed loop, Weak Beacon: 20/20 locked in 1.36 s mean instead of 17/20 in 4.61 s, false detections 66 → 0. Never worse on the other presets. |
| **Re-acquisition that follows the prediction** | After a loss the camera keeps following the Kalman prediction (wide view) before spiralling: 1 s cloud outages are re-acquired one frame after the beacon reappears and re-locked in ≈0.3 s. |
| **Wide-field acquisition** (12° scan → 4° track) | The PS-only 4° optics need up to about 11 s to raster the 12.5° field. Wide-field acquisition locks in 1.1 s on average (1.5 s max) over 20 random starts. |
| **Gimbal-independent estimation** (Kalman on az/el) | The velocity estimate becomes rate feed-forward, which cuts the RMS error about 4× (3.7 px vs 14.9 px, see TEST_REPORT). |
| **Explainable state machine** | Every transition says why ("6 consecutive misses (coast limit 5)"). |
| **Spatially consistent confirmation** | Noise blobs cannot confirm a detection. |
| **Adaptive measurement noise** | The filter stays stable under ±20 px/frame jitter instead of rejecting every measurement. |
| **Decoy glint** | Tests data association (gating by prediction). |
| **LEO pass with ephemeris error** | Real orbit geometry at 7.5 km/s, with the search centred on the lagging prediction. |
| **Same engine in TS and Python** | Browser demo with no setup, plus a scriptable server and an identical telemetry schema. |
| **MP4 benchmark path** | Camera-bypass pipeline for recorded video, with a centroid log and an RMSE against optional ground truth. |
| **Batch (Monte-Carlo)** | Acquisition statistics over many seeds, in the UI and on the CLI. |
| **Sensor POV view** | The 3D scene seen through the terminal's telescope, using the camera's true FOV. |

## Not implemented / limitations

* ○ **YOLO / a learned full-frame detector.** An interface and stub exist; no such model is shipped. (The shipped AI component is the learned *verifier* that re-scores candidates found by the classical detector.)
* ○ **Real camera and gimbal hardware.** Simulation only.
* ○ **Fine-pointing stage** (FSM or quad-cell). Only the hand-over criterion is modelled.
* ◐ **Standalone executable:** the Windows desktop app is built and was launch-tested as its Linux twin here; it was not run on a Windows machine in this environment. The optional Python engine is not bundled.
* ◐ The link budget ignores scintillation fade statistics, background radiance and detector noise.
* ◐ Earth rotation is ignored over a run; the Sun, Moon and site are fixed.
* ◐ Terrain colours and night lights are procedural; only the coastlines are real data.
* The Python engine's image noise uses numpy's RNG, so image noise is not bit-identical to the browser engine. The trajectories and stars are.

## Version 1.2 additions

| Feature | Status | Detail |
|---|---|---|
| Space environment | ✅ visual only | SAT-2 (EO, 700 km), SAT-3 (relay, 1,100 km), ISS (420 km), meteors, aurora, Andromeda and Magellanic Clouds; real orbital speed; toggle in View |
| Fly-to cameras | ✅ | `F` key or View ▸ Fly to: camera at true size beside each spacecraft |
| Explorable spacecraft views | ✅ | Spacecraft (3) and Fly-to views: drag to orbit, scroll to zoom; the orbit target travels with the craft (no automatic circling) |
| Main satellite detail | ✅ | SLR retroreflectors, UHF whips, magnetometer boom, sun sensors, X-band horn, ISL optical terminal, flag decal |
| High quality fix | ✅ | SMAA instead of MSAA, pixel budget, render guard (black-frame and low-fps step-down), recovery from lost WebGL context |

## Comparison with the reference project

| Area | Reference (Asteria) | ASTRAQ |
|---|---|---|
| Layout | 10 routed pages, sidebar, stacked cards | one 3D-first screen, drawers on demand |
| Setup | 3 servers + Firebase keys | `npm install && npm run dev` |
| Camera location | on a satellite | on a **mobile ground terminal** with a real gimbal hierarchy |
| Camera view | overlay canvas | the actual rendered sensor frame |
| Estimation | Kalman in pixels | Kalman on az/el with feed-forward and adaptive R |
| Acquisition | expanding sweep at 4° | spiral + wide-field zoom |
| Engine | Python only | TS (browser worker) **and** Python, same schema |
| Replay / batch | reports DB | replay from JSON, Monte-Carlo batch (UI + CLI + API) |
| AI | Gemini chat copilot | trained neural-network beacon verifier inside the detection loop, measured |
