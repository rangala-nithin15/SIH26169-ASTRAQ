# Reference Project Analysis — "Asteria / FSOC Virtual PAT"

This document records what was learned from the reference ZIP (`Asteria-main.zip`)
**before** any ASTRAQ code was written. The reference was used only as a
requirements source. No source code, component structure, naming, styling,
constants files, assets or images from it were copied into ASTRAQ.

---

## 1. Technology found

| Area | Reference project |
|---|---|
| Frontend | React 19 + TypeScript + Vite 8, Tailwind 4, React Router (10 routed pages), Recharts, Leaflet, lucide icons |
| Auth | Firebase email/password login, sign-up, reset-password pages |
| 3D engine | three.js via React Three Fiber + Drei. One 3,278-line `Scene3D.tsx` holds the whole scene, rig, navigation and debug UI |
| Simulation engine | Python FastAPI service (`ai-service/`), 2,072-line `engine.py` god-object, asyncio loop |
| Second backend | Node/Express service used only to proxy Google Gemini ("Engineering Copilot") |
| Desktop | Electron wrapper + electron-builder, a checked-in PyInstaller `.exe` build folder |
| Persistence | SQLite models (scenarios, runs, telemetry) |
| Communication | REST (~30 endpoints) + one WebSocket `/ws/simulation` |
| Reports | CSV, JSON, PDF (reportlab) |
| Video | MP4 upload → frame-by-frame processing (Benchmark-2 path) via OpenCV |

## 2. Feature inventory

| # | Capability | How the reference does it | Useful for ASTRAQ? |
|---|---|---|---|
| 1 | Virtual camera | Pinhole camera, 640×480, 4°×3° FOV, pan/tilt angles, world→pixel projection | **Yes** — core requirement (PS table) |
| 2 | Target trajectories | static, straight, circular, sinusoidal, figure-8, spiral, random walk | **Yes** — plus custom waypoints and an orbital pass |
| 3 | Frame renderer | numpy image: stars, beacon spot, gaussian / salt-pepper / poisson noise, haze/fog/rain/low-light | **Yes** — ASTRAQ renders its own sensor frame in the browser worker |
| 4 | Detector | Connected-component beacon detector with candidate scoring; YOLO class stub | **Yes** — modular provider interface; YOLO stays "planned" |
| 5 | Kalman filter | 2-D constant-velocity filter in **pixel** space | Partly — ASTRAQ filters in the gimbal-independent angular frame instead |
| 6 | PID | Dual-axis PID in deg/s with integral clamp | **Yes** — plus rate/accel limits, anti-windup, feed-forward |
| 7 | State machine | READY/SEARCHING/DETECTED/ACQUIRING/TRACKING/LOCKED/LOST/REACQUIRING | **Yes** — ASTRAQ adds a logged *reason* for every transition |
| 8 | Search pattern | Expanding pan/tilt sweep | **Yes** — ASTRAQ uses a square spiral plus optional wide-field acquisition |
| 9 | Disturbances | turbulence, vibration, camera motion, sensor noise, target motion variation | **Yes** |
| 10 | Environment presets | open sky, urban, mountain, UAV, satellite | **Yes** — reworked as scenario presets |
| 11 | Metrics | acquisition time, RMSE px, loss %, reacquisition time, FPS vs PS limits | **Yes** — shown as a live acceptance card |
| 12 | Reports | CSV / JSON / PDF + run database | CSV + JSON kept; PDF + DB dropped (low value for a demo) |
| 13 | MP4 benchmark | Upload video, bypass PTZ, detect per frame | **Yes** — re-implemented as `/api/video/analyze` |
| 14 | Multi-entity registry | register/delete targets, cameras, satellites via REST | No — complexity without payoff for a single-link demo |
| 15 | 3D scene | Earth ball, Moon, Sun sprite, stars, satellite with gimbal-mounted camera, beacon, FOV beam, trajectory line | Replaced by a new composition (terminal on a curved Earth, globe with real coastlines, iconic scaling) |
| 16 | Camera feed | Canvas overlay of pixel positions | ASTRAQ shows the **actual rendered sensor frame** from the simulation |
| 17 | Event log | Scrolling text list | Replaced by the transition log with reasons |
| 18 | Gemini copilot | LLM chat on telemetry | No — an external LLM is not part of the tracking pipeline and needs keys |
| 19 | Firebase auth | Login / sign-up / reset | No — adds setup friction and nothing to the simulation |
| 20 | Landing page | WebGPU "AeroShards" hero, heritage-site photos, sounds | No — unrelated to FSOC |
| 21 | Electron packaging | Windows installer | Not in the first release (the PS asks for a standalone executable; noted as future work) |

## 3. Clutter observed

- Ten routed pages (Mission, Tracking, Detection, Camera, Disturbance Lab, Analytics, Reports, Settings, Copilot, plus auth pages). The same numbers appear on several pages.
- A permanent left sidebar with eight entries, plus a right column of four stacked cards (Mission, Tracking, Performance, Event Log). The 3D view gets about 60% of the screen.
- Three separate servers must run for the full experience (Python, Node, Vite) and Firebase keys are needed to get past login.
- Monospace uppercase text everywhere; tiny labels; amber-on-black cards repeated in every panel.
- Unrelated assets (Taj Mahal, Hampi, Goa beach photos, 1.5 MB PNGs, notification sounds).
- Very large single files (`Scene3D.tsx` 3.3k lines, `engine.py` 2k lines), so the concerns are mixed together.
- Screenshots show overlapping labels ("SAT-01 · SATELLITE" behind "FSOC-CAM-01 · CAMERA") and a very large beam cone that hides the geometry.
- The camera sits on a satellite, so the "mobile ground terminal" story from the problem statement is not visible.

## 4. Opportunities ASTRAQ takes

1. **One screen, 3D first.** The viewport fills the window. Controls open as drawers only when needed.
2. **Tell the physical story.** A mobile ground terminal with a pan/tilt telescope stands on a curved Earth and tracks the beacon on a satellite. Directions are exact; sizes use labelled iconic scaling.
3. **Real sensor image.** The camera feed is the simulated 640×480 frame that the detector actually processes.
4. **Gimbal-independent estimation.** The Kalman filter runs on target azimuth/elevation, so its velocity estimate drives rate feed-forward.
5. **Explainable state machine.** Every transition records its cause (for example "3 consecutive misses → coast limit").
6. **Coarse-alignment pipeline strip.** Error → detection → estimate → command → motion → pixel error → lock, with live values.
7. **One engine, three sources.** Local Web Worker (no backend needed), FastAPI WebSocket, or recorded replay all feed the same UI through one `TelemetryProvider` interface.
8. **Honest extras.** Link-budget preview, acquisition probability and alignment quality score each show their formula and assumptions.
9. **Zero-setup demo.** `npm install && npm run dev` gives the full demo. No login, no keys, no second server.
