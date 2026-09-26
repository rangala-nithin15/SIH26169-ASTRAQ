# ASTRAQ: Complete Project Knowledge Base
### Source document for generating presentation content (SIH26169)

> **How to use this file.** It holds everything about the project in one place: the problem statement, background, what was built, how it works, every feature, measured results, honest limitations, development history, and a suggested slide outline with speaker notes. Paste it into any AI assistant and ask for slide content. Every number here comes from a real run of the delivered code, unless it is labelled **DERIVED** (arithmetic on problem-statement parameters) or **PS** (written in the problem statement).
>
> **Rules for any AI using this file.** Do not invent results. Do not claim YOLO, a deep CNN, real hardware, or training on real camera footage. None of these exist. The AI that does exist is a small trained neural-network **beacon verifier** (section 0), trained on simulated frames. A Windows desktop app (`ASTRAQ.exe`) exists; it was built but not yet run on a Windows machine by us. Keep "simplified" and "illustrative" labels where they appear.

---

## Table of contents
1. Project identity
2. The problem in plain words
3. Official problem statement (full detail)
4. Background: FSOC and PAT explained
5. Why the problem is hard (derived numbers)
6. Existing solutions and competitor landscape
7. Our solution: ASTRAQ
8. System architecture
9. The tracking pipeline, step by step
10. Algorithms in depth
11. Every feature of the prototype
12. User interface tour
13. Scenario presets and demo mode
14. Backend, API and the video benchmark (Benchmark-2)
15. Tech stack
16. Testing and measured results
17. How ASTRAQ maps to the PS evaluation criteria
18. Innovation and differentiators
19. Honest limitations
20. Future scope and path to hardware
21. Impact and beneficiaries
22. Development history (the build log from our chats)
23. Suggested PPT outline with slide content and speaker notes
24. Likely judge questions with answers
25. Glossary
26. References

---

## 0a. What changed in version 1.2 (final)

| Request | What v1.2 adds |
|---|---|
| More realistic space | **Space environment** (View ▸ Space environment, on by default): SAT-2 (Earth observation, 700 km), SAT-3 (data relay, 1,100 km), the **ISS** (420 km), **meteors** at 90–110 km, **aurora** ovals at both poles, the **Andromeda galaxy** and **Magellanic Clouds** (approximate positions), a richer Milky Way. Traffic moves at real circular-orbit speed √(μ/r) on repeating passes over the link. **Visual only**: nothing here is in the simulated camera image or changes any result. (Debris and asteroids were tried and removed in the final version.) |
| See them up close | **Fly to** buttons and key **F** (ISS, SAT-2, SAT-3), and the **Spacecraft** view for the main satellite: drag to orbit, scroll to zoom; the camera travels with the craft instead of circling automatically. |
| More detail on the main satellite | Laser-ranging retroreflector array, UHF whips, magnetometer boom, sun sensors, X-band horn, a second optical terminal (inter-satellite link) and a flag decal; the Spacecraft view now looks from the sunlit side, and space objects get near-white sunlight instead of the ground's twilight tint. |
| High quality rendered black | Root causes on real GPUs: 4× multisampled half-float post-processing buffers (black on some Intel/AMD drivers) and 2× pixel ratio on high-DPI screens. Fix: SMAA instead of MSAA, a pixel budget, a **render guard** that steps down one level if the picture is black or High runs under 6 fps, and automatic recovery if the graphics driver resets. Verified on software GL at 2× pixel ratio and with a forced context loss; not yet confirmed on the laptop that showed the problem. |

Tests: **67 TypeScript + 36 Python = 103, all passing** (5 tests for the orbit maths of the space traffic).

**If judges ask "are those other satellites part of the simulation?"** — No. They are a visual layer for context (real near-Earth space is busy). The tracking loop only sees the simulated camera image, which contains the beacon, stars, noise and the configured decoy — not this traffic.

## 0. What changed in version 1.1 (read this first)

Version 1.1 closes the gaps we found when we compared v1.0 against the problem statement, and improves the visuals.

| Gap in v1.0 | What v1.1 adds | Measured result |
|---|---|---|
| "AI" was only classical CV + estimation | **AI beacon verifier**: a trained MLP (11 → 16 → 8 → 1, tanh, sigmoid) scores every bright blob using 11 physical features (size vs expected, SNR, fill, aspect, flatness, saturation, ring contrast, blur width, contrast, spread). Trained offline on simulated frames across 5 atmospheres, 2 FOVs, with/without decoys. On by default; can be switched off to compare. Same weights run in TypeScript and Python. | Held-out 3,879 frames: ROC AUC 0.9817 → **0.9997**; detection 89.9 % → **98.7 %**; false detections 8.4 % → **0.59 %**. Closed loop, Weak Beacon: 17/20 locked, 4.61 s mean → **20/20, 1.36 s**, false detections 66 → **0**. No regression on any other preset. |
| No re-acquisition statistics | **Occlusion & Reacquisition** preset (1 s outage every 6 s); re-acquisition measured from the moment the beacon is visible again; loss/retention counted over visible frames only. Tracker follows the Kalman prediction for 1 s before searching and keeps the rate estimate. | 40/40 re-acquisitions, **0.03 s max**; loss 0 % |
| MP4 benchmark only via the API | **Video benchmark panel in the app (V)**: upload MP4/WebM + optional truth CSV, or use a **built-in 2000×2000 full-screen stream** with salt & pepper and an outage. Pyramid (coarse-to-fine) detection for large frames, automatic spot-size estimate, per-frame CSV. | Browser, 2000²: acquisition 0.20 s, RMSE **0.082 px**, 30 fps processing, re-acq 0.47 s. Python, 2000²: RMSE 0.121 px, 32 fps. Python 640×480: 0.057 px at 280 fps. |
| No automatic performance report | **One-click report (P)** for live runs, recordings, batches and videos, HTML or Markdown, every PS quantity with pass/fail; also `GET /api/report`, `/api/experiments/{id}/report`, `/api/video/{id}/report`. | — |
| No 2D screen view | **Screen view (G)**: the beacon on a 2000×2000 display plane, as in the PS's full-screen benchmark. | — |
| No executable | **Desktop app** (Electron): `ASTRAQ.exe` for Windows, also Linux/macOS builds; fully offline. | Linux build launched and locked; Windows build packaged, not run on Windows. |
| Visual realism | Terminal rebuilt as a **transportable optical ground station**: 6×6 truck carrying an ISO optical shelter whose roof panels open, a pier-mounted fork gimbal with telescope and camera, racks, generator, jacks, floodlights. Satellite rebuilt: gold MLI bus, radiators, two 3-panel **solar wings that track the Sun**. **Red beacon** and **red laser link**. Better lighting. | — |
| Zoom was hard | Faster wheel dolly, **zoom to cursor**, `+`/`−` keys and buttons, closer minimum distance. | — |
| Presentation | **5 colour themes** (Deep Space, Laser Red, Aurora, Solar Gold, Daylight for projectors), key T. | — |

**Is a truck realistic?** Yes. Real transportable optical ground stations are exactly this: Cailabs' TILBA-TOGS is mounted on a skid or in an ISO container with a retractable roof, and DLR's Transportable Optical Ground Station is packed for road transport. v1.1 therefore keeps a truck but gives it an optical shelter instead of a telescopic mast.

Tests (v1.1): **62 TypeScript + 36 Python = 98, all passing.** (v1.2: 102.)

---

## 1. Project identity

| Field | Value |
|---|---|
| Project name | **ASTRAQ**: Autonomous Spatial Tracking & Alignment for Optical Links |
| Problem statement ID | **SIH26169** (also called PS169) |
| PS title | Development of an AI-Based Virtual Camera Tracking System for Coarse Alignment of Mobile Free Space Optical Communication (FSOC) Terminals |
| Organisation | Department of Space / ISRO |
| Category | Software |
| Theme | Smart Automation, Space Technology |
| Event | Smart India Hackathon 2026 |
| Team name / ID | *(fill in: LEXICORE was used on an earlier idea deck; confirm)* |
| One-line pitch | A browser-based 3D mission simulator in which a mobile optical ground terminal finds, locks onto and follows a moving laser beacon on a satellite by itself, using a virtual camera, real image processing, a Kalman filter and a PID-controlled pan/tilt gimbal. |
| Tagline options | "Find it. Lock it. Hold it." · "Coarse alignment you can see." · "From random start to optical lock in about 1.1 seconds." |

---

## 2. The problem in plain words

Laser links (free-space optical communication, FSOC) can move far more data than radio, cannot easily be intercepted, and need no spectrum licence. The catch is that a laser beam is extremely narrow. Two terminals, one on a moving truck and one on a satellite, must point at each other with extreme accuracy while both move and shake.

This is done in stages. First, a **coarse** stage uses a camera to find the other terminal's beacon light and turns a motorised pan/tilt mount until the beacon sits at the centre of the camera image. Only then can a **fine** stage (fast steering mirrors) take over and close the link.

Building and testing coarse-pointing algorithms on real hardware is slow and expensive: you need gimbals, optics, lasers, test ranges and time on a moving platform. ISRO asks for a **virtual** version: software that simulates the scene, the camera, the beacon and all the disturbances, and a tracking system that finds and follows the beacon by itself, measured against strict performance numbers.

**Analogy for slides.** It's like trying to keep a torch spot from a friend on a moving boat centred in a pair of binoculars. You're standing on a shaking truck, it's foggy, and you have two seconds to find it.

---

## 3. Official problem statement (full detail)

### 3.1 Objective (PS)
"Develop a software system that autonomously detects, identifies, and continuously tracks a designated moving target within a virtual scene by controlling a virtual camera viewport."

The coarse stage must observe the surroundings, acquire and detect the remote terminal or beacon, estimate its position, and keep adjusting the pointing direction to maintain visibility.

Expected solution: an AI-assisted camera tracking system that automatically detects and continuously tracks a moving optical beacon in a simulated video stream while controlling a virtual pan-tilt camera.

### 3.2 Mandatory capabilities (PS)
- Generate a configurable virtual environment
- Generate one or more moving targets
- Implement a movable virtual camera
- Detect the beacon automatically
- Track it continuously using computer vision
- Control and reposition the virtual camera
- Introduce disturbances (atmospheric turbulence, platform vibration, camera motion, noise)
- Display tracking performance and statistics in real time

### 3.3 Parameter table (PS)

| # | Parameter | Required value | ASTRAQ default / support |
|---|---|---|---|
| 1 | Screen size (min) | 2000 × 2000 px | Search field 2000 px × 0.00625 °/px = 12.5° (±6.25°) |
| 2 | Camera type | Monochrome focal-plane array | 8-bit monochrome sensor frame |
| 3 | Resolution | 640 × 480 | 640 × 480 (user-adjustable) |
| 4 | Camera FOV | User-defined, default 4° × 3° | 4° × 3° tracking; optional 12° wide-field for acquisition |
| 5 | Camera update | ≥ 30 Hz | 30 Hz |
| 6 | Initial camera position | Centre of screen | Centre of the search field |
| 7 | Target type | Beacon spot | Emissive beacon on the satellite, rendered spot on the sensor |
| 8 | Number of targets | 1 mandatory | 1 beacon, plus an optional decoy glint |
| 9 | Target shape | User-defined, default square | Square (area-exact), disk, Gaussian |
| 10 | Target size | 5–20 px, default 10 × 10 | 10 px default, 5–20 slider |
| 11 | Initial target location | User-defined, default random | Random (seeded) or fixed u/v |
| 12 | Motion | Straight, circular, figure-8, random (mandatory); spiral, sinusoidal, user-defined (optional) | All seven + custom waypoints (click to draw) + real LEO orbital pass |
| 13–14 | Max pan / tilt speed | 5–10 °/s, default 5 | 5 °/s default, slider 1–15 |
| 15 | Control update | ≥ 20 Hz | 60 Hz servo loop |
| 16 | Acquisition time | ≤ 2 s | 1.13 s mean, 1.50 s max (Open Sky, 20 random starts) |
| 17 | Tracking error | ≤ 10 px | 2.97 px RMS (Open Sky) |
| 18 | Target loss | < 5 % | 0 % after lock in 8 of 9 presets; ≤ 1.5 % with 30 % random dropouts |
| 19 | Re-acquisition | ≤ 1 s | Measured live; shown on the acceptance card |
| 20 | Processing speed | ≥ 20 FPS | 30 Hz simulation; detection ≈ 1.5 ms/frame in the browser |
| 21 | Image noise | Salt & pepper (~10 %), Gaussian, Poisson | All three, combinable |
| 22 | Max noise σ | 20 | Gaussian σ 0–20 (grey levels) |
| 23 | Camera jitter | ± 20 px / frame | 0–20 px/frame |
| 24 | Atmosphere | Clear, haze, fog, rain, low light | All five + strength slider + turbulence |
| 25 | Platform motion | ± 20 px / frame; linear mandatory, others optional | Linear, circular, random; amplitude slider |

### 3.4 Deliverables (PS)
- Standalone executable
- Documented, modular, commented source code
- Technical report (10–15 pages): problem understanding, architecture, modules, tracking methods, AI methods if used, test methodology, performance analysis, future improvements
- User manual (installation, operation, parameters, GUI), optional 3–5 minute video
- Automatic performance report: duration, FPS, acquisition time, average and max tracking error, lock retention, processing time

### 3.5 Evaluation scheme (PS)

| Stage | Weight | What is checked |
|---|---|---|
| Functional verification | 20 % | 10–15 min demo; all mandatory functions; operational success; GUI |
| Benchmark-1 | 30 % | Scenarios given by evaluators; execution; **log of centroiding error**; auto-generated logs |
| Benchmark-2 | 30 % | An .mp4 at 30 fps "covering a complete screen with noise and moving beacon spot". The software must **bypass its PTZ camera** and use the video as input. Graded on centroiding error vs predefined values, RMSE, acquisition/re-acquisition time, lock retention, FPS |
| Technical evaluation | 20 % | Problem understanding, architecture, algorithm choice, AI & computer vision, innovation, documentation, Q&A |

### 3.6 Things the PS leaves undefined (we chose and documented an interpretation)
- How "tracking error" is measured. ASTRAQ logs both: pointing error (beacon's true pixel vs image centre) and centroid error (detected vs true pixel).
- When the acquisition clock starts. ASTRAQ starts it at run start and stops it at first LOCKED.
- Whether FOV may change during a run. The PS says FOV is user-defined, so ASTRAQ offers wide-field acquisition as an option. The PS-only 4° mode is also a preset.
- Units of the noise σ. Taken as grey levels (0–255 scale).
- Whether "±20 px/frame" is displacement or a random offset. ASTRAQ implements a uniform random offset per frame.

---

## 4. Background: FSOC and PAT explained

**FSOC (Free-Space Optical Communication).** Data is carried by a laser beam through air or space instead of radio waves.
- Strengths: very high bandwidth, a narrow beam that is hard to intercept, no radio-spectrum licence, small low-power terminals.
- Weakness: the narrow beam has to be pointed extremely accurately (microradians).

**PAT (Pointing, Acquisition and Tracking)** is the process that keeps two optical terminals aimed at each other. It runs in two stages:

| Stage | Sensor | Actuator | Accuracy | Scope |
|---|---|---|---|---|
| **Coarse** (this PS) | Wide-ish camera (degrees of FOV) | Motorised pan/tilt gimbal | Beacon within a few pixels (~0.06°) | ✅ ASTRAQ |
| **Fine** | Quad-cell or fast sensor | Fast steering mirror | Microradians | ❌ Hand-over criterion only |

**Beacon.** A wide, bright laser (often ~976 nm on real systems) that the partner terminal shines so it can be seen by a camera before the narrow data beam is aligned.

**Real precedent.**
- NASA JPL's OPALS on the ISS (2014) used a ground beacon, a wide-field CCD camera and a two-axis gimbal in closed loop. That is exactly the coarse pipeline ASTRAQ simulates, including acquiring with a wide field of view.
- MIT CLICK used a beacon camera plus a MEMS steering mirror for its fine stage.

**Why "mobile".** The ground terminal sits on a truck (or ship, aircraft or UAV). Engine vibration, wind and vehicle motion add disturbance that the tracker must reject.

**Why simulation.** Hardware test campaigns are costly and not repeatable. A simulator with ground truth lets engineers compare algorithms fairly: same seed, same scenario, same numbers.

---

## 5. Why the problem is hard (DERIVED from the PS table)

| Quantity | Value | How it is derived |
|---|---|---|
| Angular size of one pixel | **0.00625 °/px** (109 µrad) | 4° / 640 px |
| Search field | **12.5° × 12.5°** | 2000 px × 0.00625 |
| Chance a random start is already in view | **≈ 7.7 %** | (640 × 480) / (2000 × 2000) |
| Views needed to raster the field at 4° × 3° | **~20** | tiling a 12.5° field |
| Worst-case raster time at 5 °/s | **≈ 11 s** | PS-only optics; far beyond the 2 s target |
| Jitter of ±20 px/frame at 30 Hz | ≈ 3.75 °/s apparent | 20 × 0.00625 × 30 |
| Jitter RMS floor | **≈ 16 px** | Uniform ±20 px has an RMS of 20/√3 ≈ 11.5 px per axis, ≈ 16 px in 2D. No coarse gimbal can remove per-frame random shake it sees a frame late |
| Per-frame compute budget | 50 ms | ≥ 20 FPS |

**Key insight.** With the default 4° × 3° optics, the 2 s acquisition target cannot be met from a random start. The camera cannot even look at the whole field in 2 s. The PS makes FOV user-defined, so ASTRAQ acquires with a **wide 12° field** and then zooms to 4° to track, as OPALS did. Measured result: 1.13 s mean / 1.50 s max, compared with 6.66 s / 12.70 s for 4° only.

---

## 6. Existing solutions and competitor landscape

**General approaches in the literature.**
- Two-stage PAT (gimbal + fast steering mirror)
- Camera + beacon closed-loop coarse tracking
- Wide-then-narrow acquisition
- GPS/IMU open-loop pointing
- Gyro-based line-of-sight stabilisation
- Sub-pixel centroiding (from star trackers)
- IMM/Kalman tracking

**Public SIH26169 repositories** (described from their READMEs) mostly follow one recipe: threshold detection, a pixel-space constant-velocity Kalman filter, PID, disturbance sliders, a web dashboard, and "YOLO ready but untrained". Few ingest MP4 video, and only one or two report measured results. One reports 18.1 px average error on circular motion, which is above the 10 px spec.

**Reference project analysed first (Asteria).** We were given its ZIP, built a feature inventory, and used it **only as a requirements source**. No code, structure, naming, styling or assets were reused.

| Area | Reference (Asteria) | ASTRAQ |
|---|---|---|
| Layout | 10 routed pages, sidebar, stacked cards; 3D gets ~60 % of the screen | One full-screen 3D scene; controls in drawers on demand |
| Setup | 3 servers (Python, Node, Vite) + Firebase login keys | `npm install && npm run dev`. No login, no keys |
| Camera location | On a satellite (does not show the "mobile ground terminal" story) | On a **mobile ground terminal** (truck with optical shelter, pan/tilt gimbal) |
| Camera view | Canvas overlay of pixel positions | The **actual rendered 640×480 sensor frame** that the detector processes |
| Kalman | Pixel space | **Azimuth/elevation** space (gimbal-independent) with rate feed-forward and adaptive noise |
| Acquisition | Expanding sweep at 4° | Square spiral + **wide-field zoom** |
| Engine | Python only | TypeScript (browser worker) **and** Python, same telemetry schema |
| State machine | States only | States **with a logged reason for every transition** |
| Replay / batch | Report database | Replay from JSON; Monte-Carlo batch (UI, CLI, API) |
| Code | 3,278-line Scene3D.tsx, 2,072-line engine.py | Small modules; pure-TS core with 62 unit tests |
| Extras we skipped | Gemini chat copilot, Firebase auth, landing page with heritage-site photos | Not part of the tracking pipeline |

---

## 7. Our solution: ASTRAQ

**What it is.** ASTRAQ is a web-based 3D mission simulator plus a real tracking engine.
- **The scene.** A mobile FSOC ground truck at Bengaluru (13.03° N, 77.51° E) on a realistic Earth, with real Natural Earth coastlines, a twilight atmosphere and stars. The truck carries an ISO optical shelter with an opening roof. It points a telescope and acquisition camera on a pan/tilt gimbal at a LEO satellite (550 km) with sun-tracking solar wings and a red laser beacon.
- **The sensor.** The simulation renders the camera's actual 640×480 image, including noise, stars, fog and rain.
- **The tracker.** A computer-vision detector finds the beacon. A Kalman filter estimates where it is going. A PID controller drives the gimbal. A state machine decides SEARCHING → DETECTED → ACQUIRING → TRACKING → LOCKED, with reasons.
- **Scoring.** Everything is measured against ground truth and shown live on a PS169 acceptance card.

**Three ways to run the same engine.**
1. **Local (default):** a TypeScript engine in a browser Web Worker. It needs nothing installed beyond the website, which is why a hosted link works for judges.
2. **FastAPI server:** a Python/numpy port of the same engine with REST + WebSocket, experiments, batch runs and the **MP4 video benchmark** (Benchmark-2).
3. **Replay:** play back any recorded run.

**Core claims (all measured).**
- Acquisition from a random start: **1.13 s mean, 1.50 s max** (20 seeds)
- Tracking error: **2.97 px RMS** (limit 10)
- Loss after lock: **0 %** in 8 of 9 presets
- Re-acquisition after a 1 s blockage: **0.03 s** (40/40 events)
- AI verifier: detection **98.7 %**, false detections **0.59 %** (vs 89.9 % / 8.4 % hand-tuned)
- Video benchmark centroid accuracy: **0.057 px** (640×480) and **0.08–0.12 px** (2000×2000 with salt & pepper)
- The Kalman + feed-forward design cuts error about **4×** (3.74 px vs 14.91 px without the Kalman filter)
- Tests: **62 + 36 = 98 automated tests pass**

**Honest positioning of "AI".**
- The AI is a **trained neural-network beacon verifier** on top of classical computer vision, plus estimation and control: a robust statistical detector finds candidates, the verifier decides which one is the beacon, an adaptive Kalman filter predicts, and an explainable state machine decides.
- The verifier was trained on simulated frames only. YOLO is **not** trained or shipped; the UI marks it "planned" behind the `DetectionProvider` interface.
- Rationale: for a bright, known-size spot, sub-pixel centroiding is more accurate than bounding-box regression, and centroid error is what both benchmarks grade.

---

## 8. System architecture

### 8.1 Principles
1. **Simulation logic is separate from the UI.** `web/src/core` is pure TypeScript with no DOM, React or three.js. It runs in a Web Worker and in unit tests, and is mirrored module by module in Python.
2. **Rendering is separate from tracking.** The 3D scene only reads telemetry; it never computes tracking.
3. **Backend access is abstracted.** The UI talks to a `TelemetryProvider`, and the Local, Remote (WebSocket) and Replay providers are interchangeable.
4. **Ground truth is quarantined.** Only metrics and the labelled synthetic detector read truth. Detection, estimation, control and decisions use observable data only.

### 8.2 Runtime topology
```
┌──────────────────────────── Browser ────────────────────────────┐
│ React HUD ◀── zustand store ◀── TelemetryProvider               │
│ 3D scene (React Three Fiber) ◀── live buffers                   │
│   LocalEngineProvider  → Web Worker: SimulationEngine @ 30 Hz   │
│   RemoteEngineProvider → WebSocket to FastAPI                   │
│   ReplayProvider       → recorded JSON                          │
│   batch.worker         → headless Monte-Carlo runs              │
└─────────────────────────────────────────────────────────────────┘
┌────────────── FastAPI server (optional) ──────────────┐
│ REST /api/* · WebSocket /ws/telemetry                 │
│ SimulationService: asyncio loop @ 30 Hz, experiments  │
│ astraq_engine: numpy port + video.py (MP4 benchmark)  │
└───────────────────────────────────────────────────────┘
```

### 8.3 Core modules

| Module | Job |
|---|---|
| config | Typed configuration with PS169 defaults, merge and sanitise |
| geometry | Site ENU frame, az/el ↔ direction, gnomonic field coordinates, orbital pass |
| target/trajectory | 9 motion patterns, glide on pattern change (no teleport) |
| optics/camera | Pinhole projection and back-projection |
| optics/sensor | Renders the 8-bit frame: stars, beacon, decoy, rain, noise |
| optics/stars | Seeded 6,000-star catalogue shared by the sky and the sensor |
| detection | `DetectionProvider` interface, centroid detector, synthetic model, registry (YOLO planned) |
| estimation/kalman | Constant-velocity az/el filter with gating and adaptive R |
| control | PID with anti-windup, 2-axis gimbal dynamics, spiral search |
| tracking/supervisor | State machine with reasons |
| disturbance | Vibration, jitter, platform motion, wind, atmosphere, turbulence, dropouts |
| analysis | PS metrics, Alignment Quality Score, link budget, acquisition probability |
| telemetry | Snapshot schema, CSV/JSON recorder |
| demo | 90-second scripted demonstration |
| engine | Orchestrates the closed loop |

### 8.4 Coordinate frames
- The scene uses the site's local East-Up-South frame in kilometres, with the terminal at the origin (floating origin) and Earth's centre at (0, −6371, 0).
- Directions and ranges are true.
- The truck and satellite use labelled **iconic scaling**, so they grow only when a real-size model would be invisible. The Moon is drawn at 3× radius and the beacon cone divergence is exaggerated; both are stated in the UI.
- A logarithmic depth buffer lets centimetre detail and 100,000 km of sky coexist.

---

## 9. The tracking pipeline, step by step (every 1/30 s)

```
world ─▶ sensor image ─▶ detection ─▶ measurement ─▶ Kalman ─▶ PID ─▶ gimbal ─┐
  ▲       (actual axis)   (centroid)   (px → az/el)    (az/el)  (rates)       │
  └─────────────────────────── optical axis moves ◀──────────────────────────┘
```

1. **Control (60 Hz substeps).** The servo loop uses the latest Kalman prediction to command pan/tilt rates. During search, it follows spiral waypoints instead.
2. **World update.** The beacon moves along its trajectory. Platform vibration, wind, turbulence, atmosphere and dropouts are applied.
3. **Capture.** A 640×480 image is rendered from the **actual** optical axis (encoder angle + platform disturbance). The encoders cannot see the disturbance, just like a real system.
4. **Detect.** The selected provider (the centroid detector by default) finds the beacon, with optional latency.
5. **Convert.** The pixel position becomes an absolute azimuth/elevation using the gimbal pose *at the moment of capture*.
6. **Estimate.** The Kalman filter updates, rejects outliers (χ² gate), and predicts position and velocity.
7. **Decide.** The supervisor state machine updates, and every transition logs a reason.
8. **Measure.** Metrics are computed against ground truth. Only this step, and the labelled synthetic detector, sees truth.

**The coarse-alignment chain shown on screen:** Initial error → Detection → Error estimate → Pan/tilt command → Gimbal motion → Pixel error → Optical lock.

---

## 10. Algorithms in depth

### 10.1 Camera model (pinhole)
```
fx = fy = (W/2) / tan(HFOV/2) = 9163.6 px   (640 px, 4°)
u = cx + fx·(d·r)/(d·f)      v = cy − fy·(d·u)/(d·f)
```
- Principal point (320, 240). Square pixels. No roll.
- With a 5 µm pixel pitch the focal length is 45.8 mm, and the IFOV is 0.00625°/px (109 µrad).
- Projection and back-projection are unit-tested as exact inverses.

### 10.2 Sensor image rendering
- **Background.** Sky level plus airlight from the atmosphere setting.
- **Stars.** From the same seeded catalogue as the 3D sky, so the stars in the image match the 3D stars.
- **Beacon spot.** Square (area-exact anti-aliasing), disk (supersampled) or Gaussian; 5–20 px; intensity scaled by atmospheric transmission and scintillation.
- **Optional decoy glint.** A second bright spot, used to test data association.
- **Rain streaks** in rain mode.
- **Noise.** Gaussian (σ ≤ 20), Poisson shot noise, and salt & pepper (≤ 10 %).
- **Atmosphere.** Clear, haze, fog, rain or low light reduce contrast and brightness, with a strength slider.

### 10.3 Beacon detector (real computer vision)
1. **Region of interest.** The full frame while searching; a window around the Kalman prediction while tracking.
2. **Impulse repair.** A pixel that is saturated or black and has fewer than 3 similar 8-neighbours is salt & pepper noise and gets replaced.
3. **3×3 box filter** using an integral image.
4. **Robust background.** Median and MAD (median absolute deviation), then threshold = median + k·σ (k = 5 by default).
5. **Connected components** (4-connected).
6. **Scoring.** Each blob gets a confidence from its size match with the expected spot footprint and its signal-to-noise ratio.
7. **Gating.** While tracking, candidates far from the prediction are rejected, which removes stars and decoys.
8. **Intensity-weighted centroid.** Sub-pixel accurate: about 0.05 px RMS in clear conditions, and under 1.5 px at the PS noise maxima (10 % salt & pepper plus σ = 20).

A **synthetic detector** is also available. It is a clearly labelled statistical model (truth + noise + misses + latency) for studying the control loop on its own.

### 10.4 Kalman filter (azimuth/elevation, constant velocity)
- **Why az/el and not pixels?** Pixels move whenever the gimbal moves. Converting each detection to an absolute direction lets the filter estimate the target's own motion, so its velocity can be fed forward to the controller.
- **State per axis:** [angle, rate]. The process noise is continuous white acceleration q, and the azimuth axis is scaled by 1/cos²(elevation).
- **Adaptive R.** The measurement noise is inflated automatically when the innovations stay larger than expected, for example under heavy jitter. This stops the filter locking itself out.
- **χ² innovation gate** (2 degrees of freedom) rejects outliers.
- **Outputs:** estimate, prediction (bridges misses and latency), velocity (feed-forward), and a 3σ uncertainty ellipse drawn on the sensor view.
- **Defaults:** q = 2, r = 1.5 px, gate = 25.

### 10.5 PID controller
- **Control law:** `rate_cmd = Kp·e + Ki·∫e + Kd·ė + feed-forward (Kalman target rate)`.
- **Defaults:** Kp 8, Ki 1, Kd 0.05, running at 60 Hz.
- **Anti-windup** has three mechanisms:
  1. an integral clamp (limit 0.05);
  2. conditional integration while saturated;
  3. integral separation: integrate only when |e| < 0.1°.
- **Gimbal limits:** rate ±5 °/s (adjustable 1–15), acceleration 30 °/s², tilt −5° to 88°. The rate loop has a 40 ms first-order lag, like real motors.
- Pan error is divided by cos(tilt), which is the correct geometry for an azimuth-over-elevation mount.

### 10.6 Search and acquisition
- **Pattern:** a clamped square spiral over the ±6.25° search field, centred on the predicted line of sight.
- **Wide-field acquisition:** scan at 12° FOV (beacon ≈ 3 px), detect, and stay wide until the estimate is inside half the narrow field. Then zoom to 4° and track.
- **Waypoint tolerance:** min(0.3°, 0.08·FOV). A looser tolerance made waypoints count as reached too early and caused 6.5 s worst-case acquisitions; fixed.

### 10.7 State machine (supervisor)
```
SEARCHING → DETECTED → ACQUIRING → TRACKING → LOCKED
                                      ↑          ↓
             SEARCHING ← REACQUIRING ← LOST ←───┘
```
- **DETECTED** needs M-of-N confirmation (2 of 3) that is also *spatially consistent*, so a single noise hit cannot confirm.
- **LOCKED** needs error < 10 px for 6 consecutive frames. Unlock happens above 15 px (hysteresis).
- **Coasting.** The tracker coasts on prediction for 5 missed frames. After that it goes LOST, then REACQUIRING with a local search around the prediction. After a 3 s timeout it returns to a full SEARCH.
- **Every transition carries a reason**, for example "6 consecutive misses (coast limit 5)".

### 10.8 Metrics
- **PS metrics:** acquisition time, RMS / mean / max pointing error (measured only after first lock, so acquisition transients do not pollute it), loss %, re-acquisition time, FPS, false-detection rate.
- **Alignment Quality Score (AQS):** `AQS = 100 × (0.45·S_err + 0.25·S_conf + 0.30·S_lock)` over a 10 s window.
  - S_err = max(0, 1 − RMS / (2 × lock threshold))
  - S_conf = mean detection confidence
  - S_lock = fraction of frames locked
  - A transparent weighted sum, not AI.

### 10.9 Link budget preview (simplified, labelled)
- Gaussian far-field beam, atmospheric loss × airmass, receiver pointing loss, link margin against sensitivity.
- A fine-stage hand-over flag: is the residual error inside the fine stage's capture angle?
- Adding 6.02 dB of loss per doubling of range is unit-tested.

### 10.10 Acquisition probability (estimate, labelled)
A coverage × detection model with the formula shown. Measured rates come from the Batch tool.

### 10.11 LEO pass
- Circular orbit at 550 km, max elevation 62°, speed about 7.5 km/s (tested between 7.4 and 7.7).
- A 2.5 s ephemeris timing error means the real satellite lags the predicted one, which is exactly why the camera must search.

---

## 11. Every feature of the prototype

Status: ✅ implemented and tested · ◐ simplified (labelled) · ○ planned (not built).

| Feature | Status | Detail |
|---|---|---|
| Realistic Earth | ✅ | Natural Earth coastlines; procedural terrain colours; Earth-shadow twilight atmosphere; clouds (Medium/High quality); illustrative city lights; lat/long grid; site marker |
| Space scene | ✅ | 6,000 stars, galactic band, Sun with lens flare (hidden when Earth blocks it), Moon at true distance |
| Detailed satellite | ✅ | Gold MLI bus, radiators, two 3-panel solar wings on yokes that track the Sun, optical head, **red beacon** with halo |
| Mobile ground terminal | ✅ | 6×6 truck, cab, ISO optical shelter with opened roof panels, equipment racks, pier, fork pan/tilt gimbal, telescope, acquisition camera, generator, outrigger jacks, floodlights, cones |
| Hierarchical gimbal | ✅ | base → mount → pan → tilt → payload; independent manual control |
| Virtual camera | ✅ | Pinhole model, calibration table and diagram |
| Live sensor view | ✅ | The real rendered frame, plus reticle, lock circle, ROI, detection box, centroid, error vector, Kalman prediction and 3σ ellipse, confidence, state, calibration grid, optional truth marker |
| FOV visualisation | ✅ | True-angle frustum, optical axis, search field, scan path |
| Trajectories | ✅ | Stationary, linear, circular, sinusoidal, figure-8, spiral, random, custom waypoints (click to draw), LEO pass |
| Detection | ✅ | Centroid CV detector + **AI verifier** (trained MLP), pyramid search for large frames, synthetic model; ○ YOLO planned |
| Kalman filter | ✅ | Toggle; measured, filtered and predicted values shown |
| PID | ✅ | All gains live-editable, anti-windup, feed-forward toggle |
| Disturbances | ✅ | Vibration, jitter, platform motion, wind torque, target motion noise, 3 noise types, 5 atmospheres, turbulence, dropouts, decoy |
| State machine | ✅ | 8 states with reasons; editable thresholds |
| Alignment chain | ✅ | 7 live nodes with an error sparkline |
| Live graphs | ✅ | Pixel error, angular error, pan/tilt response, target rate, confidence, quality score, with a state band |
| PS169 acceptance card | ✅ | Live pass/fail against each spec |
| Mission timeline | ✅ | Time each stage was first reached |
| Experiment recording | ✅ | Record, CSV and JSON export |
| Replay | ✅ | Play, pause, seek; load a saved JSON |
| Batch Monte-Carlo | ✅ | N seeds in a background worker |
| Demo mode | ✅ | 90 s, 6 phases, captions |
| 9 scenario presets | ✅ | See section 13 (incl. Occlusion & Reacquisition) |
| 5 camera views | ✅ | Overview, Terminal, Spacecraft, Sensor POV, Orbit |
| 3D measurement tool | ✅ | Range, az/el, angle from the optical axis, pairwise distance |
| Link budget | ◐ | Simplified model |
| Acquisition probability | ◐ | Estimate |
| Alignment Quality Score | ✅ | Transparent formula |
| Quality levels | ✅ | Low / Medium / High |
| Manual gimbal mode | ✅ | Arrow keys jog 0.1° (Shift: 1°) |
| FastAPI backend | ✅ | REST + WebSocket |
| Video benchmark | ✅ | In the app (V) and via API; MP4/WebM upload, built-in 2000×2000 stream, centroid log, RMSE, re-acquisition |
| Performance report | ✅ | One click (P): HTML/Markdown for live, recording, batch, video |
| Screen view | ✅ | 2000×2000 display plane (G) |
| Themes | ✅ | 5 themes (T) |
| Red laser link | ✅ | Red beam, beacon cone and pulses |
| YOLO detector | ○ | Interface + stub only |
| Real hardware | ○ | Simulation only |
| Fine-pointing stage | ○ | Hand-over criterion only |
| Desktop app (.exe) | ✅ | Electron; Windows build packaged (not run on Windows by us), Linux build tested |

---

## 12. User interface tour

The screen is **3D-first**: the scene fills the window and everything else floats on top.

| Area | What it shows |
|---|---|
| **Top bar** | ASTRAQ logo; state badge (SEARCHING / LOCKED …); mission clock T+; engine source chip ("Local engine 30 fps" / "FastAPI engine"); view switcher (Overview · Terminal · Spacecraft · Sensor POV · Orbit); Run/Pause, Reset, Record, Run demo, Help |
| **Left tool rail** | 8 icons that open drawers: Scenario, Target, Disturbances, Tracking, Optics & link, Experiment, View, Measure |
| **Sensor panel** (top right) | The live 640×480 camera image with overlays and the mission timeline; expand with S |
| **Bottom dock** | Alignment chain with live values; Target, Camera/gimbal and Link readouts; error sparkline |
| **Analysis panel** (A) | 6 live graph tabs and the PS169 acceptance card |
| **Demo caption** | Phase title and explanation during demo mode |
| **Help overlay** (?) | All shortcuts |

**Drawers and their sections**
- **Scenario:** Scenario presets; Run (seed, time scale); Geometry (site, remote type LEO/HAPS/UAV, satellite altitude, max pass elevation, ephemeris error, predicted line-of-sight az/el, sun az/el).
- **Target:** Trajectory (pattern, speed, amplitude, period, direction); Start position (random or fixed u/v); Beacon spot (shape, size, intensity).
- **Disturbances:** Atmosphere (type, strength, turbulence); Sensor noise (Gaussian σ, salt & pepper, Poisson); Platform & gimbal (vibration amplitude and frequency, jitter, platform motion, wind torque); Target & detection (target motion noise, dropouts, decoy).
- **Tracking:** Pointing mode (auto / manual); Detection provider (centroid / synthetic / YOLO planned; threshold, min confidence, gate, latency, centroid noise, miss probability); Kalman filter (enable, q, r, gate); PID (Kp, Ki, Kd, integral limit, feed-forward, control rate); Gimbal limits (max rate, acceleration, tilt max); State machine thresholds (lock threshold, frames to lock, coast frames, reacquisition timeout).
- **Optics & link:** Camera calibration (table and pinhole diagram); Camera (resolution, HFOV, frame rate, wide-field acquisition, acquisition FOV, zoom rate); Acquisition probability; Link budget (transmit power, divergence, receiver aperture, sensitivity, fine-stage capture).
- **Experiment:** Engine (Local / FastAPI server + URL + Connect); Experiment control (record, stop, CSV, JSON, replay, load JSON); Batch (runs, duration, start); State transition log.
- **View:** Render quality (Low/Medium/High); 3D overlays (frustum, trajectories, labels, grid); Sensor overlays (ROI, calibration grid, ground-truth marker); Scale.
- **Measure:** Click objects to measure range and angles.

**Keyboard shortcuts:** Space run/pause · R reset · D demo · 1–5 views · S sensor · A analysis · M manual (arrows jog) · ? help · Esc close.

---

## 13. Scenario presets and demo mode

| Preset | What it tests | Measured (20 seeds × 15 s) |
|---|---|---|
| **Open Sky** (default) | Clear sky, wide-field acquisition | 20/20 locked · acq 1.13 s mean / 1.50 s max · 2.97 px RMS |
| **PS169 Baseline** | Strict 4° × 3° optics only | 20/20 · 6.66 / 12.70 s · 2.78 px |
| **Moving Platform** | Truck motion | 20/20 · 1.20 / 1.50 s · 7.02 px |
| **High Jitter** | ±20 px/frame shake | 20/20 · 1.13 / 1.47 s · 17.44 px (physical floor ≈ 16 px) |
| **Weak Beacon** | Haze, dim 6 px spot, σ = 18 | 20/20 · 1.29 / 1.70 s · 4.09 px (v1.0 without verifier: 4.03 / 9.30 s · 5.14 px) |
| **Fast Target** | 1.5 °/s random motion, 10 °/s gimbal | 20/20 · 1.03 / 2.33 s · 9.79 px |
| **Acquisition Challenge** | Corner start, rain, 30 % dropouts, decoy | 20/20 · 3.88 / 4.07 s · 3.08 px · re-acq max 0.13 s |
| **Occlusion & Reacquisition** | Circular path, 1 s outage every 6 s | 20/20 · 1.16 / 1.53 s · 3.73 px · 40 re-acq, max 0.03 s |
| **LEO Pass** | Real 550 km orbit, 2.5 s ephemeris error | 20/20 · 0.99 / 1.00 s · 2.86 px |

**Demo mode (press D, 90 s).** Only the scenario changes; the tracking you see is the real closed loop.

| Time | Phase | What you see |
|---|---|---|
| 0–10 s | Acquisition, stationary beacon | Random start → wide scan → detect → zoom to 4° → lock |
| 10–25 s | Linear motion (0.8 °/s) | The Kalman velocity feeds the PID |
| 25–45 s | Circular motion | The beacon stays inside the 10 px lock circle |
| 45–60 s | Sinusoidal motion | Tests loop bandwidth |
| 60–70 s | Detection degradation | Fog, heavy noise, 60 % dropouts → coast → LOST → local search |
| 70–90 s | Recovery on figure-8 | Reacquired from the prediction, back to LOCKED |

---

## 14. Backend, API and the video benchmark (Benchmark-2)

**FastAPI endpoints**
- Status and control: `GET /api/health`, `GET /api/status`; `POST /api/sim/start | stop | reset`; `POST /api/sim/demo?on=true`; `POST /api/sim/step?frames=N`; `POST /api/sim/command`
- Configuration: `GET / PATCH / PUT /api/config`; `GET /api/config/default`; `GET /api/presets`; `POST /api/presets/{id}`
- Telemetry: `GET /api/telemetry`, `GET /api/telemetry/history`, `GET /api/frame.pgm`
- Experiments: `POST /api/experiments/start | stop`; `GET /api/experiments`, `/{id}`, `/{id}/csv`, `/{id}/json`; `POST /api/experiments/batch`
- Video: `POST /api/video/analyze` (multipart MP4 + optional truth CSV, HFOV, spot size, threshold); `GET /api/video/{id}/csv`
- WebSocket: `/ws/telemetry` carries JSON snapshots, binary sensor frames ('AQF1' header) and commands
- Interactive documentation is served at `/docs`

**Benchmark-2 pipeline (camera bypass).**
- An MP4 is read frame by frame, and each frame goes through the **same** centroid detector, a pixel-space Kalman filter and the track logic.
- The output is a per-frame centroid log: `frame, t_s, state, detected, x_px, y_px, confidence, kf_x_px, kf_y_px, err_x_px, err_y_px, err_px, err_deg, proc_ms, truth_x_px, truth_y_px, centroid_err_px`.
- If a ground-truth CSV is supplied, the RMSE is computed.
- `scripts/make_test_video.py` synthesises test MP4s with known truth, for rehearsal.

**Measured video results**

| Video | Frames | Detection | Acquisition | Loss | Centroid RMSE / max | Speed |
|---|---|---|---|---|---|---|
| 640×480 @ 30 fps, σ = 8, mp4v | 300 | 100 % | 0.033 s | 0 % | **0.045 / 0.13 px** | 58 fps |
| v1.1: 640×480 (Python) | — | 100 % | 0.03 s | 0 % | **0.057 px** | 280 fps |
| v1.1: 2000×2000, 1 % salt & pepper, 0.6 s outage (Python) | — | retention 92 % | 0.20 s | outage only | **0.121 px** | 32 fps |
| v1.1: same, built-in stream in the browser | — | retention 92 % | 0.20 s | outage only | **0.082 px** | 30 fps |
| Same, σ = 18 | 300 | 100 % | 0.033 s | 0 % | **0.082 / 0.21 px** | 88 fps |

**Per-frame CSV export (Benchmark-1 log), 33 columns:** `t_s, frame, state, target_az_deg, target_el_deg, target_u_deg, target_v_deg, target_rate_deg_s, range_km, pan_deg, tilt_deg, pan_rate_deg_s, tilt_rate_deg_s, pan_cmd_deg_s, tilt_cmd_deg_s, hfov_deg, det_valid, det_x_px, det_y_px, det_confidence, truth_x_px, truth_y_px, err_x_px, err_y_px, err_px, err_deg, kf_est_x_px, kf_est_y_px, kf_az_rate_deg_s, kf_el_rate_deg_s, proc_ms, transmission, aqs`.

---

## 15. Tech stack

| Layer | Technology | Why |
|---|---|---|
| UI framework | React 19 + TypeScript 5.9 (strict) | Type-safe, component-based UI |
| Build tool | Vite 8 | Fast dev server; static production build |
| 3D engine | three.js 0.186 via React Three Fiber 9 + drei 10 | WebGL rendering in React |
| Post-processing | @react-three/postprocessing (Bloom, Vignette) | Beacon glow, cinematic look |
| State | zustand 5 + module ring buffers | 30 Hz telemetry without React re-render storms |
| Map data | world-atlas (Natural Earth 50m) + topojson-client | Real coastlines |
| Concurrency | Web Workers | Simulation and batch off the UI thread |
| Fonts | Barlow, Barlow Condensed, IBM Plex Mono (Fontsource) | Mission-control typography |
| Backend | Python 3.11, FastAPI, uvicorn | REST + WebSocket |
| Numerics | numpy, pydantic | Engine port, validated config |
| Video | opencv-python-headless | MP4 benchmark |
| Testing | vitest (62 tests), pytest + httpx (36 tests) | Automated verification |
| Desktop | Electron 38 + @electron/packager | Offline `.exe` |
| Quality | ESLint 9, typescript-eslint, tsc strict | 0 lint and 0 type errors |
| Hosting | Any static host (Vercel / Netlify); Render for the API | Judges open a link, no install |

**Codebase size:** 153 files in the ZIP (~6.9 MB). The production app is 1.47 MB (408 kB gzip), with coastline data (546 kB) lazy-loaded and workers of about 50 kB each.

---

## 16. Testing and measured results

**Automated**
- TypeScript core, **51/51**: geometry, camera, trajectories, sensor + detector (sub-pixel < 0.5 px; PS noise maxima < 1.5 px; no false detection on pure noise), Kalman, PID/gimbal/search, state machine, closed loop (7 trajectories each acquire ≤ 2 s with RMS ≤ 10 px and loss < 5 %), demo determinism, link budget, recorder.
- Python engine + API, **30/30**: the same core checks plus every REST endpoint, the WebSocket, and the video benchmark.
- Clean install from the ZIP was verified on both sides.

**Ablation (why the Kalman filter matters)**

| Configuration | Mean RMS error |
|---|---|
| Kalman (az/el) + rate feed-forward | **3.74 px** |
| Kalman, no feed-forward | 12.80 px |
| No Kalman (raw measurement) | 14.91 px |

**Wide-field acquisition vs PS-only optics:** mean 1.13 s vs 6.66 s; max 1.50 s vs 12.70 s; same accuracy.

**Performance:** detection about 1.5 ms/frame in the browser and about 15 ms/frame in Python. The simulation runs at 30 Hz and the FastAPI engine was verified at 32 fps over WebSocket.

**UI verification:** all five views, state changes, telemetry, recording, the remote engine, every button, and 1280×720 and 1600×900 layouts. The production build shows no app console errors.

**Honest failure:** High Jitter has 17.44 px RMS, above 10 px. Uniform ±20 px/frame random shake alone gives ≈ 16 px RMS, which no coarse gimbal can remove (it sees the shake a frame late). This is reported, not hidden.

---

## 17. How ASTRAQ maps to the PS evaluation criteria

| PS stage (weight) | What we show |
|---|---|
| Functional verification (20 %) | One-click demo; every mandatory capability visible in one screen; GUI with 5 views, drawers and live acceptance card |
| Benchmark-1 (30 %) | Any scenario can be set in under a minute via presets and drawers; per-frame CSV log including centroid and pointing error; JSON with events; batch statistics |
| Benchmark-2 (30 %) | `/api/video/analyze` bypasses the camera and processes the MP4 with the same detector; centroid log; RMSE vs truth; acquisition, loss, FPS |
| Technical evaluation (20 %) | Clean modular architecture; az/el Kalman + feed-forward (measured 4× gain); explainable state machine; wide-field acquisition; trained AI verifier with ablation; 98 automated tests; honest limitations |

---

## 18. Innovation and differentiators

1. **Wide-field acquisition then zoom** (OPALS-style), measured at 1.1 s vs 6.7 s.
2. **Gimbal-independent Kalman on azimuth/elevation** with rate feed-forward, measured at 4× lower error.
3. **Explainable state machine:** every decision has a stated reason.
4. **Real sensor image in the loop:** the camera view *is* the image the detector processes.
5. **Robust detector** tuned for PS noise: impulse repair, median/MAD threshold, spatially consistent confirmation, prediction gating against decoys.
6. **Adaptive measurement noise** keeps the filter stable under ±20 px jitter.
7. **One engine, two languages:** a browser (zero install) and a Python server with an identical telemetry schema.
8. **Physically true 3D geometry:** real coastlines, a real orbit, true directions and ranges; exaggerations are labelled.
9. **Zero-setup judging:** a hosted link runs the full simulation in the browser.
10. **Built-in Monte-Carlo and replay** for fair, repeatable comparisons.

---

## 19. Honest limitations
- No YOLO/CNN detector. The AI verifier is a small MLP trained on simulated frames only; it has not seen a real camera.
- No real camera or gimbal hardware.
- Fine-pointing stage not simulated (hand-over flag only).
- The Windows .exe was built but not run on a Windows machine by us; it is not code-signed (SmartScreen warning).
- Headless test browsers lack H.264, so in-browser MP4 upload was verified with WebM; desktop Chrome/Edge decode MP4.
- Link budget ignores fade statistics, background radiance and detector noise.
- Earth rotation ignored during a run; Sun, Moon and site are fixed.
- Terrain colours and city lights are procedural; only the coastlines are real data.
- Python image noise is not bit-identical to the browser engine (trajectories and stars are identical).
- Rendering was tested with software WebGL; real GPUs will be faster.
- High Jitter RMS exceeds 10 px because of the physical floor (≈ 16 px).

---

## 20. Future scope and path to hardware
1. Retrain the AI verifier on real camera footage (phone LED at night, then the real acquisition camera).
2. An IMM filter (straight / accelerating / turning models) for sharper manoeuvres.
3. A shake-state estimator that separates followable from unfollowable motion.
4. A fine-pointing stage (fast steering mirror + quad-cell) simulation.
5. Code-signing and an installer for the desktop app.
6. Hardware in the loop. Real hardware plugs into two existing seams: the frame source (sensor renderer → real camera) and the pan/tilt rate command.
7. Recorded real video (for example a phone LED filmed at night) through the MP4 path.
8. Path: software testbed (**we are here**) → recorded real video → hardware in the loop → optical bench → real pan/tilt → mobile platform.

---

## 21. Impact and beneficiaries
- **ISRO / PAT engineers:** try coarse-pointing ideas on a laptop before booking hardware; same seed, same numbers.
- **Students and researchers:** a repeatable benchmark with ground truth; reviews note there are no standard benchmarks for comparing pointing systems.
- **Cost:** hardware is only needed once an algorithm has earned a test.
- **National context:** India's growing optical-communication efforts (ISRO's 2021 300 m free-space quantum link demonstration at SAC; industry lasercomm terminals). Coarse pointing is a shared need for ground-to-satellite, inter-satellite, UAV, HAPS and ship links.
- **Education:** a visual, interactive explanation of PAT, Kalman filtering and PID control.

---

## 22. Development history (the build log from our chats)

**Session 1: research and idea deck (earlier idea "NETRA").**
- Read the official SIH26169 PDF in full.
- Derived the key numbers: 0.00625 °/px; 7.7 % in-view chance; about 11 s raster.
- Researched prior art: OPALS, CLICK, NASA micro-vibration TM, centroiding literature, public SIH26169 repositories.
- Ran an adversarial review and produced a six-slide idea deck.
- Conclusions that carried into ASTRAQ:
  - use wide-field acquisition;
  - log both error definitions;
  - route the MP4 path through the same core;
  - don't overclaim AI.

**Session 2: building ASTRAQ.**
1. **Competitor analysis.** Unzipped the Asteria reference project, inventoried 21 features, and noted its clutter (10 pages, 3 servers, Firebase login, a 3,300-line scene file, the camera on the satellite instead of the ground). The decision was a one-screen, 3D-first redesign with a mobile ground terminal and zero setup.
2. **Architecture.** A pure-TS simulation core in a Web Worker, a provider abstraction (Local / Remote / Replay), and a Python mirror.
3. **Build.** Core modules → sensor renderer and detector → Kalman/PID/gimbal → state machine → metrics → 3D scene (Earth, sky, truck, satellite) → HUD → drawers → FastAPI + WebSocket → video benchmark → tests → docs.
4. **Bugs found and fixed:**
   - The camera zoomed in before the target was centred and lost it. Fix: stay wide until the estimate is inside half the narrow field.
   - The RMS metric included acquisition transients. Fix: measure only after first lock.
   - Integrator windup caused a 6 px steady bias. Fix: small integral limit, integral separation, integral reset on entering TRACKING; retuned gains to Kp 8 / Ki 1.
   - A lead-compensation experiment made tracking worse and was reverted.
   - Fog and salt & pepper caused false detections. Fix: 8-neighbour impulse repair, spatially consistent confirmation, and a false-detection metric.
   - Jitter made the Kalman gate reject everything. Fix: adaptive R, and re-initialising the filter when the gate rejects during LOST/REACQUIRING.
   - The search waypoint tolerance was too loose, making open-sky acquisition up to 6.5 s. Fix: min(0.3°, 0.08·FOV), bringing it to a 1.5 s maximum.
   - The atmosphere was overexposed from the ground. Fix: rewrote it as an Earth-shadow twilight model with the sun at −6°.
   - Point-light intensity was wrong in km units. Fix: rescaled.
   - The Sensor POV view was black. Fix: set the camera pose directly and disable the orbit controls.
   - drei `<Html>` labels crashed under React StrictMode. Fix: replaced with projected DOM labels.
   - The HUD overlapped the scene framing. Fix: fit-to-free-area camera with a measured view offset.
5. **Validation.** 51 + 30 tests; Monte-Carlo over 8 presets × 20 seeds; ablation; video benchmark; headless browser screenshots of every view; clean install from the ZIP.
6. **Deliverables.** ASTRAQ.zip, README, ARCHITECTURE, FEATURES, TEST_REPORT, RUN_GUIDE, competitor analysis, 12 screenshots.

**Session 3 (this one).** Documentation for the presentation: this knowledge base, a user-manual PDF, a GitHub README, and a deployment guide.

---

## 23. Suggested PPT outline with slide content and speaker notes

*(If the SIH template limits you to 6 slides, merge them as shown in brackets.)*

**Slide 1: Title** [Slide 1]
- ASTRAQ: Autonomous Spatial Tracking & Alignment for Optical Links
- SIH26169 · ISRO / Dept. of Space · Software · Smart Automation, Space Technology
- Team name / ID
- Visual: screenshot 01-overview

**Slide 2: The problem** [Slide 2]
- Laser links are fast and secure but the beam is extremely narrow.
- Before the link can close, a camera has to *find* the partner's beacon and a gimbal has to *centre* it: coarse alignment.
- On a moving truck, with shake, fog and noise, within 2 s, to within 10 px.
- Hardware testing is costly and not repeatable, so a virtual testbed is needed.
- Visual: two-stage PAT diagram (coarse camera + gimbal → fine mirror).
- Notes: use the binoculars-on-a-boat analogy.

**Slide 3: Why it is hard (numbers)** [Slide 2]
- 1 px = 0.00625°; the search field is 12.5°.
- Only 7.7 % of random starts are in view.
- A 4° camera needs about 11 s to scan the field, but the target is 2 s.
- ±20 px/frame jitter, 10 % salt & pepper, fog, platform motion.
- Visual: bar of 11 s vs 2 s vs ASTRAQ 1.1 s.

**Slide 4: Our solution** [Slide 2]
- One-screen 3D mission simulator + a real tracking engine.
- Scan wide (12°) → detect → zoom (4°) → lock → track.
- Runs in any browser, no install; optional Python server.
- Visual: the chain Initial error → Detection → Estimate → Command → Gimbal → Pixel error → Lock.

**Slide 5: Architecture** [Slide 3]
- Pure-TS core in a Web Worker, mirrored in Python.
- TelemetryProvider: Local / FastAPI WebSocket / Replay.
- Ground truth quarantined to metrics.
- Visual: topology diagram (section 8.2).

**Slide 6: The tracking pipeline and algorithms** [Slide 3]
- Detector: impulse repair → median/MAD threshold → components → gating → sub-pixel centroid.
- Kalman on az/el with adaptive R and a χ² gate → rate feed-forward.
- PID with 3-way anti-windup, rate/acceleration limits and motor lag.
- Explainable state machine with reasons.
- Visual: loop diagram (section 9).

**Slide 7: Features / the demo** [Slide 3]
- 5 views, the live sensor image, 9 trajectories, all PS disturbances, 9 presets, 90 s demo, record/replay/batch, AI verifier, video benchmark panel, one-click report, screen view, themes, desktop app.
- Visual: 2×2 screenshots (terminal, sensor, orbit, analysis).

**Slide 8: Results** [Slide 4]
- Acquisition 1.13 s mean / 1.50 s max (≤ 2 s ✅)
- Error 2.97 px RMS (≤ 10 ✅)
- Loss 0 % (< 5 % ✅)
- Re-acquisition 0.03 s after a 1 s blockage ✅
- AI verifier: detection 98.7 %, false detections 0.59 %
- Video centroid 0.057 px (640×480), 0.08–0.12 px (2000×2000) ✅
- 98/98 tests
- Visual: preset table + ablation bar chart (3.74 vs 12.80 vs 14.91 px).

**Slide 9: Benchmark readiness** [Slide 4]
- Benchmark-1: per-frame CSV with centroid and pointing error, batch statistics.
- Benchmark-2: MP4 upload bypasses the camera, same detector, centroid log, RMSE.

**Slide 10: Feasibility, risks and honesty** [Slide 4]
- Works today, in a browser, from a link.
- Risks: the 10 px spec under maximum jitter (physical floor ≈ 16 px); the PS's undefined error definition (we log both).
- Not built: YOLO, hardware, fine stage. The AI verifier is trained on simulation only.

**Slide 11: Impact** [Slide 5]
- Engineers, students, cost, India's lasercomm push.
- Path to hardware with "we are here".

**Slide 12: Future scope** [Slide 5]
- Verifier on real footage, IMM, shake estimator, fine stage, signed installer, hardware in the loop.

**Slide 13: References** [Slide 6]
- See section 26.

**Speaker story (3 minutes, for the live demo)**
- **0:00** "A mobile optical ground terminal must point its laser at a satellite. Before the fine laser stage can work, a camera has to find the satellite's beacon and steer the gimbal onto it. That is coarse alignment."
- **0:20** Press R. "Random start in a 12.5° field. It scans wide, detects, zooms to 4°, and locks in about a second and a half."
- **0:45** Sensor panel. "This is the actual 640×480 image the detector processes. Box is the detection, cross is the centroid, diamond is the Kalman prediction."
- **1:05** Alignment chain. "The full loop, live."
- **1:20** Press 2. "The terminal: a truck with an optical shelter whose roof opens, and a pan/tilt gimbal carrying the telescope."
- **1:35** Press D. "Scripted scenarios: motion types, then fog with 60 % dropouts. It coasts, goes LOST, and reacquires."
- **2:15** Press A. "Live graphs and the PS169 acceptance card, measured against ground truth."
- **2:35** Press 4, then 5. "Through the telescope, and from orbit."
- **2:50** Experiment drawer. "Record, export CSV, replay, batch-test, and the same engine in Python with the MP4 benchmark."

---

## 24. Likely judge questions with answers

| Question | Answer |
|---|---|
| Where is the AI? | A trained neural network — the beacon verifier — decides which bright spot is really the beacon. It raised detection from 89.9 % to 98.7 % and cut false detections from 8.4 % to 0.6 % on 3,879 held-out frames, and cut Weak Beacon lock time from 4.6 s to 1.4 s. Around it: a robust CV detector, an adaptive Kalman filter, and an explainable state machine. The verifier chooses *which* spot; the sub-pixel centroid still measures *where*, because that is more accurate than a network's box. |
| Why not YOLO? | Box regression localises a 10 px spot worse than an intensity-weighted centroid (≈ 0.05 px), and a tiny verifier runs in < 1 ms with transparent features. YOLO is marked "planned"; it could replace the candidate stage and be compared with the same ablation. |
| Was the AI trained on real data? | No — on simulated frames covering 5 atmospheres, 2 FOVs, decoys and noise. The next step is retraining on real footage. |
| Why a truck? | Real transportable optical ground stations (Cailabs TILBA-TOGS, DLR TOGS) are road-mobile shelters/containers with an opening roof. Our model follows that design. |
| How do you meet 2 s acquisition from a random start? | The PS makes FOV user-defined. We scan at 12°, detect, then zoom to 4°. That gives 1.13 s mean and 1.50 s max. With 4° only it is 6.66 s mean, reported honestly. |
| Why a Kalman filter on az/el, not pixels? | Pixels move when the gimbal moves. In az/el the filter sees the target's true motion, and its velocity drives feed-forward. Measured: 3.74 px vs 14.91 px. |
| Why does High Jitter fail 10 px? | ±20 px uniform random shake per frame is ≈ 16 px RMS by itself. A 30 Hz camera sees it a frame late and it reverses, so no coarse gimbal can cancel it. That is the fine stage's job. |
| How do you handle Benchmark-2? | `POST /api/video/analyze`: frames go straight to the same detector, bypassing the camera, and a per-frame centroid log and RMSE are produced. |
| Is it realistic? | Camera geometry, orbit, directions, ranges, coastlines and noise models are real computations. Iconic scaling, the Moon size, the beam cone and city lights are labelled as illustrative. |
| How do you avoid false locks on stars or decoys? | Spatially consistent M-of-N confirmation, gating around the Kalman prediction, and size/SNR confidence scoring. |
| What if the beacon disappears? | It coasts on prediction for 5 frames, goes LOST, searches locally around the prediction, then falls back to a full search after 3 s. Every step is logged with a reason. |
| Does it run in real time? | Yes. 30 Hz simulation; detection about 1.5 ms/frame; the video path runs at 280 fps (640×480) and 30–32 fps on 2000×2000 frames. |
| Is it tested? | 62 TypeScript + 36 Python tests; Monte-Carlo over 180 runs (9 presets × 20); Kalman and AI-verifier ablations; clean-install check. |
| Hardware? | Not tested on hardware. There are two seams for it: the frame source and the rate command. |
| How is this different from other teams? | The camera is on a mobile ground terminal, the real sensor image is in the loop, the Kalman runs on az/el with measured gain, acquisition is wide-field, decisions are explainable, it runs in the browser with zero setup, and there is an MP4 benchmark path. |

---

## 25. Glossary

| Term | Meaning |
|---|---|
| FSOC | Free-space optical communication, data sent by laser through air or space |
| PAT | Pointing, Acquisition and Tracking |
| Coarse alignment | First PAT stage: camera + gimbal bring the partner into view and centre it |
| Fine pointing | Second stage: a fast steering mirror corrects microradian errors |
| Beacon | A wide, bright light the partner shines so it can be found |
| Gimbal / pan-tilt | A motorised mount that turns horizontally (pan / azimuth) and vertically (tilt / elevation) |
| FOV | Field of view, how wide the camera sees |
| IFOV | Angle covered by one pixel |
| Azimuth / elevation | Compass direction / angle above the horizon |
| Centroid | Brightness-weighted centre of the spot |
| Sub-pixel | More precise than one pixel |
| Kalman filter | An algorithm that combines noisy measurements with a motion model to estimate position and velocity |
| PID | Proportional-Integral-Derivative controller |
| Feed-forward | Adding the target's expected speed to the command so the gimbal doesn't lag |
| Anti-windup | Stops the integral term growing when the motor is saturated |
| χ² gate | A statistical test that rejects measurements that are too far from the prediction |
| MAD | Median absolute deviation, a noise estimate that ignores outliers |
| Salt & pepper noise | Random fully white or black pixels |
| Jitter | Fast random shake of the camera |
| LEO | Low Earth orbit (here 550 km) |
| Ephemeris error | Difference between where the satellite is predicted to be and where it is |
| RMS / RMSE | Root-mean-square (error) |
| AQS | Alignment Quality Score, ASTRAQ's 0–100 health score |
| Monte-Carlo | Running many random trials to get statistics |
| Web Worker | A background thread in the browser |
| WebSocket | A live two-way connection between browser and server |

---

## 26. References
- SIH26169 problem statement, ISRO / Department of Space, SIH 2026.
- OPALS on the ISS (NASA JPL, 2014): eoportal.org/other-space-activities/iss-opals-and-hdev
- MIT CLICK, "Pointing, Acquisition, and Tracking for Small Satellite Laser Communications", SmallSat Conference, USU DigitalCommons.
- H. Kaushal et al., "A Review of Pointing Modules and Gimbal Systems for FSO in Non-Terrestrial Platforms", *Photonics* 12(10):1001, 2025.
- R. Abdelfatah, N. Alshaer, T. Ismail, "A review on pointing, acquisition, and tracking approaches in UAV-based FSO communication systems", *Opt. Quantum Electron.* 54:571, 2022.
- Y. Kaymak et al., "A Survey on Acquisition, Tracking, and Pointing Mechanisms for Mobile FSO", IEEE COMST, 2018.
- C. Dennehy, O. Alvarez-Salazar, "Spacecraft Micro-Vibration", NASA/TM-2018-220075.
- "Disturbance Feedforward Control for EOTS LOS Stabilization on a Moving Platform", *Sensors* 18(12):4350, 2018.
- H. Lim et al., "Centroid Error Analysis of Beacon Tracking under Atmospheric Turbulence", *Remote Sensing* 13(10):1931, 2021.
- "Star Centroiding Based on Fast Gaussian Fitting", *Sensors* 18(9):2836, 2018.
- R. E. Kalman, "A New Approach to Linear Filtering and Prediction Problems", 1960.
- ISRO free-space quantum communication over 300 m at SAC, *The Tribune*, 2021.
- Natural Earth (public-domain map data) via world-atlas; three.js; React Three Fiber; FastAPI.
- Cailabs, "TILBA-TOGS Transportable Optical Ground Station", https://www.cailabs.com/aerospace-defense/laser-communications/transportable-optical-ground-station/
- DLR, "Transportable Optical Ground Station (TOGS)", https://elib.dlr.de/78398/1/8517-5.pdf
