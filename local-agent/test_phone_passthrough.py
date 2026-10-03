"""Phone passthrough tests. Uses a fake phone (in-process HTTP calls); never ADB.

Run:  pip install fastapi httpx pytest && python -m pytest -q test_phone_passthrough.py
"""
import json
import re
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import nexus_agent as na

CAPS = ["snapshot", "take_screenshot", "click", "swipe", "input_text", "dump_ui"]


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    monkeypatch.setattr(na, "AGENT_TOKEN", "")
    with na._PHONE_LOCK:
        na._PHONE_AGENTS.clear(); na._PHONE_PENDING.clear()
        na._PHONE_RESULTS.clear(); na._PHONE_RESULT_AT.clear(); na._PHONE_EVENTS.clear()
    yield


@pytest.fixture
def client():
    return TestClient(na.app)


def register(client, caps=CAPS, agent_id="phone-1"):
    r = client.post("/agent/hello", json={"agent_id": agent_id, "device_model": "Pixel", "capabilities": caps})
    assert r.status_code == 200


class FakePhone:
    """Polls the agent like the real app and answers with a scripted envelope."""

    def __init__(self, client, respond, agent_id="phone-1"):
        self.client, self.respond, self.agent_id = client, respond, agent_id
        self.received = []
        self._stop = threading.Event()
        self.t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            r = self.client.post("/agent/poll", json={"agent_id": self.agent_id, "wait": 1})
            for cmd in r.json().get("commands", []):
                self.received.append(cmd)
                env = self.respond(cmd)
                if env is not None:
                    self.client.post("/agent/result", content=json.dumps({"request_id": cmd["request_id"], **env}),
                                     headers={"content-type": "application/json"})

    def __enter__(self):
        self.t.start(); return self

    def __exit__(self, *a):
        self._stop.set(); self.t.join(3)


def test_args_forwarded_identically_and_envelope_verbatim(client):
    register(client)
    args = {"x": 512.37, "y": 0, "nested": {"k": [1, "two", None]}, "unicode": "héllo"}
    envelope = {"ok": True, "code": "OK", "message": "clicked", "extra": {"a": 1}}
    with FakePhone(client, lambda c: envelope) as phone:
        r = client.post("/tool/phone_agent_command", json={"command": "click", "args": args, "timeout_sec": 10})
    assert r.status_code == 200
    assert phone.received[0]["command"] == "click"
    assert json.dumps(phone.received[0]["args"], sort_keys=True) == json.dumps(args, sort_keys=True)
    body = r.json()
    rid = body.pop("request_id")
    assert rid == phone.received[0]["request_id"]
    assert body == envelope


def test_wrapped_request_shape(client):
    register(client)
    with FakePhone(client, lambda c: {"ok": True, "code": "OK", "message": "m"}):
        r = client.post("/tool/phone_agent_command",
                        json={"tool": "phone_agent_command", "args": {"command": "swipe", "args": {"x1": 1}}})
    assert r.status_code == 200 and r.json()["code"] == "OK"


def test_phone_error_codes_pass_through(client):
    register(client)
    env = {"ok": False, "code": "TARGET_NOT_FOUND", "message": "no node"}
    with FakePhone(client, lambda c: env):
        r = client.post("/tool/phone_agent_command", json={"command": "click", "args": {}})
    assert r.status_code == 200
    body = r.json(); body.pop("request_id")
    assert body == env


def test_six_mb_screenshot_intact(client):
    register(client)
    big = ("QUJD" * (6 * 1024 * 1024 // 4))
    with FakePhone(client, lambda c: {"ok": True, "code": "OK", "message": "", "screenshot_b64": big,
                                      "width": 1080, "height": 2400}):
        r = client.post("/tool/phone_agent_command", json={"command": "take_screenshot", "args": {}})
    assert r.status_code == 200
    assert len(r.json()["screenshot_b64"]) == len(big) and r.json()["screenshot_b64"] == big


def test_503_when_no_phone(client):
    r = client.post("/tool/phone_agent_command", json={"command": "click", "args": {}})
    assert r.status_code == 503
    assert r.json() == {"ok": False, "code": "DEVICE_ERROR", "message": "phone_not_connected"}


def test_504_on_timeout(client):
    register(client)
    with FakePhone(client, lambda c: None):  # phone never answers
        t0 = time.time()
        r = client.post("/tool/phone_agent_command", json={"command": "click", "args": {}, "timeout_sec": 1})
    assert r.status_code == 504 and time.time() - t0 < 5
    assert r.json() == {"ok": False, "code": "TIMEOUT", "message": "phone_timeout"}


def test_400_unsupported(client):
    register(client)
    r = client.post("/tool/phone_agent_command", json={"command": "wait_for_text", "args": {}})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "UNSUPPORTED", "message": "unsupported_command", "command": "wait_for_text"}


@pytest.mark.parametrize("body", [[], {"args": {}}, {"command": "click", "args": [1]}, {"command": ""}])
def test_400_invalid_args(client, body):
    register(client)
    r = client.post("/tool/phone_agent_command", json=body)
    assert r.status_code == 400 and r.json()["code"] == "INVALID_ARGS" and r.json()["ok"] is False


def test_timeout_clamp():
    assert na.clamp_timeout(0) == 1
    assert na.clamp_timeout(999) == 120
    assert na.clamp_timeout(None) == 30
    assert na.clamp_timeout(45) == 45


def test_timeout_clamp_used_by_route(client, monkeypatch):
    register(client)
    seen = []
    monkeypatch.setattr(na, "_phone_dispatch", lambda c, a, t: seen.append(t) or {"ok": True})
    client.post("/tool/phone_agent_command", json={"command": "click", "timeout_sec": 0})
    client.post("/tool/phone_agent_command", json={"command": "click", "timeout_sec": 999})
    client.post("/tool/phone_agent_command", json={"command": "click"})
    assert seen == [1, 120, 30]


def test_status_returns_capabilities_unchanged(client):
    caps = ["take_screenshot", "click", "Weird-Name", "click"]
    register(client, caps=caps)
    r = client.get("/tool/phone_agent_status").json()
    assert r["connected"] is True
    assert r["agents"][0]["capabilities"] == caps
    assert r["agents"][0]["online"] is True and isinstance(r["agents"][0]["last_seen"], float)


def test_parallel_requests_not_mixed(client):
    register(client)
    with FakePhone(client, lambda c: {"ok": True, "code": "OK", "message": c["args"]["tag"]}):
        out = {}
        def go(tag):
            out[tag] = client.post("/tool/phone_agent_command",
                                   json={"command": "click", "args": {"tag": tag}}).json()["message"]
        ts = [threading.Thread(target=go, args=(f"t{i}",)) for i in range(5)]
        [t.start() for t in ts]; [t.join(15) for t in ts]
    assert out == {f"t{i}": f"t{i}" for i in range(5)}


def test_zero_adb_audit():
    here = Path(__file__).parent
    assert not (here / "android_manager.py").exists(), "android_manager.py must be deleted"
    patterns = [
        re.compile(r"\badb\b", re.I),
        re.compile(r"android_manager|AndroidManager", re.I),
        re.compile(r"platform-tools", re.I),
        re.compile(r"usb debugging", re.I),
        re.compile(r"fall ?back to adb|use adb", re.I),
        re.compile(r"subprocess\.[a-z_]+\([^)]*adb", re.I),
    ]
    files = [p for p in here.rglob("*") if p.is_file() and p.suffix in {".py", ".md", ".txt"}
             and not p.name.startswith("test_") and "__pycache__" not in p.parts]
    hits = []
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if any(p.search(line) for p in patterns):
                hits.append(f"{f.name}:{n}: {line.strip()}")
    assert not hits, "ADB references found:\n" + "\n".join(hits)
