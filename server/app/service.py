"""
Simulation service: owns one SimulationEngine, runs it in real time on an asyncio
task, fans telemetry out to WebSocket clients and records experiments.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import struct
import time
import uuid
from typing import Any

from astraq_engine import DEFAULT_CONFIG, SimulationEngine, json_safe, merge, preset_config
from astraq_engine.config import clone

CSV_COLUMNS = [
    "t_s", "frame", "state", "target_az_deg", "target_el_deg", "target_u_deg", "target_v_deg", "target_rate_deg_s", "range_km",
    "pan_deg", "tilt_deg", "pan_rate_deg_s", "tilt_rate_deg_s", "pan_cmd_deg_s", "tilt_cmd_deg_s", "hfov_deg", "det_valid",
    "det_x_px", "det_y_px", "det_confidence", "truth_x_px", "truth_y_px", "err_x_px", "err_y_px", "err_px", "err_deg",
    "kf_est_x_px", "kf_est_y_px", "kf_az_rate_deg_s", "kf_el_rate_deg_s", "proc_ms", "transmission", "aqs",
]  # identical to web/src/core/telemetry/recorder.ts


def snapshot_row(s: dict) -> list:
    d = s.get("detection") or {}
    tp = s["target"].get("truthPx") or [None, None]
    ep = s["error"].get("px") or [None, None]
    kp = s["kalman"].get("estPx") or [None, None]
    g = s["gimbal"]
    return [
        s["t"], s["frame"], s["state"], s["target"]["az"], s["target"]["el"], s["target"]["u"], s["target"]["v"], s["target"]["angRateDegS"],
        s["target"]["rangeKm"], g["pan"], g["tilt"], g["panRate"], g["tiltRate"], g["panCmd"], g["tiltCmd"], s["camera"]["hfovDeg"],
        1 if d else 0, d.get("x"), d.get("y"), d.get("confidence"), tp[0], tp[1], ep[0], ep[1], s["error"]["magPx"], s["error"]["angDeg"],
        kp[0], kp[1], s["kalman"]["azRate"], s["kalman"]["elRate"], s["procMs"], s["disturbance"]["transmission"], s["metrics"]["aqs"],
    ]


def to_csv(frames: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for s in frames:
        w.writerow(["" if v is None else (round(v, 5) if isinstance(v, float) else v) for v in snapshot_row(s)])
    return buf.getvalue()


def frame_packet(frame) -> bytes:
    """Binary sensor frame: b'AQF1' + uint16 width + uint16 height + uint32 frame no. + pixels."""
    return struct.pack(">I", 0x41514631) + struct.pack("<HHI", frame["width"], frame["height"], frame["frame"]) + frame["data"]


class Experiment:
    def __init__(self, name: str, config: dict):
        self.id = uuid.uuid4().hex[:10]
        self.name = name
        self.created = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.config = clone(config)
        self.frames: list[dict] = []
        self.events: list[dict] = []
        self.active = True
        self.kind = "live"
        self.batch: list[dict] | None = None

    def meta(self) -> dict:
        last = self.frames[-1]["metrics"] if self.frames else None
        return {"id": self.id, "name": self.name, "created": self.created, "kind": self.kind, "frames": len(self.frames), "active": self.active, "summary": last, "runs": len(self.batch) if self.batch else None}

    def recording(self) -> dict:
        return {"format": "astraq-recording", "version": 1, "name": self.name, "createdAt": self.created, "source": "remote", "config": self.config, "frames": self.frames, "events": self.events}


class SimulationService:
    def __init__(self) -> None:
        self.engine = SimulationEngine(DEFAULT_CONFIG)
        self.engine.source = "remote"
        self.engine.start()
        self.clients: set[Any] = set()
        self.latest: dict | None = None
        self.history: list[dict] = []
        self.time_scale = 1.0
        self.image_rate = 10.0
        self.fps = 0.0
        self._task: asyncio.Task | None = None
        self._sent_version = -1
        self._last_image_t = -1.0
        self.experiments: dict[str, Experiment] = {}
        self.recording: Experiment | None = None
        self.videos: dict[str, dict] = {}
        self.lock = asyncio.Lock()

    # ── loop ─────────────────────────────────────────────────────
    def start_loop(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.get_event_loop().create_task(self._loop())

    async def stop_loop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def _loop(self) -> None:
        acc = 0.0
        last = time.perf_counter()
        step_times: list[float] = []
        while True:
            now = time.perf_counter()
            acc = min(acc + (now - last) * self.time_scale, 4 / self.engine.cfg["camera"]["frameRateHz"])
            last = now
            dtf = 1 / self.engine.cfg["camera"]["frameRateHz"]
            if self.engine.running:
                n = 0
                while acc >= dtf and n < 3:
                    async with self.lock:
                        t0 = time.perf_counter()
                        await self._step_and_publish()
                        cap = 1 / max(1e-4, time.perf_counter() - t0)
                        self.engine.metrics.fps = cap if self.engine.metrics.fps == 0 else 0.95 * self.engine.metrics.fps + 0.05 * cap
                    acc -= dtf
                    n += 1
                    step_times.append(now)
            else:
                acc = 0.0
            step_times = [x for x in step_times if now - x <= 1.0]
            self.fps = float(len(step_times))
            await asyncio.sleep(max(0.002, dtf / max(0.1, self.time_scale) * 0.4))

    async def _step_and_publish(self) -> dict:
        snap = json_safe(self.engine.step())
        self.latest = snap
        self.history.append(snap)
        if len(self.history) > 30 * 60:
            self.history.pop(0)
        if self.recording and self.recording.active:
            rec = {k: v for k, v in snap.items() if k != "plan"}
            self.recording.frames.append(rec)
            self.recording.events.extend(snap["events"])
        await self.broadcast({"type": "snapshot", "snapshot": snap})
        fr = self.engine.last_frame
        if fr is not None and self.clients and (snap["t"] - self._last_image_t >= 1 / self.image_rate - 1e-6 or snap["t"] < self._last_image_t):
            self._last_image_t = snap["t"]
            await self.broadcast_bytes(frame_packet({"width": fr.width, "height": fr.height, "frame": snap["frame"], "data": fr.data.tobytes()}))
        await self.maybe_send_config()
        if snap["frame"] % 10 == 0:
            await self.broadcast(self.status())
        return snap

    def status(self) -> dict:
        return {"type": "status", "running": self.engine.running, "demo": self.engine.demo_active, "fps": self.fps, "timeScale": self.time_scale}

    async def maybe_send_config(self, force: bool = False) -> None:
        if force or self.engine.config_version != self._sent_version:
            self._sent_version = self.engine.config_version
            await self.broadcast({"type": "config", "config": self.engine.cfg, "version": self._sent_version})

    async def broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        text = json.dumps(msg, separators=(",", ":"), allow_nan=False, default=float)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def broadcast_bytes(self, data: bytes) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_bytes(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ── commands (shared by REST and WebSocket) ──────────────────
    async def command(self, cmd: dict) -> None:
        e = self.engine
        t = cmd.get("type")
        async with self.lock:
            if t == "start":
                e.start()
            elif t == "pause":
                e.pause()
            elif t == "reset":
                e.reset()
                self.history.clear()
                self._last_image_t = -1
            elif t == "config":
                e.apply_config(cmd.get("patch") or {})
            elif t == "replaceConfig":
                cfg = cmd.get("config") or {}
                e.apply_config({**cfg, "seed": cfg.get("seed", e.cfg["seed"]), "scene": cfg.get("scene", e.cfg["scene"])})
            elif t == "demo":
                e.set_demo(bool(cmd.get("on")))
            elif t == "mode":
                e.set_mode("manual" if cmd.get("mode") == "manual" else "auto")
            elif t == "manual":
                e.set_manual_goal(float(cmd.get("pan", 0)), float(cmd.get("tilt", 0)))
            elif t == "reacquire":
                e.reacquire()
            elif t == "timeScale":
                self.time_scale = min(4.0, max(0.1, float(cmd.get("value", 1))))
            elif t == "imageRate":
                self.image_rate = min(30.0, max(1.0, float(cmd.get("hz", 10))))
            else:
                raise ValueError(f"unknown command type: {t!r}")
        await self.maybe_send_config()
        await self.broadcast(self.status())

    def apply_preset(self, pid: str, seed: int | None = None) -> dict:
        cfg = preset_config(pid, seed if seed is not None else self.engine.cfg["seed"])
        self.engine.apply_config(cfg)
        return self.engine.cfg

    # ── experiments ─────────────────────────────────────────────
    def start_recording(self, name: str) -> Experiment:
        if self.recording and self.recording.active:
            self.recording.active = False
        ex = Experiment(name or f"Run {time.strftime('%H:%M:%S')}", self.engine.cfg)
        self.experiments[ex.id] = ex
        self.recording = ex
        return ex

    def stop_recording(self) -> Experiment | None:
        ex = self.recording
        if ex:
            ex.active = False
        self.recording = None
        return ex

    def run_batch(self, config: dict, runs: int, duration_s: float, seed0: int) -> Experiment:
        ex = Experiment(f"Batch {runs}x{duration_s:.0f}s", config)
        ex.kind = "batch"
        ex.active = False
        results = []
        for r in range(runs):
            eng = SimulationEngine(merge(config, {"seed": seed0 + r}))
            eng.render_always = False
            eng.start()
            frames = int(duration_s * eng.cfg["camera"]["frameRateHz"])
            snap = eng.step()
            t0 = time.perf_counter()
            for _ in range(frames - 1):
                snap = eng.step()
            per = (time.perf_counter() - t0) / max(1, frames - 1)
            m = snap["metrics"]
            m["fps"] = 1 / max(1e-6, per)
            m["acceptance"]["fps"] = m["fps"] >= 20
            results.append(json_safe({"seed": seed0 + r, "finalState": snap["state"], "metrics": m}))
        ex.batch = results
        self.experiments[ex.id] = ex
        return ex
