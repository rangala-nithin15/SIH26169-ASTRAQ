"""API, WebSocket and video-benchmark tests (run: python -m pytest)."""
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
from astraq_engine.video import HAVE_CV2, synthesize_video


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health_and_status(client):
    assert client.get("/api/health").json()["ok"] is True
    s = client.get("/api/status").json()
    assert "state" in s and "running" in s


def test_step_and_telemetry(client):
    snap = client.post("/api/sim/step", params={"frames": 60}).json()
    assert snap["frame"] >= 60
    t = client.get("/api/telemetry").json()
    assert t["state"] in ("SEARCHING", "DETECTED", "ACQUIRING", "TRACKING", "LOCKED", "LOST", "REACQUIRING")
    h = client.get("/api/telemetry/history", params={"seconds": 1}).json()
    assert len(h["t"]) > 0


def test_start_stop_reset(client):
    assert client.post("/api/sim/stop").json()["running"] is False
    assert client.post("/api/sim/start").json()["running"] is True
    r = client.post("/api/sim/reset").json()
    assert r["running"] is True


def test_config_patch_and_presets(client):
    cfg = client.patch("/api/config", json={"target": {"trajectory": "figure8"}}).json()
    assert cfg["target"]["trajectory"] == "figure8"
    presets = client.get("/api/presets").json()
    assert any(p["id"] == "leo-pass" for p in presets)
    cfg = client.post("/api/presets/leo-pass").json()
    assert cfg["target"]["trajectory"] == "orbital"
    assert client.post("/api/presets/nope").status_code == 404
    client.post("/api/presets/open-sky")


def test_command_validation(client):
    assert client.post("/api/sim/command", json={"type": "bogus"}).status_code == 422
    assert client.post("/api/sim/command", json={"type": "timeScale", "value": 2}).status_code == 200
    client.post("/api/sim/command", json={"type": "timeScale", "value": 1})


def test_experiment_recording_and_export(client):
    client.post("/api/sim/start")
    ex = client.post("/api/experiments/start", json={"name": "pytest"}).json()
    client.post("/api/sim/step", params={"frames": 45})
    done = client.post("/api/experiments/stop").json()
    assert done["frames"] >= 45
    csv = client.get(f"/api/experiments/{ex['id']}/csv").text.splitlines()
    assert csv[0].startswith("t_s,frame,state")
    assert len(csv) >= 46
    js = client.get(f"/api/experiments/{ex['id']}/json").json()
    assert js["format"] == "astraq-recording" and len(js["frames"]) >= 45
    assert any(e["id"] == ex["id"] for e in client.get("/api/experiments").json())


def test_batch(client):
    r = client.post("/api/experiments/batch", json={"runs": 3, "durationS": 6, "preset": "open-sky"}).json()
    assert len(r["results"]) == 3
    assert r["aggregate"]["locked"] >= 2
    assert client.get(f"/api/experiments/{r['id']}/csv").text.startswith("seed,")


def test_frame_pgm(client):
    client.post("/api/sim/step", params={"frames": 2})
    r = client.get("/api/frame.pgm")
    assert r.status_code == 200 and r.content.startswith(b"P5")


def test_websocket_telemetry_and_commands(client):
    with client.websocket_connect("/ws/telemetry") as ws:
        first = ws.receive_json()
        assert first["type"] == "config"
        ws.send_json({"type": "start"})
        got_snapshot = got_frame = False
        for _ in range(400):
            msg = ws.receive()
            if msg.get("text"):
                import json

                m = json.loads(msg["text"])
                if m["type"] == "snapshot":
                    got_snapshot = True
                    assert "gimbal" in m["snapshot"]
            elif msg.get("bytes"):
                assert msg["bytes"][:4] == b"AQF1"
                got_frame = True
            if got_snapshot and got_frame:
                break
        assert got_snapshot and got_frame
        ws.send_json({"type": "pause"})


@pytest.mark.skipif(not HAVE_CV2, reason="opencv not installed")
def test_video_benchmark(client):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.mp4")
        truth = synthesize_video(path, seconds=3.0)
        with open(path, "rb") as f:
            r = client.post("/api/video/analyze", files={"file": ("t.mp4", f, "video/mp4"), "truth": ("t.csv", truth, "text/csv")}, data={"spotSizePx": 10})
        assert r.status_code == 200, r.text
        s = r.json()["summary"]
        assert s["frames"] == 90
        assert s["detectionRatePct"] > 90
        assert s["acquisitionS"] is not None and s["acquisitionS"] < 0.5
        assert s["centroidRmsePx"] < 1.5
        csv = client.get(r.json()["csv"]).text.splitlines()
        assert csv[0].startswith("frame,t_s,state") and len(csv) == 91
        rep = client.get(r.json()["report"])
        assert rep.status_code == 200 and "Video benchmark" in rep.text and "Centroid RMSE" in rep.text


def test_video_benchmark_full_screen_auto_spot(client):
    """2000x2000 'complete screen' video with salt & pepper and an outage; spot size estimated automatically."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "s.mp4")
        truth = synthesize_video(path, seconds=2.0, size=(2000, 2000), noise=12, salt_pepper=0.01, outage=(1.0, 0.4))
        with open(path, "rb") as f:
            r = client.post("/api/video/analyze", files={"file": ("s.mp4", f, "video/mp4"), "truth": ("s.csv", truth, "text/csv")})
        assert r.status_code == 200, r.text
        s = r.json()["summary"]
        assert s["width"] == 2000 and s["frames"] == 60
        assert 8 <= s["spotSizePx"] <= 14
        assert s["acquisitionS"] is not None and s["acquisitionS"] < 0.5
        assert s["centroidRmsePx"] < 1.0
        assert s["reacqMaxS"] is not None and s["reacqMaxS"] <= 1.0


def test_live_and_batch_reports(client):
    client.post("/api/sim/step?frames=90")
    r = client.get("/api/report")
    assert r.status_code == 200 and "Performance summary" in r.text and "Lock retention" in r.text
    md = client.get("/api/report?format=md").text
    assert "| Metric |" in md
    b = client.post("/api/experiments/batch", json={"runs": 2, "durationS": 3, "preset": "open-sky"}).json()
    eid = b.get("id") or b.get("experiment", {}).get("id")
    rep = client.get(f"/api/experiments/{eid}/report?format=json").json()
    assert rep["kind"] == "batch" and len(rep["batch"]["rows"]) == 2
