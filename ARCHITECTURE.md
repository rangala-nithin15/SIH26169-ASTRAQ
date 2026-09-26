# ASTRAQ — Architecture

## 1. Principles

* **Simulation logic is separate from the UI.** `web/src/core` is pure TypeScript with no DOM, React or three.js. It runs in a Web Worker, in Node (vitest) and is mirrored module by module in Python (`server/astraq_engine`).
* **3D rendering is separate from the tracking algorithms.** The scene only *reads* telemetry snapshots. It never computes tracking.
* **Backend communication is abstracted.** The UI talks to a `TelemetryProvider`. Local, remote and replay providers are interchangeable.
* **Ground truth is quarantined.** Only the metrics and the labelled synthetic detector read truth. Detection, estimation, control and the state machine use observable data only.

## 2. Runtime topology

```
┌────────────────────────────── Browser ──────────────────────────────┐
│                                                                      │
│  React UI (hud/)  ◀── zustand store (state/) ◀── TelemetryProvider   │
│  R3F scene (scene/) ◀─ live buffers (snapshot, image, history)   │   │
│                                                                   │   │
│   ┌──────────── LocalEngineProvider ─────────────┐                │   │
│   │  Web Worker: engine/worker.ts                │◀── commands ───┘   │
│   │    SimulationEngine (core/engine.ts) @ 30 Hz │── snapshots/images ▶│
│   └──────────────────────────────────────────────┘                    │
│   ┌──────────── RemoteEngineProvider ────────────┐                    │
│   │  WebSocket ws://host:8000/ws/telemetry       │◀─────────────┐     │
│   └──────────────────────────────────────────────┘              │     │
│   ┌──────────── ReplayProvider ──────────────────┐              │     │
│   │  plays a Recording (JSON)                    │              │     │
│   └──────────────────────────────────────────────┘              │     │
│   batch.worker.ts — headless Monte-Carlo runs                   │     │
└─────────────────────────────────────────────────────────────────┼─────┘
                                                                  │
┌──────────────────────── FastAPI server (optional) ──────────────┼─────┐
│  app/main.py  REST /api/* · WebSocket /ws/telemetry ────────────┘     │
│  app/service.py  SimulationService: asyncio loop @ 30 Hz, broadcast,  │
│                  experiments (record/batch), video analyses           │
│  astraq_engine/  numpy port of the core + video.py (MP4 benchmark)    │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. Simulation core (per frame)

```
             ┌─────────────── servo sub-steps (60 Hz) ────────────────┐
             │  controlLaw(t): search / reacq waypoints, manual goal,   │
             │  or PID(e = axis→Kalman estimate) + Kalman-rate FF       │
             │  → Gimbal.step(rate cmd, wind)                           │
             └──────────────────────────────────────────────────────────┘
TargetModel.step ─▶ truth dir/range/field (u,v)
DisturbanceModel.step ─▶ platform attitude (dPan,dTilt), wind, scintillation, AoA, atmosphere, dropout
zoom (wide ↔ narrow FOV) ─▶ PinholeCamera(actual = encoder + platform) / PinholeCamera(encoder)
SensorRenderer.render ─▶ 8-bit frame (stars, beacon, decoy, rain, noise)
DetectionProvider.detect(frame, {prediction, gate}) ─▶ latency queue
measurement px ─(capture-time encoder pose)─▶ az/el ─▶ AngularKalman.predict/update (gate, adaptive R)
Supervisor.step(detected, measured err, filtered err) ─▶ transition + reason
RunMetrics.update(truth pointing error, centroid error, …) ─▶ Snapshot
```

| Module | Responsibility |
|---|---|
| `config.ts` | `SimConfig` types, PS169 defaults, `mergeConfig`, `sanitizeConfig`, `intrinsics()` |
| `geometry.ts` | ENU frame (x=E, y=U, z=S), az/el ↔ direction, gnomonic field coordinates, `OrbitalPass` |
| `target/trajectory.ts` | patterns with anchor glide (no teleport on change), linear bounce, bounded random walk, waypoints, LEO pass with ephemeris lag |
| `optics/camera.ts` | pinhole projection / back-projection / angular error |
| `optics/sensor.ts` | focal-plane renderer (area-exact square spot, supersampled disk, Gaussian; noise table) |
| `optics/stars.ts` | seeded catalogue shared by the sky and the sensor |
| `detection/*` | `DetectionProvider` interface, `CentroidDetector` (with coarse-to-fine search for large frames), learned verifier (`verifier.ts` + `verifier_weights.json`), `SyntheticDetector`, registry |
| `estimation/kalman.ts` | closed-form block-diagonal CV filter on az/el |
| `control/pid.ts, gimbal.ts, search.ts` | PID with anti-windup, rate-limited 2-axis gimbal, clamped square spiral |
| `tracking/supervisor.ts` | state machine with reasons |
| `analysis/metrics.ts, link.ts` | PS169 metrics, AQS, link budget, acquisition probability |
| `telemetry/types.ts, recorder.ts` | snapshot schema, CSV/JSON recording |
| `analysis/report.ts` | automatic performance report (JSON / Markdown / HTML) for live runs, recordings, batches and videos |
| `video/analyzer.ts, synthetic.ts` | camera-bypass video pipeline (Benchmark-2) and the built-in 2000×2000 test stream |
| `demo/script.ts` | demo phases (configuration patches only) |
| `engine.ts` | orchestration of all of the above |

## 4. Frames and units

* **Scene = site ENU in km.** The terminal is at the origin (floating origin for float precision) and the Earth's centre is at (0, −6371, 0). The Earth mesh is rotated so the site's latitude/longitude point is up. `azElVec()` places everything by true direction and true range.
* Directions, ranges and the Earth are true. The terminal and spacecraft use **iconic scaling** (`world.ts: iconicScale`): they grow only when a real-size model would be too small to see. The Moon is drawn at ×3 radius. The beacon cone divergence is exaggerated. All of this is stated in the UI.
* **Logarithmic depth buffer.** Custom shaders include the three.js logdepth chunks, so centimetre detail and 1e5 km sky coexist.

## 5. Front-end data flow

1. A provider emits `EngineMessage`s: `snapshot` (30 Hz), `frame` (binary, 8–30 Hz by quality), `config` and `status`.
2. `state/store.ts` writes the high-rate data into **module buffers**: `live.snap`, `live.image`, `history` ring buffers and 3D trails. React state only gets a throttled `hud` copy (about 12 Hz).
3. The 3D scene reads those buffers inside `useFrame`. `VisBus` derives a smoothed `vis` state (angles, positions, scales) once per frame, and the models and overlays read `vis`.
4. The sensor view and charts are canvases that redraw on `requestAnimationFrame` when new data exists. The sensor overlay uses the snapshot whose frame number matches the displayed image.
5. Commands (`EngineCommand`) flow back through the same provider. `patchConfig` merges optimistically into the store and sends a patch.

## 6. Message protocol (`web/src/engine/protocol.ts`)

Client → engine (JSON):
`start | pause | reset | config{patch} | replaceConfig{config} | demo{on} | mode{mode} | manual{pan,tilt} | reacquire | timeScale{value} | imageRate{hz}`

Engine → client:
* JSON `{type:'snapshot', snapshot}`, `{type:'config', config, version}`, `{type:'status', running, demo, fps, timeScale}`, `{type:'error', message}`
* Binary sensor frame (WebSocket only): `'AQF1'` (uint32 BE) · width u16 LE · height u16 LE · frame u32 LE · W×H bytes

The `Snapshot` schema is defined in `core/telemetry/types.ts`, and the Python engine emits the same keys (tested by `test_snapshot_schema_matches_web_client`).

## 7. Server

* `SimulationService` runs one engine on an asyncio task with a fixed-step accumulator. It broadcasts to every WebSocket client and optionally records to an `Experiment`.
* REST and WebSocket share one `command()` implementation guarded by an asyncio lock.
* Batch runs and video analyses run in the default thread executor so the live loop keeps going.
* `astraq_engine.video.analyze_frames()` is the camera-bypass pipeline (PS "Benchmark-2"). It uses the same `CentroidDetector`, a pixel-space Kalman filter and track logic, and writes a per-frame centroid log.

## 8. Rendering

* Earth: a custom shader using the land/coast mask rasterised at runtime from Natural Earth polygons (`landMask.ts`), procedural biomes, ocean glint, terminator, illustrative city lights and a lat/long grid. A precise curved ground patch sits around the site, where the global sphere is cut out.
* Atmosphere: an analytic shell shader. The optical depth comes from the path length, and the illumination from whether each sample point sees the Sun over the limb (Earth shadow). It works from orbit and from the ground.
* Sky: the shared star catalogue as points, a procedural galactic band, a Sun sprite, screen-space flare ghosts (hidden when the Earth blocks the Sun) and a shaded Moon.
* Models: procedural PBR materials (canvas textures for MLI foil, cells, radiator, shelter), a Lightformer environment for reflections, and bloom and vignette post-processing. Quality presets are Low, Medium and High.

## 9. Additions in v1.1

**Learned beacon verifier (AI).** The classical detector segments at a lower threshold (4σ) when the verifier is on and computes 11 scale-aware features per candidate (size vs expected footprint, SNR, fill, aspect, flatness, saturation, expected size, ring contrast, noise level, brightness, spread). An MLP (11→16→8→1, tanh, sigmoid) scores each; the best-scoring candidate above p = 0.7 (after prediction gating) is the detection. Weights and normalisation live in one JSON file used by both engines (`web/src/core/detection/verifier_weights.json`, copy in `server/astraq_engine/`). Training: `web/scripts/verifier/` — `gen-data.ts` (labelled candidates from random frames over the whole PS disturbance space), `train.py` (numpy MLP, Adam, class-weighted), `evaluate.py`, `closed-loop.ts` (ablation), `make-fixture.ts` (cross-engine parity fixture checked by pytest).

**Large frames.** Frames above 1.5 Mpx are searched coarse-to-fine: impulse repair at full resolution → 2×2 mean decimation → detection → refinement in a small ROI at full resolution. While tracking only the ROI is processed. All components are ranked by integrated signal (SNR·√area) and the strongest 64 are scored.

**Re-acquisition.** On LOST → REACQUIRING the controller follows the Kalman prediction for 1 s (with the wide field of view) before starting the local spiral; a Kalman re-initialisation keeps the previous rate estimate.

**Scheduled outages.** `disturbance.occlusionPeriodS / occlusionDurS` hide the beacon on a schedule (a passing cloud); the re-acquisition clock starts when the beacon is visible again.

**Performance report.** `core/analysis/report.ts` / `server/astraq_engine/report.py` build the same report structure from a `MetricsSummary`, a batch or a video summary. Browser: Analysis ▸ Report, Experiment ▸ Performance report, key P, automatic on recording stop. Server: `GET /api/report`, `GET /api/experiments/{id}/report`, `GET /api/video/{id}/report` (`?format=html|md|json`).

**Video benchmark in the browser.** `hud/VideoBench.tsx` decodes a video with the browser's decoder: sequential playback with `requestVideoFrameCallback` (each presented frame is captured into a queue with its true index; the analyzer predicts across any frame the decoder skips) or frame-exact seeking. The analysis runs the same detector + verifier + pixel Kalman as `server/astraq_engine/video.py`. The 3D view pauses while the panel is open.

**Screen view.** `hud/Sensor.tsx › ScreenCanvas` draws the search field as the PS's 2000×2000 px screen (0.00625 °/px) with the camera viewport, beacon, paths and estimate, from the same snapshots.

**Themes.** All interface colours are CSS custom properties; `:root[data-theme=…]` blocks define Deep Space, Laser Red, Aurora, Solar Gold and Daylight. Charts resolve colours through `cssVar()`.

**Desktop application.** `desktop/` wraps the production build in Electron: `main.js` serves `app/` (a copy of `web/dist`) from a private HTTP server on 127.0.0.1 and opens it in a window, so module workers load exactly as on the web. `npm run package:win|linux|mac` produces the executable folder.
