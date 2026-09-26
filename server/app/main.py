"""
ASTRAQ FastAPI server.

Run (from the `server/` folder):
    python -m uvicorn app.main:app --reload --port 8000

REST under /api, live telemetry on the WebSocket /ws/telemetry. Interactive API
docs at http://localhost:8000/docs.
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from astraq_engine import DEFAULT_CONFIG, PRESETS, json_safe, sanitize
from astraq_engine.config import merge
from astraq_engine.report import build_report, report_html, report_markdown
from astraq_engine.video import HAVE_CV2, VideoParams, analyze_video_file, parse_truth_csv, rows_to_csv

from .service import SimulationService, to_csv

service = SimulationService()


@asynccontextmanager
async def lifespan(_: FastAPI):
    service.start_loop()
    yield
    await service.stop_loop()


app = FastAPI(
    title="ASTRAQ engine",
    version="1.0.0",
    description="Autonomous Spatial Tracking & Alignment for Optical Links — simulation engine, telemetry and experiments.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ASTRAQ_CORS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class CommandIn(BaseModel):
    type: Literal["start", "pause", "reset", "config", "replaceConfig", "demo", "mode", "manual", "reacquire", "timeScale", "imageRate"]
    patch: dict | None = None
    config: dict | None = None
    on: bool | None = None
    mode: str | None = None
    pan: float | None = None
    tilt: float | None = None
    value: float | None = None
    hz: float | None = None


class RecordIn(BaseModel):
    name: str = ""


class BatchIn(BaseModel):
    runs: int = Field(10, ge=1, le=100)
    durationS: float = Field(15, ge=2, le=120)
    seed0: int | None = None
    config: dict | None = None
    preset: str | None = None


# ── health / status ─────────────────────────────────────────────
@app.get("/api/health", tags=["status"])
def health() -> dict:
    return {"ok": True, "engine": "astraq-python", "video": HAVE_CV2}


@app.get("/api/status", tags=["status"])
def status() -> dict:
    e = service.engine
    s = service.latest
    return {
        "running": e.running,
        "demo": e.demo_active,
        "mode": e.mode,
        "state": s["state"] if s else e.sup.state,
        "t": s["t"] if s else 0.0,
        "frame": s["frame"] if s else 0,
        "fps": service.fps,
        "timeScale": service.time_scale,
        "scenarioId": e.cfg["scenarioId"],
        "clients": len(service.clients),
        "recording": service.recording.meta() if service.recording else None,
        "metrics": s["metrics"] if s else None,
    }


# ── simulation control ──────────────────────────────────────────
@app.post("/api/sim/start", tags=["simulation"])
async def sim_start() -> dict:
    await service.command({"type": "start"})
    return status()


@app.post("/api/sim/stop", tags=["simulation"])
async def sim_stop() -> dict:
    await service.command({"type": "pause"})
    return status()


@app.post("/api/sim/reset", tags=["simulation"])
async def sim_reset() -> dict:
    await service.command({"type": "reset"})
    return status()


@app.post("/api/sim/demo", tags=["simulation"])
async def sim_demo(on: bool = True) -> dict:
    await service.command({"type": "demo", "on": on})
    return status()


@app.post("/api/sim/step", tags=["simulation"])
async def sim_step(frames: int = Query(1, ge=1, le=3000)) -> dict:
    """Advance the simulation synchronously (useful for scripted tests)."""
    snap = None
    async with service.lock:
        for _ in range(frames):
            snap = await service._step_and_publish()
    return json_safe(snap)


@app.post("/api/sim/command", tags=["simulation"])
async def sim_command(cmd: CommandIn) -> dict:
    try:
        await service.command(cmd.model_dump(exclude_none=True))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return status()


# ── configuration ───────────────────────────────────────────────
@app.get("/api/config", tags=["configuration"])
def get_config() -> dict:
    return service.engine.cfg


@app.get("/api/config/default", tags=["configuration"])
def get_default_config() -> dict:
    return DEFAULT_CONFIG


@app.patch("/api/config", tags=["configuration"])
async def patch_config(patch: dict[str, Any]) -> dict:
    await service.command({"type": "config", "patch": patch})
    return service.engine.cfg


@app.put("/api/config", tags=["configuration"])
async def put_config(cfg: dict[str, Any]) -> dict:
    full = sanitize(merge(DEFAULT_CONFIG, cfg))
    await service.command({"type": "replaceConfig", "config": full})
    return service.engine.cfg


@app.get("/api/presets", tags=["configuration"])
def presets() -> list[dict]:
    return PRESETS


@app.post("/api/presets/{preset_id}", tags=["configuration"])
async def apply_preset(preset_id: str, seed: int | None = None) -> dict:
    if not any(p["id"] == preset_id for p in PRESETS):
        raise HTTPException(404, f"unknown preset {preset_id}")
    async with service.lock:
        cfg = service.apply_preset(preset_id, seed)
    await service.maybe_send_config()
    return cfg


# ── telemetry ───────────────────────────────────────────────────
@app.get("/api/telemetry", tags=["telemetry"])
def telemetry() -> dict:
    if service.latest is None:
        raise HTTPException(503, "no telemetry yet")
    return service.latest


@app.get("/api/telemetry/history", tags=["telemetry"])
def telemetry_history(seconds: float = Query(10, gt=0, le=60)) -> dict:
    fr = service.history[-int(seconds * service.engine.cfg["camera"]["frameRateHz"]) :]
    return {
        "t": [s["t"] for s in fr],
        "state": [s["state"] for s in fr],
        "errPx": [s["error"]["magPx"] for s in fr],
        "angErrDeg": [s["error"]["angDeg"] for s in fr],
        "pan": [s["gimbal"]["pan"] for s in fr],
        "tilt": [s["gimbal"]["tilt"] for s in fr],
        "confidence": [(s["detection"] or {}).get("confidence", 0) for s in fr],
    }


@app.get("/api/frame.pgm", tags=["telemetry"])
def frame_pgm() -> Response:
    """Latest rendered sensor frame as a binary PGM (8-bit grey)."""
    fr = service.engine.last_frame
    if fr is None:
        raise HTTPException(503, "no frame yet")
    header = f"P5\n{fr.width} {fr.height}\n255\n".encode()
    return Response(header + fr.data.tobytes(), media_type="image/x-portable-graymap")


# ── experiments ─────────────────────────────────────────────────
@app.post("/api/experiments/start", tags=["experiments"])
def experiment_start(body: RecordIn) -> dict:
    return service.start_recording(body.name).meta()


@app.post("/api/experiments/stop", tags=["experiments"])
def experiment_stop() -> dict:
    ex = service.stop_recording()
    if not ex:
        raise HTTPException(409, "no active recording")
    return ex.meta()


@app.get("/api/experiments", tags=["experiments"])
def experiment_list() -> list[dict]:
    return [e.meta() for e in service.experiments.values()]


@app.post("/api/experiments/batch", tags=["experiments"])
async def experiment_batch(body: BatchIn) -> dict:
    """Monte-Carlo batch: N headless runs over consecutive seeds."""
    if body.preset:
        from astraq_engine import preset_config

        cfg = preset_config(body.preset)
    else:
        cfg = sanitize(merge(service.engine.cfg, body.config or {}))
    seed0 = body.seed0 if body.seed0 is not None else cfg["seed"] * 1000
    ex = await asyncio.get_running_loop().run_in_executor(None, service.run_batch, cfg, body.runs, body.durationS, seed0)
    res = ex.batch or []
    acq = [r["metrics"]["acquisitionS"] for r in res if r["metrics"]["acquisitionS"] is not None]
    rms = [r["metrics"]["errRmsPx"] for r in res if r["metrics"]["errRmsPx"] is not None]
    return {
        **ex.meta(),
        "aggregate": {
            "locked": len(acq),
            "acquisitionMeanS": sum(acq) / len(acq) if acq else None,
            "acquisitionMaxS": max(acq) if acq else None,
            "errRmsMeanPx": sum(rms) / len(rms) if rms else None,
            "passAcquisition": sum(1 for r in res if r["metrics"]["acceptance"]["acquisition"]),
            "passError": sum(1 for r in res if r["metrics"]["acceptance"]["error"]),
        },
        "results": res,
    }


def _get_ex(eid: str):
    ex = service.experiments.get(eid)
    if not ex:
        raise HTTPException(404, "unknown experiment")
    return ex


@app.get("/api/experiments/{eid}", tags=["experiments"])
def experiment_get(eid: str) -> dict:
    ex = _get_ex(eid)
    return {**ex.meta(), "events": ex.events[-200:], "results": ex.batch}


@app.get("/api/experiments/{eid}/csv", tags=["experiments"], response_class=PlainTextResponse)
def experiment_csv(eid: str) -> PlainTextResponse:
    ex = _get_ex(eid)
    if ex.batch is not None:
        lines = ["seed,final_state,acquisition_s,err_rms_px,err_max_px,loss_pct,reacq_max_s,centroid_rms_px,fps_capacity"]
        for r in ex.batch:
            m = r["metrics"]
            lines.append(",".join("" if v is None else str(v) for v in [r["seed"], r["finalState"], m["acquisitionS"], m["errRmsPx"], m["errMaxPx"], m["lossPct"], m["reacqMaxS"], m["centroidRmsPx"], round(m["fps"])]))
        text = "\n".join(lines) + "\n"
    else:
        text = to_csv(ex.frames)
    return PlainTextResponse(text, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="astraq-{ex.id}.csv"'})


@app.get("/api/experiments/{eid}/json", tags=["experiments"])
def experiment_json(eid: str) -> JSONResponse:
    ex = _get_ex(eid)
    body = ex.recording() if ex.batch is None else {**ex.meta(), "config": ex.config, "results": ex.batch}
    return JSONResponse(json_safe(body), headers={"Content-Disposition": f'attachment; filename="astraq-{ex.id}.json"'})


# ── performance reports ─────────────────────────────────────────
ReportFormat = Literal["html", "md", "json"]


def _render_report(rep: dict, fmt: str, name: str) -> Response:
    rep = json_safe(rep)
    if fmt == "json":
        return JSONResponse(rep, headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
    if fmt == "md":
        return PlainTextResponse(report_markdown(rep), media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="{name}.md"'})
    return Response(report_html(rep), media_type="text/html")


@app.get("/api/report", tags=["reports"])
def live_report(format: ReportFormat = "html") -> Response:
    """Automatic performance report for the live run (PS 'Performance Log')."""
    snap = service.latest
    if snap is None:
        raise HTTPException(409, "no telemetry yet")
    rep = build_report("live", "FastAPI engine", service.engine.cfg, snap["metrics"], service.engine.all_events)
    return _render_report(rep, format, "astraq-report-live")


@app.get("/api/experiments/{eid}/report", tags=["reports"])
def experiment_report(eid: str, format: ReportFormat = "html") -> Response:
    ex = _get_ex(eid)
    if ex.batch is not None:
        rep = build_report("batch", "FastAPI engine", ex.config, batch=ex.batch)
    else:
        if not ex.frames:
            raise HTTPException(409, "experiment has no frames")
        rep = build_report("recording", "FastAPI engine", ex.config, ex.frames[-1]["metrics"], ex.events)
    return _render_report(rep, format, f"astraq-report-{ex.id}")


# ── video benchmark ─────────────────────────────────────────────
@app.post("/api/video/analyze", tags=["video benchmark"])
async def video_analyze(
    file: UploadFile = File(..., description=".mp4 (or any OpenCV-readable) video"),
    truth: UploadFile | None = File(None, description="optional ground truth CSV: frame,x,y"),
    hfovDeg: float = Form(4.0),
    spotSizePx: float = Form(0.0, description="beacon size in px; 0 = estimate automatically"),
    thresholdSigma: float = Form(5.0),
    verifier: bool = Form(True, description="use the learned beacon verifier"),
) -> dict:
    """Bypass the simulated PTZ camera: run the coarse-pointing pipeline on a video."""
    if not HAVE_CV2:
        raise HTTPException(501, "Video input needs opencv-python-headless (pip install opencv-python-headless)")
    suffix = os.path.splitext(file.filename or "video.mp4")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        tr = parse_truth_csv((await truth.read()).decode()) if truth is not None else None
        params = VideoParams(hfov_deg=hfovDeg, spot_size_px=spotSizePx, threshold_sigma=thresholdSigma, verifier=verifier)
        res = await asyncio.get_running_loop().run_in_executor(None, analyze_video_file, path, params, tr)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    finally:
        os.unlink(path)
    vid = os.urandom(5).hex()
    res["fileName"] = file.filename or "video"
    service.videos[vid] = res
    return {"id": vid, "summary": json_safe(res["summary"]), "csv": f"/api/video/{vid}/csv", "report": f"/api/video/{vid}/report"}


def video_report_summary(res: dict) -> dict:
    s = res["summary"]
    return {
        "fileName": res.get("fileName", "video"),
        "width": s["width"],
        "height": s["height"],
        "fps": s["videoFps"],
        "frames": s["frames"],
        "detectionRate": (s["detectionRatePct"] or 0) / 100,
        "acquisitionS": s["acquisitionS"],
        "lossPct": s["lossPct"],
        "reacqMaxS": s["reacqMaxS"],
        "centroidRmsePx": s["centroidRmsePx"],
        "centroidMaxPx": s["centroidMaxPx"],
        "procMeanMs": s["procMeanMs"] or 0.0,
        "processingFps": s["processingFps"] or 0.0,
        "lockRetentionPct": s.get("lockRetentionPct"),
        "truthProvided": s["truthProvided"],
    }


@app.get("/api/video/{vid}/report", tags=["reports"])
def video_report(vid: str, format: ReportFormat = "html") -> Response:
    res = service.videos.get(vid)
    if not res:
        raise HTTPException(404, "unknown video analysis")
    rep = build_report("video", "FastAPI engine (camera bypass)", None, video=video_report_summary(res))
    return _render_report(rep, format, f"astraq-report-video-{vid}")


@app.get("/api/video/{vid}/csv", tags=["video benchmark"], response_class=PlainTextResponse)
def video_csv(vid: str) -> PlainTextResponse:
    res = service.videos.get(vid)
    if not res:
        raise HTTPException(404, "unknown video analysis")
    return PlainTextResponse(rows_to_csv(res["rows"]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="astraq-video-{vid}.csv"'})


# ── WebSocket ───────────────────────────────────────────────────
@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket) -> None:
    """Server → client: {type:'snapshot'|'config'|'status'|'error'} JSON + binary sensor frames.
    Client → server: the same command objects as POST /api/sim/command."""
    await ws.accept()
    service.clients.add(ws)
    await ws.send_json({"type": "config", "config": service.engine.cfg, "version": service.engine.config_version})
    await ws.send_json(service.status())
    try:
        while True:
            msg = await ws.receive_json()
            try:
                await service.command(msg)
            except (ValueError, TypeError) as err:
                await ws.send_json({"type": "error", "message": str(err)})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        service.clients.discard(ws)


@app.get("/", include_in_schema=False)
def root() -> dict:
    return {"name": "ASTRAQ engine", "docs": "/docs", "websocket": "/ws/telemetry", "health": "/api/health"}
