"""Desktop automation tests. Everything is mocked — no real mouse/keyboard/windows.

Run:  pip install fastapi httpx pytest && python -m pytest -q test_desktop_actions.py
"""
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import nexus_agent as na


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    monkeypatch.setattr(na, "AGENT_TOKEN", "")
    na._desktop_state["controls"] = []
    na._desktop_state["window_title"] = None
    na._desktop_state["ts"] = 0.0
    na._launch_cache.clear()
    yield


@pytest.fixture
def client():
    return TestClient(na.app)


class FakeWindow(dict):
    def __init__(self, handle, title, process="app.exe"):
        super().__init__(handle=handle, title=title, process=process)
        self.handle = handle
        self.title = title
        self.process = process


# ---------- launch_app search order ----------

def test_launch_app_already_running_is_success(client, monkeypatch):
    win = FakeWindow(11, "TLauncher")
    monkeypatch.setattr(na, "_matching_windows", lambda name: [win])
    focused = []
    monkeypatch.setattr(na, "_focus_window", lambda h: focused.append(h) or True)
    monkeypatch.setattr(na.os, "startfile", lambda p: (_ for _ in ()).throw(AssertionError("must not launch")), raising=False)

    r = client.post("/tool/launch_app", json={"name": "tlauncher"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["tier"] == "already_running"
    assert focused == [11]


def test_launch_app_desktop_hit(client, monkeypatch, tmp_path):
    (tmp_path / "TLauncher.lnk").write_text("x")
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    monkeypatch.setattr(na, "_default_search_dirs", lambda: [tmp_path, tmp_path / "Others"])
    launched = []
    monkeypatch.setattr(na.os, "startfile", lambda p: launched.append(p), raising=False)
    monkeypatch.setattr(na, "_wait_and_focus", lambda name, timeout_sec=8.0: {"title": "TLauncher", "handle": 5})

    r = client.post("/tool/launch_app", json={"name": "t launcher"})
    body = r.json()
    assert body["ok"] is True and body["tier"] == "shortcut"
    assert launched == [str(tmp_path / "TLauncher.lnk")]
    assert body["window"] == "TLauncher"


def test_launch_app_others_folder_hit(client, monkeypatch, tmp_path):
    others = tmp_path / "Others"
    others.mkdir()
    (others / "RareApp.exe").write_text("x")
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    monkeypatch.setattr(na, "_default_search_dirs", lambda: [tmp_path, others])
    monkeypatch.setattr(na.os, "startfile", lambda p: None, raising=False)
    monkeypatch.setattr(na, "_wait_and_focus", lambda name, timeout_sec=8.0: None)

    r = client.post("/tool/launch_app", json={"name": "rareapp"})
    body = r.json()
    assert body["ok"] is True and body["tier"] == "shortcut"
    assert body["launched"].endswith("RareApp.exe")


def test_launch_app_falls_through_to_validated_search(client, monkeypatch, tmp_path):
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    monkeypatch.setattr(na, "_default_search_dirs", lambda: [tmp_path])
    calls = {}

    def fake_search(name):
        calls["name"] = name
        return {"ok": True, "tier": "windows_search"}

    monkeypatch.setattr(na, "_windows_search_launch", fake_search)
    monkeypatch.setattr(na, "_wait_and_focus", lambda name, timeout_sec=8.0: {"title": "Steam", "handle": 9})

    r = client.post("/tool/launch_app", json={"name": "steam"})
    body = r.json()
    assert body["ok"] is True and body["tier"] == "windows_search"
    assert calls["name"] == "steam"


def test_launch_app_rejects_mismatched_search_result(client, monkeypatch, tmp_path):
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    monkeypatch.setattr(na, "_default_search_dirs", lambda: [tmp_path])
    monkeypatch.setattr(na, "_windows_search_launch",
                        lambda name: {"ok": False, "tier": "windows_search", "error": "no match"})

    r = client.post("/tool/launch_app", json={"name": "nonexistentapp"})
    body = r.json()
    assert body["ok"] is False and "no match" in body["error"]


def test_launch_app_tie_is_reported_not_guessed(client, monkeypatch, tmp_path):
    (tmp_path / "My App (2).lnk").write_text("x")
    (tmp_path / "My App (3).lnk").write_text("x")
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    monkeypatch.setattr(na, "_default_search_dirs", lambda: [tmp_path])
    monkeypatch.setattr(na.os, "startfile",
                        lambda p: (_ for _ in ()).throw(AssertionError("must not guess a tie")), raising=False)

    r = client.post("/tool/launch_app", json={"name": "my app"})
    body = r.json()
    assert body["ok"] is False
    assert "Several shortcuts match" in body["error"]


def test_default_search_dirs_use_userprofile(monkeypatch):
    monkeypatch.setenv("USERPROFILE", r"C:\Users\someone")
    monkeypatch.setattr(Path, "exists", lambda self: True)
    dirs = na._default_search_dirs()
    assert dirs[0].parts[-2:] == ("OneDrive", "Desktop")
    assert dirs[1].parts[-3:] == ("OneDrive", "Desktop", "Others")
    assert "someone" in str(dirs[0]) and "kshaks" not in str(dirs[0])


# ---------- show_desktop idempotency ----------

def test_show_desktop_skips_wind_when_already_visible(client, monkeypatch):
    monkeypatch.setattr(na, "_desktop_visible", lambda: True)
    pressed = []
    fake = type("P", (), {"hotkey": staticmethod(lambda *k: pressed.append(k))})
    monkeypatch.setattr(na, "_import_pyautogui", lambda: fake)

    r = client.post("/tool/show_desktop")
    body = r.json()
    assert body["ok"] is True and body["already"] is True
    assert pressed == []  # Win+D is a toggle — never pressed blindly


def test_show_desktop_presses_wind_only_when_needed(client, monkeypatch):
    state = {"visible": False}
    monkeypatch.setattr(na, "_desktop_visible", lambda: state["visible"])

    def hotkey(*keys):
        state["visible"] = True  # simulate the toggle

    fake = type("P", (), {"hotkey": staticmethod(hotkey)})
    monkeypatch.setattr(na, "_import_pyautogui", lambda: fake)

    r = client.post("/tool/show_desktop")
    body = r.json()
    assert body["ok"] is True and body["already"] is False and body["desktop_visible"] is True


# ---------- click fixes ----------

def _fake_pyautogui(record):
    return type("P", (), {
        "moveTo": staticmethod(lambda *a, **k: record.append(("move", a, k))),
        "click": staticmethod(lambda *a, **k: record.append(("click", a, k))),
    })


def test_desktop_click_double(client, monkeypatch):
    record = []
    monkeypatch.setattr(na, "_import_pyautogui", lambda: _fake_pyautogui(record))
    r = client.post("/tool/desktop_click", json={"x": 100, "y": 200, "double": True})
    assert r.status_code == 200
    clicks = [c for c in record if c[0] == "click"]
    assert clicks and clicks[0][2]["clicks"] == 2
    assert r.json()["clicked"]["clicks"] == 2


def test_desktop_click_focus_failure_refuses_action(client, monkeypatch):
    record = []
    monkeypatch.setattr(na, "_import_pyautogui", lambda: _fake_pyautogui(record))
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    r = client.post("/tool/desktop_click", json={"x": 1, "y": 2, "window": "Missing App"})
    assert r.status_code == 404
    assert record == []  # no click happened


def test_desktop_click_ambiguous_window_refuses_action(client, monkeypatch):
    record = []
    monkeypatch.setattr(na, "_import_pyautogui", lambda: _fake_pyautogui(record))
    wins = [FakeWindow(1, "Chrome — Tab A"), FakeWindow(2, "Chrome — Tab A")]
    monkeypatch.setattr(na, "_matching_windows", lambda name: wins)
    r = client.post("/tool/desktop_click", json={"x": 1, "y": 2, "window": "chrome"})
    assert r.status_code == 409
    assert record == []


def test_desktop_click_failsafe_reported(client, monkeypatch):
    class FailSafeException(Exception):
        pass

    def boom(*a, **k):
        raise FailSafeException("corner")

    fake = type("P", (), {"moveTo": staticmethod(lambda *a, **k: None), "click": staticmethod(boom),
                          "FailSafeException": FailSafeException})
    monkeypatch.setattr(na, "_import_pyautogui", lambda: fake)
    r = client.post("/tool/desktop_click", json={"x": 0, "y": 0})
    assert r.status_code == 500
    assert "safety switch" in r.json()["detail"]


# ---------- stale-cache protection ----------

def test_stale_cache_is_not_reused(monkeypatch):
    na._desktop_state["controls"] = [{"text": "Old Button", "x": 1, "y": 2}]
    na._desktop_state["window_title"] = "Old Window"
    na._desktop_state["ts"] = time.monotonic()
    monkeypatch.setattr(na, "_active_window_info", lambda: {"title": "New Window"})
    assert na._desktop_cache_fresh() is False


def test_fresh_cache_same_window_is_reused(monkeypatch):
    na._desktop_state["controls"] = [{"text": "OK", "x": 1, "y": 2}]
    na._desktop_state["window_title"] = "Same"
    na._desktop_state["ts"] = time.monotonic()
    monkeypatch.setattr(na, "_active_window_info", lambda: {"title": "Same"})
    assert na._desktop_cache_fresh() is True


def test_action_invalidates_cache():
    na._desktop_state["controls"] = [{"text": "X", "x": 1, "y": 2}]
    na._desktop_state["ts"] = time.monotonic()
    na._invalidate_desktop_cache()
    assert na._desktop_state["controls"] == [] and na._desktop_state["ts"] == 0.0


# ---------- fast desktop_read ----------

def test_desktop_read_skips_ocr_by_default(client, monkeypatch):
    fake = type("P", (), {
        "size": staticmethod(lambda: type("S", (), {"width": 1920, "height": 1080})()),
        "position": staticmethod(lambda: type("P", (), {"x": 0, "y": 0})()),
        "screenshot": staticmethod(lambda: object()),
    })
    monkeypatch.setattr(na, "_import_pyautogui", lambda: fake)
    monkeypatch.setattr(na, "_read_desktop_controls", lambda: ([], None))
    monkeypatch.setattr(na, "_active_window_info", lambda: {"title": "W"})
    monkeypatch.setattr(na, "_encode_screenshot", lambda s: None)

    def ocr_should_not_run(*a, **k):
        raise AssertionError("OCR must be opt-in")

    monkeypatch.setattr(na, "_read_desktop_ocr", ocr_should_not_run)
    r = client.post("/tool/desktop_read", json={})
    assert r.status_code == 200
    assert r.json()["ocr"] == []


def test_controls_scan_respects_deadline(monkeypatch):
    class SlowCtrl:
        def rectangle(self):
            time.sleep(0.05)
            return type("R", (), {"left": 0, "top": 0, "right": 10, "bottom": 10,
                                  "width": lambda s: 10, "height": lambda s: 10})()

        def window_text(self):
            return "x"

        element_info = type("E", (), {"control_type": "Button", "class_name": "C"})()

        def children(self):
            return [SlowCtrl()]

    class SlowActive(SlowCtrl):
        pass

    class FakeDesktop:
        def __init__(self, backend=None):
            pass

        def get_active(self):
            return SlowActive()

    monkeypatch.setattr(na, "_import_pywinauto", lambda: FakeDesktop)
    start = time.monotonic()
    controls, note = na._read_desktop_controls(deadline_sec=0.3)
    assert time.monotonic() - start < 2.0
    assert note is None or "time limit" in note


# ---------- Windows search fix + window / media / folder tools ----------

class _FakeGui:
    def __init__(self):
        self.calls = []
    def press(self, key, presses=1, interval=0.0):
        self.calls.append(("press", key, presses))
    def hotkey(self, *keys):
        self.calls.append(("hotkey",) + keys)
    def write(self, text, interval=0.0):
        self.calls.append(("write", text))


def test_search_presses_enter_when_xaml_result_matches(monkeypatch):
    gui = _FakeGui()
    monkeypatch.setattr(na, "_import_pyautogui", lambda: gui)
    monkeypatch.setattr(na.time, "sleep", lambda s: None)
    monkeypatch.setattr(na, "_search_result_text", lambda: "Best match Spotify App")
    r = na._windows_search_launch("spotify")
    assert r["ok"] is True and r["verified_result"] is True
    assert ("press", "enter", 1) in gui.calls and ("press", "esc", 1) not in gui.calls


def test_search_unreadable_results_still_press_enter(monkeypatch):
    gui = _FakeGui()
    monkeypatch.setattr(na, "_import_pyautogui", lambda: gui)
    monkeypatch.setattr(na.time, "sleep", lambda s: None)
    monkeypatch.setattr(na, "_search_result_text", lambda: "")
    r = na._windows_search_launch("spotify")
    assert r["ok"] is True and r["verified_result"] is False
    assert ("press", "enter", 1) in gui.calls


def test_search_mismatch_presses_esc(monkeypatch):
    gui = _FakeGui()
    monkeypatch.setattr(na, "_import_pyautogui", lambda: gui)
    monkeypatch.setattr(na.time, "sleep", lambda s: None)
    monkeypatch.setattr(na, "_search_result_text", lambda: "Search the web Bing")
    r = na._windows_search_launch("spotify")
    assert r["ok"] is False
    assert ("press", "esc", 1) in gui.calls and ("press", "enter", 1) not in gui.calls


def test_unverified_search_without_window_is_failure(client, monkeypatch, tmp_path):
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    monkeypatch.setattr(na, "_default_search_dirs", lambda: [tmp_path])
    monkeypatch.setattr(na, "_windows_search_launch",
                        lambda name: {"ok": True, "tier": "windows_search", "verified_result": False})
    monkeypatch.setattr(na, "_wait_and_focus", lambda name, timeout_sec=8.0: None)
    body = client.post("/tool/launch_app", json={"name": "ghostapp"}).json()
    assert body["ok"] is False and "no matching window" in body["error"]


def test_list_windows(client, monkeypatch):
    monkeypatch.setattr(na, "_list_top_windows", lambda: [{"handle": 1, "title": "Spotify", "process": "Spotify.exe"}])
    monkeypatch.setattr(na, "_active_window_info", lambda: {"title": "Spotify"})
    body = client.post("/tool/list_windows", json={}).json()
    assert body["windows"] == [{"title": "Spotify", "process": "Spotify.exe"}] and body["active"] == "Spotify"


def test_close_app_already_closed(client, monkeypatch):
    monkeypatch.setattr(na, "_matching_windows", lambda name: [])
    body = client.post("/tool/close_app", json={"name": "notepad"}).json()
    assert body["ok"] is True and body["already_closed"] is True


def test_window_action_snap_and_ambiguous(client, monkeypatch):
    gui = _FakeGui()
    monkeypatch.setattr(na, "_import_pyautogui", lambda: gui)
    monkeypatch.setattr(na.time, "sleep", lambda s: None)
    monkeypatch.setattr(na, "_active_window_info", lambda: {"title": "Chrome"})
    body = client.post("/tool/window_action", json={"action": "snap_left"}).json()
    assert body["ok"] is True and ("hotkey", "win", "left") in gui.calls

    monkeypatch.setattr(na, "_matching_windows", lambda name: [
        {"handle": 1, "title": "Chrome - A", "process": "chrome.exe"},
        {"handle": 2, "title": "Chrome Remote", "process": "remoting.exe"}])
    r = client.post("/tool/window_action", json={"name": "chrome", "action": "maximize"})
    assert r.status_code == 409
    assert client.post("/tool/window_action", json={"action": "explode"}).status_code == 400


def test_set_volume_and_media(client, monkeypatch):
    gui = _FakeGui()
    monkeypatch.setattr(na, "_import_pyautogui", lambda: gui)
    body = client.post("/tool/set_volume", json={"level": 40}).json()
    assert body["level"] == 40
    assert ("press", "volumedown", 50) in gui.calls and ("press", "volumeup", 20) in gui.calls
    assert client.post("/tool/set_volume", json={}).status_code == 400
    assert client.post("/tool/media_control", json={"action": "next"}).json()["key"] == "nexttrack"
    assert client.post("/tool/media_control", json={"action": "dance"}).status_code == 400


def test_open_folder_alias_and_missing(client, monkeypatch, tmp_path):
    (tmp_path / "Downloads").mkdir()
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.delenv("OneDrive", raising=False)
    opened = []
    monkeypatch.setattr(na.os, "startfile", lambda p: opened.append(p), raising=False)
    body = client.post("/tool/open_folder", json={"target": "my downloads folder"}).json()
    assert body["ok"] is True and opened and opened[0].endswith("Downloads")
    assert client.post("/tool/open_folder", json={"target": str(tmp_path / "nope")}).status_code == 404
