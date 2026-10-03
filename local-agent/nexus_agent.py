"""
NEXUS Local Helper Agent
=========================
A tiny FastAPI server that NEXUS (the web UI) calls to actually control
your computer. It runs ENTIRELY on your machine — nothing is sent to the
cloud beyond what NEXUS itself decides.

⚠️  SECURITY WARNING ⚠️
This agent will execute ANY shell command the web UI tells it to. Only run it
on a machine you trust, only while you're using NEXUS, and never expose port
7337 to the public internet.

Binding
-------
By default it binds to 127.0.0.1. To let the NEXUS Android Agent reach it over
Tailscale, set NEXUS_AGENT_HOST to your tailnet IP before starting:

    set NEXUS_AGENT_HOST=100.104.193.77     (Windows)
    export NEXUS_AGENT_HOST=100.104.193.77  (macOS/Linux)

Setup
-----
1. pip install fastapi uvicorn
2. python nexus_agent.py
3. Leave it running. Open the NEXUS web app — the "LOCAL AGENT" indicator
   should turn cyan.

Set NEXUS_AGENT_TOKEN to require a shared secret (strongly recommended once the
agent is reachable over the tailnet). The Android Agent sends the same value.
"""


import os
import sys
import shutil
import platform
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

# Bumped whenever the tool surface changes. The web UI compares this against the
# tools it expects so a stale, still-running agent is reported as such instead of
# surfacing bare 404s.
AGENT_VERSION = "2026.10.04"

# Phone tools this build exposes (used by /health and diagnostics). Every phone
# action goes through the NEXUS Android Agent app over the tailnet link.
ANDROID_TOOLS = [
    "phone_agent_status",
    "phone_agent_command",
    "phone_ping",
    "phone_info",
]


# ---- Browser cowork (Selenium / installed Chrome) ----
# Lazy-imported so the agent still runs if Selenium isn't installed yet.
_browser_lock = threading.Lock()
_browser_state = {
    "driver": None,
}
_desktop_state = {
    "controls": [],
    # Cache freshness: click-by-text targets are only reused while the active
    # window is unchanged and the read is younger than _DESKTOP_CACHE_TTL.
    "window_title": None,
    "ts": 0.0,
}
_DESKTOP_CACHE_TTL = 10.0  # seconds


def _run_current_python_module(*args: str) -> subprocess.CompletedProcess[str]:
    """Run a Python module using the exact interpreter that launched this agent."""
    return subprocess.run(
        [sys.executable, "-m", *args],
        capture_output=True,
        text=True,
        timeout=180,
    )


def _import_selenium():
    """Import Selenium, installing it into this interpreter if needed."""
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.common.action_chains import ActionChains
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        return webdriver, By, Keys, ActionChains, WebDriverWait, EC
    except ImportError as first_error:
        install = _run_current_python_module("pip", "install", "selenium")
        if install.returncode != 0:
            raise HTTPException(
                500,
                "Selenium is not installed for the Python interpreter running this agent. "
                f"Agent Python: {sys.executable}\n"
                f"Install failed:\n{install.stdout}\n{install.stderr}\n"
                "Fix manually with:\n"
                f'"{sys.executable}" -m pip install selenium',
            ) from first_error
        try:
            from selenium import webdriver
            from selenium.webdriver.common.by import By
            from selenium.webdriver.common.keys import Keys
            from selenium.webdriver.common.action_chains import ActionChains
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            return webdriver, By, Keys, ActionChains, WebDriverWait, EC
        except ImportError as second_error:
            raise HTTPException(
                500,
                "Selenium still cannot be imported by the agent after install. "
                f"Agent Python: {sys.executable}\n"
                "Fix manually with:\n"
                f'"{sys.executable}" -m pip install selenium',
            ) from second_error


def _import_pyautogui():
    """Import PyAutoGUI, installing it into this interpreter if needed."""
    try:
        import pyautogui  # type: ignore
        return pyautogui
    except ImportError as first_error:
        install = _run_current_python_module("pip", "install", "pyautogui", "pillow")
        if install.returncode != 0:
            raise HTTPException(
                500,
                "PyAutoGUI is not installed for the Python interpreter running this agent. "
                f"Agent Python: {sys.executable}\n"
                f"Install failed:\n{install.stdout}\n{install.stderr}\n"
                "Fix manually with:\n"
                f'"{sys.executable}" -m pip install pyautogui pillow',
            ) from first_error
        try:
            import pyautogui  # type: ignore
            return pyautogui
        except ImportError as second_error:
            raise HTTPException(
                500,
                "PyAutoGUI still cannot be imported by the agent after install. "
                f"Agent Python: {sys.executable}\n"
                "Fix manually with:\n"
                f'"{sys.executable}" -m pip install pyautogui pillow',
            ) from second_error


def _import_pyperclip():
    """Import pyperclip, installing it into this interpreter if needed."""
    try:
        import pyperclip  # type: ignore
        return pyperclip
    except ImportError:
        install = _run_current_python_module("pip", "install", "pyperclip")
        if install.returncode != 0:
            return None
        try:
            import pyperclip  # type: ignore
            return pyperclip
        except ImportError:
            return None


def _import_cv2():
    """Optional OCR helper import; returns None if unavailable."""
    try:
        import cv2  # type: ignore
        return cv2
    except ImportError:
        install = _run_current_python_module("pip", "install", "opencv-python")
        if install.returncode != 0:
            return None
        try:
            import cv2  # type: ignore
            return cv2
        except ImportError:
            return None


_TESSERACT_CANDIDATE_PATHS = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    os.path.expanduser(r"~\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"),
    os.path.expanduser(r"~\AppData\Local\Tesseract-OCR\tesseract.exe"),
    "/opt/homebrew/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/usr/bin/tesseract",
]


def _locate_tesseract_binary():
    """Find the Tesseract binary on disk even if it isn't in PATH."""
    found = shutil.which("tesseract")
    if found:
        return found
    for candidate in _TESSERACT_CANDIDATE_PATHS:
        try:
            if candidate and os.path.exists(candidate):
                return candidate
        except Exception:
            continue
    return None


def _import_pytesseract():
    """Optional OCR import; requires the Tesseract desktop app to be installed too."""
    try:
        import pytesseract  # type: ignore
    except ImportError:
        install = _run_current_python_module("pip", "install", "pytesseract")
        if install.returncode != 0:
            return None
        try:
            import pytesseract  # type: ignore
        except ImportError:
            return None
    # Auto-wire the binary path on Windows where Tesseract is rarely in PATH.
    try:
        binary = _locate_tesseract_binary()
        if binary:
            pytesseract.pytesseract.tesseract_cmd = binary
    except Exception:
        pass
    return pytesseract


def _import_pywinauto():
    """Optional Windows UI Automation import for reading/clicking desktop app controls."""
    if not IS_WIN:
        return None
    try:
        from pywinauto import Desktop  # type: ignore
        return Desktop
    except ImportError:
        install = _run_current_python_module("pip", "install", "pywinauto")
        if install.returncode != 0:
            return None
        try:
            from pywinauto import Desktop  # type: ignore
            return Desktop
        except ImportError:
            return None


CURSOR_OVERLAY_JS = r"""
(() => {
  if (window.__nexusCursor) return;
  const c = document.createElement('div');
  c.id = '__nexus_cursor';
  c.style.cssText = [
    'position:fixed','left:-100px','top:-100px','width:22px','height:22px',
    'border-radius:50%','background:radial-gradient(circle,#ff2a2a 0%,#ff0000 50%,rgba(255,0,0,0) 80%)',
    'box-shadow:0 0 18px 6px rgba(255,40,40,0.85),0 0 40px 12px rgba(255,0,0,0.45)',
    'pointer-events:none','z-index:2147483647','transition:left 120ms linear,top 120ms linear',
    'border:2px solid #fff'
  ].join(';');
  const label = document.createElement('div');
  label.textContent = 'NEXUS';
  label.style.cssText = 'position:absolute;left:26px;top:6px;font:bold 10px monospace;color:#fff;text-shadow:0 0 4px #ff0000;letter-spacing:2px;';
  c.appendChild(label);
  document.documentElement.appendChild(c);
  window.__nexusCursor = c;
  window.__nexusMove = (x,y) => { c.style.left = (x-11)+'px'; c.style.top = (y-11)+'px'; };
  window.__nexusFlash = () => {
    c.animate([{transform:'scale(1)'},{transform:'scale(1.8)'},{transform:'scale(1)'}],{duration:300});
  };
})();
"""


def _ensure_browser(headless: bool = False):
    """Start installed Chrome through Selenium (once) and return the driver."""
    with _browser_lock:
        driver = _browser_state.get("driver")
        if driver is not None:
            try:
                _ = driver.current_url
                _inject_cursor(driver)
                return driver
            except Exception:
                _browser_state["driver"] = None

        webdriver, _By, _Keys, _ActionChains, _WebDriverWait, _EC = _import_selenium()
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument("--headless=new")
        options.add_argument("--start-maximized")
        options.add_argument("--disable-infobars")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)

        launch_errors = []
        try:
            driver = webdriver.Chrome(options=options)
        except Exception as chrome_error:
            launch_errors.append(f"installed Chrome via Selenium failed: {chrome_error}")
            try:
                edge_options = webdriver.EdgeOptions()
                if headless:
                    edge_options.add_argument("--headless=new")
                edge_options.add_argument("--start-maximized")
                driver = webdriver.Edge(options=edge_options)
            except Exception as edge_error:
                launch_errors.append(f"Edge fallback via Selenium failed: {edge_error}")
                raise HTTPException(
                    500,
                    "Could not launch Chrome with Selenium. Make sure normal Google Chrome is installed, then run:\n"
                    f'"{sys.executable}" -m pip install --upgrade selenium\n\n'
                    + "\n\n".join(launch_errors),
                )

        driver.get("about:blank")
        _inject_cursor(driver)
        _browser_state["driver"] = driver
        return driver


def _inject_cursor(driver):
    try:
        driver.execute_script(CURSOR_OVERLAY_JS)
    except Exception:
        pass


def _move_cursor(driver, x: float, y: float):
    try:
        _inject_cursor(driver)
        driver.execute_script("window.__nexusMove && window.__nexusMove(arguments[0], arguments[1])", float(x), float(y))
    except Exception:
        pass


def _flash_cursor(driver):
    try:
        _inject_cursor(driver)
        driver.execute_script("window.__nexusFlash && window.__nexusFlash()")
    except Exception:
        pass


def _xpath_literal(value: str) -> str:
    if '"' not in value:
        return f'"{value}"'
    if "'" not in value:
        return f"'{value}'"
    return "concat(" + ", '\"', ".join(f'"{part}"' for part in value.split('"')) + ")"


def _find_element(driver, selector: str | None = None, text: str | None = None, clickable: bool = False, nth: int = 0):
    _webdriver, By, _Keys, _ActionChains, WebDriverWait, EC = _import_selenium()
    wait = WebDriverWait(driver, 8)
    if selector:
        elements = wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, selector) or False)
    else:
        needle = _xpath_literal(text or "")
        # Broaden: any element (links, headings, divs that wrap result titles, etc.)
        xpath = (
            f"//*[(self::a or self::button or self::input or self::textarea or self::select "
            f"or self::h1 or self::h2 or self::h3 or self::span or self::div or @role='button' or @role='link') "
            f"and (contains(normalize-space(.), {needle}) or contains(@value, {needle}) "
            f"or contains(@placeholder, {needle}) or contains(@aria-label, {needle}) or contains(@title, {needle}))]"
        )
        elements = wait.until(lambda d: d.find_elements(By.XPATH, xpath) or False)

    # Filter to visible elements
    visible = []
    for el in elements:
        try:
            rect = el.rect
            if rect.get("width", 0) >= 2 and rect.get("height", 0) >= 2 and el.is_displayed():
                visible.append(el)
        except Exception:
            continue
    if not visible:
        visible = elements

    # When matching by text, prefer the most specific (smallest) matching element,
    # and when many siblings match, pick the nth distinct clickable ancestor link.
    if text and not selector:
        # Sort by depth (deepest first) so we prefer the inner result title over wrapping containers
        def depth(el):
            try:
                return driver.execute_script(
                    "let n=arguments[0],d=0;while(n.parentElement){d++;n=n.parentElement;}return d;", el
                )
            except Exception:
                return 0
        visible.sort(key=depth, reverse=True)
        # Walk up to nearest <a> or [role=link]/[role=button] for actual click target
        clickable_targets = []
        seen = set()
        for el in visible:
            try:
                target = driver.execute_script(
                    "let n=arguments[0];while(n && n!==document.body){if(n.tagName==='A'||n.tagName==='BUTTON'||n.getAttribute('role')==='button'||n.getAttribute('role')==='link')return n;n=n.parentElement;}return arguments[0];",
                    el,
                )
                key = driver.execute_script("const r=arguments[0].getBoundingClientRect();return r.top+'_'+r.left+'_'+r.width+'_'+r.height;", target)
                if key in seen:
                    continue
                seen.add(key)
                clickable_targets.append(target)
            except Exception:
                continue
        if clickable_targets:
            visible = clickable_targets

    idx = max(0, min(nth, len(visible) - 1))
    chosen = visible[idx]
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'center'});", chosen)
    except Exception:
        pass
    return chosen


def _element_center(driver, element):
    return driver.execute_script(
        "const r = arguments[0].getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2};",
        element,
    )


def _active_window_info():
    pyautogui = _import_pyautogui()
    info = {"title": None, "left": None, "top": None, "width": None, "height": None}
    try:
        win = pyautogui.getActiveWindow()
        if win:
            info.update({
                "title": getattr(win, "title", None),
                "left": getattr(win, "left", None),
                "top": getattr(win, "top", None),
                "width": getattr(win, "width", None),
                "height": getattr(win, "height", None),
            })
    except Exception:
        pass
    return info


def _mark_dpi_aware():
    """Screenshots capture physical pixels while clicks use logical points.
    Marking the process DPI-aware puts both on the same grid (125%/150% scaling)."""
    if platform.system() != "Windows":
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            import ctypes
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _invalidate_desktop_cache():
    """Called after any action that can change what is on screen."""
    _desktop_state["controls"] = []
    _desktop_state["ts"] = 0.0


def _desktop_cache_fresh() -> bool:
    if not _desktop_state.get("controls"):
        return False
    if time.monotonic() - (_desktop_state.get("ts") or 0.0) > _DESKTOP_CACHE_TTL:
        return False
    current = (_active_window_info().get("title") or "")
    return current == (_desktop_state.get("window_title") or "")


def _norm_name(s: str) -> str:
    """Aggressive normalization so 'TLauncher', 't launcher' and 'tlauncher.lnk' match."""
    import re
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _process_name(pid: int) -> str:
    try:
        import psutil  # type: ignore
        return psutil.Process(pid).name() or ""
    except Exception:
        return ""


def _list_top_windows():
    """Visible top-level windows as [{handle, title, process}]."""
    Desktop = _import_pywinauto()
    if Desktop is None:
        return []
    out = []
    try:
        desktop = Desktop(backend="uia")
        for w in desktop.windows():
            try:
                title = (w.window_text() or "").strip()
                if not title:
                    continue
                out.append({
                    "handle": w.handle,
                    "title": title,
                    "process": _process_name(w.process_id()),
                })
            except Exception:
                continue
    except Exception:
        pass
    return out


def _matching_windows(name: str):
    """Windows whose title or process name fuzzy-matches `name`, best first."""
    needle = _norm_name(name)
    if not needle:
        return []
    scored = []
    for w in _list_top_windows():
        title_n = _norm_name(w["title"])
        proc_n = _norm_name(w["process"])
        score = 0
        if needle and (needle in title_n or title_n in needle) and title_n:
            score = 100 - min(len(title_n), 60)
        elif needle and (needle in proc_n or proc_n in needle) and proc_n:
            score = 60 - min(len(proc_n), 40)
        if score > 0:
            scored.append((score, w))
    scored.sort(key=lambda s: -s[0])
    return [w for _, w in scored]


def _focus_window(handle: int) -> bool:
    """Bring a window (by handle) to the foreground. Returns True on success."""
    Desktop = _import_pywinauto()
    if Desktop is None:
        return False
    try:
        desktop = Desktop(backend="uia")
        win = desktop.window(handle=handle)
        try:
            if win.is_minimized():
                win.restore()
        except Exception:
            pass
        win.set_focus()
        time.sleep(0.25)
        return True
    except Exception:
        return False


def _read_desktop_controls(max_controls: int = 120, max_depth: int = 6, deadline_sec: float = 1.5):
    """Shallow, time-boxed UIA walk of the ACTIVE window. Deep app trees can
    take 10s+ with a full descendants() scan, so we bound both depth and time."""
    Desktop = _import_pywinauto()
    if Desktop is None:
        return [], "Windows UI Automation unavailable; using mouse/keyboard coordinates only."

    deadline = time.monotonic() + deadline_sec
    try:
        desktop = Desktop(backend="uia")
        active = desktop.get_active()
        controls = []
        stack = [(active, 0)]
        while stack and len(controls) < max_controls:
            if time.monotonic() >= deadline:
                break
            ctrl, depth = stack.pop()
            try:
                rect = ctrl.rectangle()
                name = (ctrl.window_text() or "").strip()
                control_type = getattr(ctrl.element_info, "control_type", "") or ""
                interesting = name or control_type in {"Edit", "Button", "ComboBox", "Hyperlink", "ListItem", "MenuItem", "TabItem"}
                if interesting and rect.width() >= 4 and rect.height() >= 4:
                    controls.append({
                        "index": len(controls),
                        "text": name[:160],
                        "type": control_type,
                        "class": getattr(ctrl.element_info, "class_name", None),
                        "x": int((rect.left + rect.right) / 2),
                        "y": int((rect.top + rect.bottom) / 2),
                        "bounds": [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)],
                    })
                if depth < max_depth:
                    for child in ctrl.children():
                        stack.append((child, depth + 1))
            except Exception:
                continue
        note = None
        if time.monotonic() >= deadline:
            note = "Control scan hit its time limit; results are partial."
        return controls, note
    except Exception as e:
        return [], f"Windows UI Automation read failed: {e}"


def _read_desktop_ocr(screenshot, max_items: int = 200):
    pytesseract = _import_pytesseract()
    if pytesseract is None:
        return [], "OCR unavailable. Install pytesseract: pip install pytesseract"

    binary = _locate_tesseract_binary()
    if not binary:
        return [], (
            "Tesseract OCR binary not found. Install it from "
            "https://github.com/UB-Mannheim/tesseract/wiki (Windows) or "
            "`brew install tesseract` / `apt install tesseract-ocr`, then restart the agent."
        )

    try:
        data = pytesseract.image_to_data(screenshot, output_type=pytesseract.Output.DICT)
        # Group words by (block, paragraph, line) so multi-word labels like
        # "Enter the Game" become one clickable item instead of three fragments.
        lines: dict[tuple, dict] = {}
        n = len(data.get("text", []))
        for i in range(n):
            text = (data["text"][i] or "").strip()
            if not text:
                continue
            try:
                conf = float(data.get("conf", [0])[i])
            except Exception:
                conf = 0.0
            # Keep low-confidence words too — game launchers often score poorly
            if conf < 25:
                continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            x, y = int(data["left"][i]), int(data["top"][i])
            w, h = int(data["width"][i]), int(data["height"][i])
            entry = lines.setdefault(key, {"words": [], "x1": x, "y1": y, "x2": x + w, "y2": y + h, "conf_sum": 0.0, "conf_n": 0})
            entry["words"].append(text)
            entry["x1"] = min(entry["x1"], x)
            entry["y1"] = min(entry["y1"], y)
            entry["x2"] = max(entry["x2"], x + w)
            entry["y2"] = max(entry["y2"], y + h)
            entry["conf_sum"] += conf
            entry["conf_n"] += 1

        items = []
        for entry in lines.values():
            phrase = " ".join(entry["words"]).strip()
            if not phrase:
                continue
            x1, y1, x2, y2 = entry["x1"], entry["y1"], entry["x2"], entry["y2"]
            avg_conf = entry["conf_sum"] / max(1, entry["conf_n"])
            items.append({
                "index": len(items),
                "text": phrase[:160],
                "confidence": round(avg_conf, 1),
                "x": (x1 + x2) // 2,
                "y": (y1 + y2) // 2,
                "bounds": [x1, y1, x2, y2],
            })

        # Highest confidence first so the AI sees the strongest matches first
        items.sort(key=lambda it: -it["confidence"])
        items = items[:max_items]
        # Reindex after sort/truncate
        for i, it in enumerate(items):
            it["index"] = i
        return items, None
    except Exception as e:
        return [], f"OCR failed: {e}. Make sure the Tesseract OCR desktop app is installed and restart the agent."


def _score_target(needle_tokens: list[str], candidate_text: str) -> float:
    """Higher = better. 0 = no match. Substring beats token overlap beats nothing."""
    cand = (candidate_text or "").lower()
    if not cand or not needle_tokens:
        return 0.0
    full = " ".join(needle_tokens)
    if full in cand:
        # Reward shorter candidates (more specific) when full phrase matches
        return 1000.0 - min(len(cand), 500)
    matched = sum(1 for tok in needle_tokens if tok in cand)
    if matched == 0:
        return 0.0
    # Require at least half the tokens to consider it a fuzzy match
    if matched * 2 < len(needle_tokens):
        return 0.0
    return 100.0 * matched / len(needle_tokens) - min(len(cand), 200) * 0.01


def _match_desktop_target(text: str, nth: int = 0):
    needle = (text or "").lower().strip()
    if not needle:
        raise HTTPException(400, "desktop_click requires either coordinates or text")
    tokens = [t for t in needle.split() if t]

    def best_matches(candidates):
        scored = [(c, _score_target(tokens, c.get("text", ""))) for c in candidates]
        scored = [s for s in scored if s[1] > 0]
        scored.sort(key=lambda s: -s[1])
        return [c for c, _ in scored]

    # Only trust the cache while it is fresh and the active window is unchanged;
    # otherwise do ONE quick targeted re-scan (fast controls, no full OCR pass).
    if not _desktop_cache_fresh():
        controls, _ = _read_desktop_controls()
        _desktop_state["controls"] = controls
        _desktop_state["window_title"] = _active_window_info().get("title") or ""
        _desktop_state["ts"] = time.monotonic()

    matches = best_matches(_desktop_state.get("controls") or [])
    if not matches:
        controls, _ = _read_desktop_controls()
        _desktop_state["controls"] = controls
        _desktop_state["window_title"] = _active_window_info().get("title") or ""
        _desktop_state["ts"] = time.monotonic()
        matches = best_matches(_desktop_state["controls"])

    if not matches:
        # Tell the AI what IS visible so it can pick coordinates instead of giving up
        visible = [c.get("text") for c in (_desktop_state.get("controls") or [])][:30]
        raise HTTPException(
            404,
            f"No visible desktop control found matching: {text}. "
            f"Currently detected (top 30): {visible}. "
            "Try desktop_read again, then click by exact text or x/y coordinates."
        )
    return matches[max(0, min(nth, len(matches) - 1))]

app = FastAPI(title="NEXUS Local Agent")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ufo_desktop import ufo_router, ufo_tool_router, UFO_ENDPOINTS  # noqa: E402
app.include_router(ufo_router)
app.include_router(ufo_tool_router)

# CORS — allow the web UI to call us from any origin (you control the browser).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Chrome's Private Network Access requires these headers so an HTTPS page
# (the NEXUS web UI) is allowed to call http://127.0.0.1 / localhost.
# Optional shared-secret auth. Set NEXUS_AGENT_TOKEN before starting the agent
# and paste the same value into NEXUS Settings -> Computer. When it is unset the
# agent stays open (localhost only), which is the old behaviour.
AGENT_TOKEN = (os.environ.get("NEXUS_AGENT_TOKEN") or "").strip()
PUBLIC_PATHS = {"/health", "/docs", "/openapi.json"}


def _token_ok(request: Request) -> bool:
    """Accept the shared secret from any of the headers our clients send.

    - X-Nexus-Token       : NEXUS web UI and NEXUS Android Agent
    - Authorization: Bearer : NEXUS Android Agent fallback
    """
    candidates = [
        request.headers.get("x-nexus-token", ""),
        (request.headers.get("authorization", "") or "").removeprefix("Bearer ").strip(),
    ]
    return AGENT_TOKEN in [c for c in candidates if c]


@app.middleware("http")
async def auth_and_private_network_access(request: Request, call_next):
    if request.method == "OPTIONS":
        resp = Response(status_code=204)
    elif (
        AGENT_TOKEN
        and request.url.path not in PUBLIC_PATHS
        and not _token_ok(request)
    ):
        resp = Response(
            status_code=401,
            content='{"detail":"Missing or invalid X-Nexus-Token header."}',
            media_type="application/json",
        )
    else:
        resp = await call_next(request)
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "*"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"


class RunCmd(BaseModel):
    command: str
    cwd: str | None = None
    # Builds, installs and test suites routinely need far more than 120s.
    timeout_sec: int | None = None


class PathArg(BaseModel):
    path: str
    # Optional windowed reads for large source files.
    start_line: int | None = None
    end_line: int | None = None
    line_numbers: bool = False



class UrlArg(BaseModel):
    url: str


class SearchArg(BaseModel):
    root: str
    query: str


class WriteArg(BaseModel):
    path: str
    content: str


@app.get("/health")
def health():
    return {
        "ok": True,
        "os": platform.system(),
        "release": platform.release(),
        "agent_version": AGENT_VERSION,
        "android": ANDROID_TOOLS,
        "ufo": UFO_ENDPOINTS,
        "tools": sorted(
            r.path[len("/tool/"):]
            for r in app.routes
            if getattr(r, "path", "").startswith("/tool/")
        ),
    }



@app.post("/tool/run_command")
def run_command(arg: RunCmd):
    timeout = max(1, min(900, arg.timeout_sec or 120))
    try:
        # shell=True so users can pipe / chain like a real terminal
        result = subprocess.run(
            arg.command,
            shell=True,
            cwd=arg.cwd or None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = (result.stdout or "") + (("\n[stderr]\n" + result.stderr) if result.stderr else "")
        return {
            "exit_code": result.returncode,
            "output": out[-8000:] or "(no output)",
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(
            408,
            f"Command timed out after {timeout}s. Re-run with a larger timeout_sec, "
            "or start it with run_command_bg and poll command_status.",
        )
    except Exception as e:
        raise HTTPException(500, str(e))



@app.post("/tool/open_path")
def open_path(arg: PathArg):
    p = Path(arg.path).expanduser()
    try:
        if IS_WIN:
            os.startfile(str(p))  # type: ignore[attr-defined]
        elif IS_MAC:
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
        return {"ok": True, "opened": str(p)}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/tool/open_url")
def open_url(arg: UrlArg):
    webbrowser.open(arg.url)
    return {"ok": True, "opened": arg.url}


@app.post("/tool/list_dir")
def list_dir(arg: PathArg):
    p = Path(arg.path).expanduser()
    if not p.exists():
        raise HTTPException(404, f"Not found: {p}")
    items = []
    for child in sorted(p.iterdir()):
        items.append({
            "name": child.name,
            "type": "dir" if child.is_dir() else "file",
            "size": child.stat().st_size if child.is_file() else None,
        })
    return {"path": str(p), "items": items}


@app.post("/tool/search_files")
def search_files(arg: SearchArg):
    root = Path(arg.root).expanduser()
    if not root.exists():
        raise HTTPException(404, f"Not found: {root}")
    q = arg.query.lower()
    matches = []
    for p in root.rglob("*"):
        try:
            if q in p.name.lower():
                matches.append(str(p))
                if len(matches) >= 100:
                    break
        except Exception:
            continue
    return {"root": str(root), "query": arg.query, "matches": matches}


@app.post("/tool/read_file")
def read_file(arg: PathArg):
    p = Path(arg.path).expanduser()
    if not p.exists():
        raise HTTPException(404, f"Not found: {p}")
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        total = len(lines)
        start = max(1, arg.start_line or 1)
        end = min(total, arg.end_line or total)
        if end < start:
            end = start
        window = lines[start - 1 : end]
        if arg.line_numbers:
            body = "\n".join(f"{start + i}: {line}" for i, line in enumerate(window))
        else:
            body = "\n".join(window)
        truncated = len(body) > 60000
        return {
            "path": str(p),
            "total_lines": total,
            "start_line": start,
            "end_line": end,
            "truncated": truncated,
            "content": body[:60000],
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/tool/write_file")
def write_file(arg: WriteArg):
    p = Path(arg.path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    backup = _backup_file(p)
    p.write_text(arg.content, encoding="utf-8")
    return {"ok": True, "path": str(p), "bytes": len(arg.content), "backup": backup}


# ===================== CODING TOOLKIT =====================
# Surgical patch editing, code search, project trees, background commands,
# git plumbing and undo. Everything is plain stdlib so no extra installs.

SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
    ".next", ".turbo", ".cache", "target", "bin", "obj", ".idea", ".nexus",
}
TEXT_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
    ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift",
    ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".md", ".txt", ".html",
    ".css", ".scss", ".sql", ".sh", ".bat", ".ps1", ".ino", ".env", ".gitignore",
}

_bg_lock = threading.Lock()
_bg_procs: dict[str, dict] = {}


def _backup_dir() -> Path:
    d = Path.home() / ".nexus" / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _backup_file(p: Path) -> str | None:
    """Timestamped copy of a file before NEXUS changes it, so edits are undoable."""
    try:
        if not p.exists() or not p.is_file():
            return None
        stamp = time.strftime("%Y%m%d-%H%M%S")
        safe = str(p).replace(":", "_").replace(os.sep, "__").lstrip("_")
        dest = _backup_dir() / f"{stamp}__{safe}"
        shutil.copy2(p, dest)
        return str(dest)
    except Exception:
        return None


def _unified_diff(before: str, after: str, path: str) -> str:
    import difflib

    diff = difflib.unified_diff(
        before.splitlines(), after.splitlines(),
        fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=3,
    )
    return "\n".join(list(diff)[:600])


class PatchEdit(BaseModel):
    find: str
    replace: str
    # Guard against ambiguous matches; set >1 only when you mean it.
    expected_count: int = 1


class PatchArg(BaseModel):
    path: str
    edits: list[PatchEdit]
    create_if_missing: bool = False


@app.post("/tool/apply_patch")
def apply_patch(arg: PatchArg):
    """Exact search/replace edits with match verification, backup and a diff."""
    p = Path(arg.path).expanduser()
    if not p.exists():
        if not arg.create_if_missing:
            raise HTTPException(404, f"Not found: {p}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("", encoding="utf-8")

    original = p.read_text(encoding="utf-8", errors="replace")
    updated = original
    applied = []
    for i, edit in enumerate(arg.edits):
        if not edit.find:
            raise HTTPException(400, f"Edit {i}: 'find' must not be empty.")
        found = updated.count(edit.find)
        if found != edit.expected_count:
            raise HTTPException(
                409,
                f"Edit {i}: expected {edit.expected_count} match(es) of the 'find' text "
                f"but found {found}. Nothing was written. Re-read the file and include "
                "more surrounding context so the match is unique.",
            )
        updated = updated.replace(edit.find, edit.replace, edit.expected_count)
        applied.append({"index": i, "matches": found})

    if updated == original:
        return {"ok": True, "path": str(p), "changed": False, "note": "No content change."}

    backup = _backup_file(p)
    tmp = p.with_suffix(p.suffix + ".nexus-tmp")
    tmp.write_text(updated, encoding="utf-8")
    tmp.replace(p)
    return {
        "ok": True,
        "path": str(p),
        "changed": True,
        "edits": applied,
        "backup": backup,
        "diff": _unified_diff(original, updated, p.name),
    }


class RestoreArg(BaseModel):
    backup: str


@app.post("/tool/restore_backup")
def restore_backup(arg: RestoreArg):
    src = Path(arg.backup).expanduser()
    if not src.exists():
        raise HTTPException(404, f"Backup not found: {src}")
    name = src.name.split("__", 1)[1] if "__" in src.name else None
    if not name:
        raise HTTPException(400, "Unrecognised backup name.")
    target = Path(name.replace("__", os.sep))
    if IS_WIN and len(str(target)) > 1 and str(target)[1] == "_":
        target = Path(str(target)[0] + ":" + str(target)[2:])
    shutil.copy2(src, target)
    return {"ok": True, "restored": str(target), "from": str(src)}


@app.post("/tool/list_backups")
def list_backups():
    items = sorted(_backup_dir().glob("*"), key=lambda f: f.stat().st_mtime, reverse=True)[:50]
    return {"backups": [{"backup": str(f), "when": time.ctime(f.stat().st_mtime)} for f in items]}


class GrepArg(BaseModel):
    root: str
    pattern: str
    glob: str | None = None
    regex: bool = True
    ignore_case: bool = True
    max_results: int = 200


@app.post("/tool/grep")
def grep(arg: GrepArg):
    """Search file CONTENTS across a project (search_files only matches names)."""
    import fnmatch
    import re

    root = Path(arg.root).expanduser()
    if not root.exists():
        raise HTTPException(404, f"Not found: {root}")
    flags = re.IGNORECASE if arg.ignore_case else 0
    try:
        rx = re.compile(arg.pattern if arg.regex else re.escape(arg.pattern), flags)
    except re.error as e:
        raise HTTPException(400, f"Bad regex: {e}")

    hits = []
    scanned = 0
    for p in root.rglob("*"):
        if len(hits) >= max(1, min(1000, arg.max_results)):
            break
        try:
            if p.is_dir():
                continue
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            if arg.glob and not fnmatch.fnmatch(p.name, arg.glob):
                continue
            if p.suffix and p.suffix.lower() not in TEXT_EXT:
                continue
            if p.stat().st_size > 2_000_000:
                continue
            scanned += 1
            for n, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if rx.search(line):
                    hits.append({"file": str(p), "line": n, "text": line.strip()[:300]})
                    if len(hits) >= arg.max_results:
                        break
        except Exception:
            continue
    return {"root": str(root), "pattern": arg.pattern, "files_scanned": scanned, "hits": hits}


class TreeArg(BaseModel):
    root: str
    depth: int = 3
    max_entries: int = 400


@app.post("/tool/project_tree")
def project_tree(arg: TreeArg):
    root = Path(arg.root).expanduser()
    if not root.exists():
        raise HTTPException(404, f"Not found: {root}")
    lines: list[str] = []

    def walk(d: Path, prefix: str, depth: int):
        if depth > max(1, arg.depth) or len(lines) >= arg.max_entries:
            return
        try:
            children = sorted(d.iterdir(), key=lambda c: (c.is_file(), c.name.lower()))
        except Exception:
            return
        for c in children:
            if len(lines) >= arg.max_entries:
                return
            if c.name in SKIP_DIRS:
                continue
            lines.append(f"{prefix}{c.name}{'/' if c.is_dir() else ''}")
            if c.is_dir():
                walk(c, prefix + "  ", depth + 1)

    walk(root, "", 1)
    return {"root": str(root), "truncated": len(lines) >= arg.max_entries, "tree": "\n".join(lines)}


@app.post("/tool/run_command_bg")
def run_command_bg(arg: RunCmd):
    """Start a long-running process (dev server, watcher) and return a job id."""
    job_id = f"job-{int(time.time() * 1000)}"
    try:
        proc = subprocess.Popen(
            arg.command,
            shell=True,
            cwd=arg.cwd or None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except Exception as e:
        raise HTTPException(500, str(e))

    buf: list[str] = []

    def pump():
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                buf.append(line.rstrip())
                if len(buf) > 800:
                    del buf[:400]
        except Exception:
            pass

    threading.Thread(target=pump, daemon=True).start()
    with _bg_lock:
        _bg_procs[job_id] = {"proc": proc, "buf": buf, "command": arg.command}
    return {"ok": True, "job_id": job_id, "command": arg.command}


class JobArg(BaseModel):
    job_id: str
    stop: bool = False


@app.post("/tool/command_status")
def command_status(arg: JobArg):
    with _bg_lock:
        job = _bg_procs.get(arg.job_id)
    if not job:
        raise HTTPException(404, f"Unknown job: {arg.job_id}")
    proc: subprocess.Popen = job["proc"]
    if arg.stop and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    return {
        "job_id": arg.job_id,
        "command": job["command"],
        "running": proc.poll() is None,
        "exit_code": proc.poll(),
        "output": "\n".join(job["buf"][-200:]) or "(no output yet)",
    }


class GitArg(BaseModel):
    repo: str
    message: str | None = None
    branch: str | None = None
    remote: str = "origin"
    paths: list[str] | None = None
    create: bool = False


def _git(repo: str, *args: str, timeout: int = 120):
    root = Path(repo).expanduser()
    if not root.exists():
        raise HTTPException(404, f"Not found: {root}")
    try:
        r = subprocess.run(
            ["git", *args], cwd=str(root), capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError:
        raise HTTPException(500, "git is not installed or not on PATH.")
    except subprocess.TimeoutExpired:
        raise HTTPException(408, "git command timed out.")
    out = (r.stdout or "") + (("\n[stderr]\n" + r.stderr) if r.stderr else "")
    return {"exit_code": r.returncode, "output": out[-8000:] or "(no output)"}


@app.post("/tool/git_status")
def git_status(arg: GitArg):
    return _git(arg.repo, "status", "--short", "--branch")


@app.post("/tool/git_diff")
def git_diff(arg: GitArg):
    args = ["diff", "--stat" if not arg.paths else "--", *(arg.paths or [])]
    if not arg.paths:
        return _git(arg.repo, "diff")
    return _git(arg.repo, *args)


@app.post("/tool/git_branch")
def git_branch(arg: GitArg):
    if not arg.branch:
        return _git(arg.repo, "branch", "--show-current")
    if arg.create:
        return _git(arg.repo, "checkout", "-b", arg.branch)
    return _git(arg.repo, "checkout", arg.branch)


@app.post("/tool/git_commit")
def git_commit(arg: GitArg):
    if not arg.message:
        raise HTTPException(400, "A commit message is required.")
    add = _git(arg.repo, "add", *(arg.paths or ["-A"]))
    if add["exit_code"] != 0:
        return add
    return _git(arg.repo, "commit", "-m", arg.message)


@app.post("/tool/git_push")
def git_push(arg: GitArg):
    args = ["push", arg.remote]
    if arg.branch:
        args += ["-u", arg.branch]
    return _git(arg.repo, *args, timeout=300)



@app.post("/tool/system_info")
def system_info():
    info = {
        "os": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "cwd": os.getcwd(),
        "user": os.environ.get("USER") or os.environ.get("USERNAME"),
    }
    # Optional: psutil for richer info
    try:
        import psutil  # type: ignore
        info["cpu_percent"] = psutil.cpu_percent(interval=0.1)
        info["cpu_count"] = psutil.cpu_count()
        mem = psutil.virtual_memory()
        info["ram_total_gb"] = round(mem.total / 1e9, 2)
        info["ram_used_pct"] = mem.percent
        disk = psutil.disk_usage("/")
        info["disk_total_gb"] = round(disk.total / 1e9, 2)
        info["disk_used_pct"] = disk.percent
    except ImportError:
        info["note"] = "Install `psutil` for CPU/RAM/disk metrics."
    return info


class DesktopRead(BaseModel):
    ocr: bool = False  # OCR is slow; opt-in only, and limited to the active window


class DesktopClick(BaseModel):
    x: int | None = None
    y: int | None = None
    text: str | None = None
    nth: int = 0
    button: str = "left"
    clicks: int = 1
    double: bool = False  # desktop icons / Explorer files need a double-click
    window: str | None = None  # bring this window to the front first


class DesktopType(BaseModel):
    text: str
    submit: bool = False
    window: str | None = None


class DesktopHotkey(BaseModel):
    keys: list[str]
    window: str | None = None


class DesktopKey(BaseModel):
    key: str
    window: str | None = None


class DesktopScroll(BaseModel):
    amount: int = -5
    window: str | None = None


class LaunchApp(BaseModel):
    name: str
    search_dirs: list[str] | None = None


def _failsafe_message(e: Exception) -> str | None:
    if e.__class__.__name__ == "FailSafeException":
        return ("Mouse hit the screen-corner safety switch and the action was cancelled. "
                "Retry with coordinates away from the corners.")
    return None


def _focus_if_requested(window: str | None):
    """Bring a named window to the front before an input action. Refuses to act
    when the match is missing or ambiguous (wrong-instance protection)."""
    if not window:
        return
    matches = _matching_windows(window)
    if not matches:
        raise HTTPException(404, f"No window found matching '{window}'. Action refused.")
    best = _norm_name(matches[0]["title"])
    tied = [m for m in matches if _norm_name(m["title"]) == best]
    if len(tied) > 1:
        raise HTTPException(
            409,
            "Several windows match "
            f"'{window}': {[m['title'] for m in tied]}. "
            "Pass a more specific window title.",
        )
    if not _focus_window(matches[0]["handle"]):
        raise HTTPException(500, f"Could not bring '{matches[0]['title']}' to the front. Action refused.")


# ===================== DESKTOP COWORK =====================
def _encode_screenshot(screenshot, max_width: int = 1280, quality: int = 70) -> str | None:
    """Downscale + JPEG-encode the screenshot as base64 so the AI can SEE it."""
    try:
        import io, base64
        img = screenshot
        w, h = img.size
        if w > max_width:
            new_h = int(h * (max_width / w))
            try:
                from PIL import Image  # type: ignore
                img = img.resize((max_width, new_h), Image.LANCZOS)
            except Exception:
                img = img.resize((max_width, new_h))
        buf = io.BytesIO()
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


@app.post("/tool/desktop_read")
def desktop_read(arg: DesktopRead | None = None):
    pyautogui = _import_pyautogui()
    want_ocr = bool(arg and arg.ocr)
    try:
        size = pyautogui.size()
        pos = pyautogui.position()
        screenshot = pyautogui.screenshot()
        active = _active_window_info()
        controls, controls_note = _read_desktop_controls()
        ocr, ocr_note = [], None
        if want_ocr:
            # OCR only the active window, not the whole screen.
            crop = screenshot
            try:
                if active.get("width") and active.get("height"):
                    left = max(0, int(active["left"]))
                    top = max(0, int(active["top"]))
                    right = min(size.width, left + int(active["width"]))
                    bottom = min(size.height, top + int(active["height"]))
                    if right > left and bottom > top:
                        crop = screenshot.crop((left, top, right, bottom))
            except Exception:
                crop = screenshot
            ocr, ocr_note = _read_desktop_ocr(crop)
            # Offset cropped OCR coords back to full-screen coordinates.
            if crop is not screenshot and active.get("left") is not None:
                for it in ocr:
                    it["x"] += max(0, int(active["left"]))
                    it["y"] += max(0, int(active["top"]))
                    it["bounds"][0] += max(0, int(active["left"]))
                    it["bounds"][2] += max(0, int(active["left"]))
                    it["bounds"][1] += max(0, int(active["top"]))
                    it["bounds"][3] += max(0, int(active["top"]))
        else:
            ocr_note = "OCR skipped (pass ocr=true to enable; it is slow)."
        _desktop_state["controls"] = controls + ocr
        _desktop_state["window_title"] = active.get("title") or ""
        _desktop_state["ts"] = time.monotonic()
        screenshot_b64 = _encode_screenshot(screenshot)
        return {
            "ok": True,
            "screen": {"width": size.width, "height": size.height},
            "mouse": {"x": pos.x, "y": pos.y},
            "active_window": active,
            "controls": controls,
            "ocr": ocr,
            "notes": [n for n in [controls_note, ocr_note] if n],
            "screenshot_b64": screenshot_b64,
            "screenshot_mime": "image/jpeg",
        }
    except Exception as e:
        raise HTTPException(500, f"Desktop read failed: {e}")


@app.post("/tool/desktop_screenshot")
def desktop_screenshot():
    """Just the screenshot — for when the AI wants a fresh view without re-running OCR."""
    pyautogui = _import_pyautogui()
    try:
        size = pyautogui.size()
        screenshot = pyautogui.screenshot()
        return {
            "ok": True,
            "screen": {"width": size.width, "height": size.height},
            "screenshot_b64": _encode_screenshot(screenshot),
            "screenshot_mime": "image/jpeg",
        }
    except Exception as e:
        raise HTTPException(500, f"Screenshot failed: {e}")


@app.post("/tool/desktop_click")
def desktop_click(arg: DesktopClick):
    pyautogui = _import_pyautogui()
    try:
        _focus_if_requested(arg.window)
        if arg.text:
            target = _match_desktop_target(arg.text, arg.nth)
            x, y = int(target["x"]), int(target["y"])
        elif arg.x is not None and arg.y is not None:
            x, y = int(arg.x), int(arg.y)
        else:
            raise HTTPException(400, "desktop_click requires either x/y coordinates or text")
        clicks = 2 if arg.double else max(1, int(arg.clicks))
        pyautogui.moveTo(x, y, duration=0.15)
        pyautogui.click(x=x, y=y, clicks=clicks, button=arg.button)
        _invalidate_desktop_cache()
        return {"ok": True, "clicked": {"x": x, "y": y, "text": arg.text, "nth": arg.nth, "clicks": clicks}}
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"Desktop click failed: {e}")


@app.post("/tool/desktop_type")
def desktop_type(arg: DesktopType):
    pyautogui = _import_pyautogui()
    try:
        _focus_if_requested(arg.window)
        pyperclip = _import_pyperclip()
        if pyperclip:
            pyperclip.copy(arg.text)
            pyautogui.hotkey("command" if IS_MAC else "ctrl", "v")
        else:
            pyautogui.write(arg.text, interval=0.01)
        if arg.submit:
            pyautogui.press("enter")
        _invalidate_desktop_cache()
        return {"ok": True, "typed": arg.text, "submit": arg.submit}
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"Desktop type failed: {e}")


@app.post("/tool/desktop_hotkey")
def desktop_hotkey(arg: DesktopHotkey):
    pyautogui = _import_pyautogui()
    try:
        _focus_if_requested(arg.window)
        keys = [k.lower().replace("control", "ctrl").replace("cmd", "command") for k in arg.keys]
        pyautogui.hotkey(*keys)
        _invalidate_desktop_cache()
        return {"ok": True, "keys": keys}
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"Desktop hotkey failed: {e}")


@app.post("/tool/desktop_press")
def desktop_press(arg: DesktopKey):
    pyautogui = _import_pyautogui()
    try:
        _focus_if_requested(arg.window)
        pyautogui.press(arg.key.lower())
        _invalidate_desktop_cache()
        return {"ok": True, "pressed": arg.key}
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"Desktop key press failed: {e}")


@app.post("/tool/desktop_scroll")
def desktop_scroll(arg: DesktopScroll):
    pyautogui = _import_pyautogui()
    try:
        _focus_if_requested(arg.window)
        pyautogui.scroll(int(arg.amount))
        _invalidate_desktop_cache()
        return {"ok": True, "amount": arg.amount}
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"Desktop scroll failed: {e}")


# ===================== APP LAUNCHING & DESKTOP =====================
_LAUNCH_EXTS = {".lnk", ".exe", ".url", ".appref-ms"}
_launch_cache: dict[str, str] = {}  # normalized name -> file path that worked


def _default_search_dirs() -> list[Path]:
    """User's Desktop and its 'Others' subfolder, resolved dynamically from the
    Windows user profile (OneDrive-aware). Nothing user-specific is hardcoded."""
    home = Path(os.environ.get("USERPROFILE") or str(Path.home()))
    onedrive_desktop = home / "OneDrive" / "Desktop"
    desktop = onedrive_desktop if onedrive_desktop.exists() else home / "Desktop"
    return [desktop, desktop / "Others"]


def _find_app_file(name: str, dirs: list[Path]) -> tuple[Path | None, list[str]]:
    """Best-matching launchable file in the given folders. Returns (path, ties)."""
    needle = _norm_name(name)
    if not needle:
        return None, []
    best: tuple[int, Path] | None = None
    ties: list[str] = []
    for d in dirs:
        try:
            if not d.is_dir():
                continue
            for f in d.iterdir():
                if f.suffix.lower() not in _LAUNCH_EXTS:
                    continue
                cand = _norm_name(f.stem)
                if not cand:
                    continue
                score = 0
                if cand == needle:
                    score = 100
                elif needle in cand:
                    score = 80 - min(len(cand) - len(needle), 40)
                elif cand in needle:
                    score = 60 - min(len(needle) - len(cand), 40)
                if score <= 0:
                    continue
                if best is None or score > best[0]:
                    best = (score, f)
                    ties = [f.name]
                elif best is not None and score == best[0]:
                    ties.append(f.name)
        except Exception:
            continue
    return (best[1] if best else None), ties


def _wait_and_focus(name: str, timeout_sec: float = 8.0) -> dict | None:
    """Wait for a matching window and bring it to the front."""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        matches = _matching_windows(name)
        if matches and _focus_window(matches[0]["handle"]):
            return matches[0]
        time.sleep(0.5)
    return None


_SEARCH_HOST_PROCS = {"searchhost.exe", "searchapp.exe", "searchui.exe", "startmenuexperiencehost.exe"}


def _search_result_text() -> str:
    """Read the text of the Windows Search flyout. Modern search is a XAML app
    (SearchHost.exe) that is often NOT reported as the active window and whose
    items answer only the UIA Name property — window_text() comes back empty."""
    Desktop = _import_pywinauto()
    if Desktop is None:
        return ""
    texts: list[str] = []
    try:
        desktop = Desktop(backend="uia")
        for w in desktop.windows():
            try:
                proc = _process_name(w.process_id()).lower()
                title = (w.window_text() or "").strip().lower()
                if proc not in _SEARCH_HOST_PROCS and title not in ("search", "start"):
                    continue
                for ctrl in w.descendants()[:150]:
                    try:
                        t = (getattr(ctrl.element_info, "name", "") or "").strip()
                        if not t:
                            t = " ".join(x for x in ctrl.texts() if x).strip()
                        if t:
                            texts.append(t)
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception:
        return ""
    return " ".join(texts)


def _windows_search_launch(name: str) -> dict:
    """Last resort: Windows search. Never blind: if the results can be read and
    they do NOT mention the app, nothing is launched. If they cannot be read,
    Enter is pressed and the caller must confirm a matching window appeared."""
    pyautogui = _import_pyautogui()
    pyautogui.press("win")
    time.sleep(0.8)
    pyautogui.write(name, interval=0.03)
    time.sleep(1.5)  # let results populate

    result_text = _search_result_text()
    needle = _norm_name(name)
    haystack = _norm_name(result_text)
    if not needle:
        pyautogui.press("esc")
        return {"ok": False, "tier": "windows_search", "error": "Empty app name."}
    if haystack and needle not in haystack:
        pyautogui.press("esc")  # close search without launching anything
        return {
            "ok": False,
            "tier": "windows_search",
            "error": f"Windows search results did not match '{name}' (saw: {result_text[:120]!r}). Not launching anything.",
        }
    pyautogui.press("enter")
    return {"ok": True, "tier": "windows_search", "verified_result": bool(haystack)}


@app.post("/tool/launch_app")
def launch_app(arg: LaunchApp):
    """Open an app reliably: already-running -> Desktop -> Desktop\\Others ->
    validated Windows search. Success means a matching window in the foreground."""
    name = arg.name.strip()
    if not name:
        raise HTTPException(400, "launch_app requires a name")
    try:
        # Tier 0: already running — focusing it counts as success.
        running = _matching_windows(name)
        if running and _focus_window(running[0]["handle"]):
            _invalidate_desktop_cache()
            return {"ok": True, "tier": "already_running", "window": running[0]["title"]}

        dirs = [Path(os.path.expandvars(d)) for d in arg.search_dirs] if arg.search_dirs else _default_search_dirs()

        # Session cache: a path that launched this name before wins instantly.
        cached = _launch_cache.get(_norm_name(name))
        if cached and Path(cached).exists():
            os.startfile(cached)  # type: ignore[attr-defined]
            win = _wait_and_focus(name)
            _invalidate_desktop_cache()
            return {"ok": True, "tier": "cache", "launched": cached, "window": win["title"] if win else None}

        # Tiers 1-2: Desktop, then Desktop\Others.
        found, ties = _find_app_file(name, dirs)
        if found is not None:
            if len(ties) > 1:
                return {"ok": False, "error": f"Several shortcuts match '{name}': {ties}. Be more specific."}
            os.startfile(str(found))  # type: ignore[attr-defined]
            _launch_cache[_norm_name(name)] = str(found)
            win = _wait_and_focus(name)
            _invalidate_desktop_cache()
            return {
                "ok": True,
                "tier": "shortcut",
                "launched": str(found),
                "window": win["title"] if win else None,
                "note": None if win else "Launched, but no matching window appeared within 8s.",
            }

        # Tier 3: validated Windows search.
        result = _windows_search_launch(name)
        if not result.get("ok"):
            return {"ok": False, "error": result["error"], "searched": [str(d) for d in dirs]}
        win = _wait_and_focus(name)
        _invalidate_desktop_cache()
        if win is None and not result.get("verified_result", True):
            # Results were unreadable AND nothing matching opened: honest failure.
            return {
                "ok": False,
                "tier": "windows_search",
                "error": f"Pressed Enter in Windows search for '{name}', but no matching window appeared within 8s.",
                "searched": [str(d) for d in dirs],
            }
        return {
            "ok": True,
            "tier": "windows_search",
            "window": win["title"] if win else None,
            "note": None if win else "Launched via Windows search, but no matching window appeared within 8s.",
        }
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"launch_app failed: {e}")


def _desktop_visible() -> bool:
    """True when no app window is in front (active window is the shell desktop)."""
    title = (_active_window_info().get("title") or "").strip()
    return title in ("", "Program Manager")


@app.post("/tool/show_desktop")
def show_desktop():
    """Idempotent: Win+D is a toggle, so it is only pressed when an app window
    is actually in front. Calling it twice never re-opens the windows."""
    pyautogui = _import_pyautogui()
    try:
        if _desktop_visible():
            return {"ok": True, "already": True, "desktop_visible": True}
        pyautogui.hotkey("win", "d")
        time.sleep(0.6)
        visible = _desktop_visible()
        _invalidate_desktop_cache()
        return {"ok": True, "already": False, "desktop_visible": visible}
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"show_desktop failed: {e}")


# ===================== WINDOW / MEDIA / FOLDER CONTROL =====================
class WindowTarget(BaseModel):
    name: str

class CloseApp(BaseModel):
    name: str
    force: bool = False  # kill the process if it will not close politely

class WindowAction(BaseModel):
    name: str | None = None  # None = the active window
    action: str  # maximize | minimize | restore | snap_left | snap_right | focus

class SetVolume(BaseModel):
    level: int | None = None  # 0-100
    mute: bool | None = None  # True = mute toggle on, False = unmute

class MediaControl(BaseModel):
    action: str  # play_pause | next | previous | stop | mute

class OpenFolder(BaseModel):
    target: str  # alias (downloads, documents, desktop, others, pictures, music, videos, home) or a path


def _resolve_one_window(name: str) -> dict:
    """Exactly one window for `name`; 404 when none, 409 when ambiguous."""
    matches = _matching_windows(name)
    if not matches:
        raise HTTPException(404, f"No open window matches '{name}'.")
    exact = [w for w in matches if _norm_name(w["title"]) == _norm_name(name)]
    if len(exact) == 1:
        return exact[0]
    if len(matches) > 1 and len({w["process"] for w in matches}) > 1:
        raise HTTPException(409, {"error": f"Several windows match '{name}'. Be more specific.",
                                  "candidates": [{"title": w["title"], "process": w["process"]} for w in matches[:8]]})
    return matches[0]


@app.post("/tool/list_windows")
def list_windows():
    """Every visible app window (title + process), so you know what is open."""
    wins = _list_top_windows()
    active = None
    try:
        active = _active_window_info().get("title")
    except Exception:
        pass
    return {"ok": True, "active": active,
            "windows": [{"title": w["title"], "process": w["process"]} for w in wins]}


@app.post("/tool/close_app")
def close_app(arg: CloseApp):
    """Close every window of an app politely; force=true kills it if it hangs."""
    matches = _matching_windows(arg.name)
    if not matches:
        return {"ok": True, "already_closed": True, "closed": []}
    Desktop = _import_pywinauto()
    closed, pids = [], set()
    for w in matches:
        try:
            win = Desktop(backend="uia").window(handle=w["handle"])
            pids.add(win.process_id())
            win.close()
            closed.append(w["title"])
        except Exception:
            continue
    time.sleep(1.0)
    remaining = _matching_windows(arg.name)
    killed = []
    if remaining and arg.force:
        try:
            import psutil  # type: ignore
            for pid in pids:
                try:
                    psutil.Process(pid).kill()
                    killed.append(pid)
                except Exception:
                    continue
        except Exception:
            pass
        time.sleep(0.5)
        remaining = _matching_windows(arg.name)
    _invalidate_desktop_cache()
    out = {"ok": not remaining, "closed": closed, "killed_pids": killed,
           "still_open": [w["title"] for w in remaining]}
    if remaining and not arg.force:
        out["note"] = "Some windows are still open (maybe an unsaved-changes prompt). Check the screen, or retry with force=true."
    return out


@app.post("/tool/window_action")
def window_action(arg: WindowAction):
    """Maximize / minimize / restore / snap left or right / focus a window."""
    action = arg.action.lower().strip()
    if action not in {"maximize", "minimize", "restore", "snap_left", "snap_right", "focus"}:
        raise HTTPException(400, f"Unknown action '{arg.action}'.")
    pyautogui = _import_pyautogui()
    Desktop = _import_pywinauto()
    try:
        title = None
        if arg.name:
            w = _resolve_one_window(arg.name)
            title = w["title"]
            if action != "minimize" and not _focus_window(w["handle"]):
                raise HTTPException(500, f"Could not bring '{title}' to the front.")
            win = Desktop(backend="uia").window(handle=w["handle"]) if Desktop else None
        else:
            win = None
            try:
                title = _active_window_info().get("title")
            except Exception:
                pass
        if action == "maximize":
            win.maximize() if win else pyautogui.hotkey("win", "up")
        elif action == "minimize":
            win.minimize() if win else pyautogui.hotkey("win", "down")
        elif action == "restore":
            win.restore() if win else pyautogui.hotkey("win", "down")
        elif action == "snap_left":
            pyautogui.hotkey("win", "left")
        elif action == "snap_right":
            pyautogui.hotkey("win", "right")
        time.sleep(0.3)
        _invalidate_desktop_cache()
        return {"ok": True, "action": action, "window": title}
    except HTTPException:
        raise
    except Exception as e:
        msg = _failsafe_message(e)
        raise HTTPException(500, msg or f"window_action failed: {e}")


@app.post("/tool/set_volume")
def set_volume(arg: SetVolume):
    """Set master volume (0-100) and/or mute. Uses Windows media keys (2% steps)."""
    if arg.level is None and arg.mute is None:
        raise HTTPException(400, "Pass level (0-100) and/or mute.")
    pyautogui = _import_pyautogui()
    out = {"ok": True}
    if arg.level is not None:
        level = max(0, min(100, int(arg.level)))
        pyautogui.press("volumedown", presses=50, interval=0.01)
        steps = round(level / 2)
        if steps:
            pyautogui.press("volumeup", presses=steps, interval=0.01)
        out["level"] = steps * 2
    if arg.mute is not None:
        if arg.mute:
            pyautogui.press("volumemute")
        elif arg.level is None:
            # Unmute reliably: any volume key unmutes; nudge down then up.
            pyautogui.press("volumedown")
            pyautogui.press("volumeup")
        out["mute"] = arg.mute
    return out


_MEDIA_KEYS = {"play_pause": "playpause", "play": "playpause", "pause": "playpause",
               "next": "nexttrack", "previous": "prevtrack", "prev": "prevtrack",
               "stop": "stop", "mute": "volumemute"}


@app.post("/tool/media_control")
def media_control(arg: MediaControl):
    """Control whatever is playing (Spotify, YouTube, VLC...) in the background."""
    key = _MEDIA_KEYS.get(arg.action.lower().strip())
    if key is None:
        raise HTTPException(400, f"Unknown media action '{arg.action}'. Use one of: {sorted(set(_MEDIA_KEYS))}")
    _import_pyautogui().press(key)
    return {"ok": True, "action": arg.action, "key": key}


def _folder_aliases() -> dict:
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    desktop_dirs = _default_search_dirs()
    desktop = desktop_dirs[0] if desktop_dirs else home / "Desktop"
    onedrive = Path(os.environ["OneDrive"]) if os.environ.get("OneDrive") else None

    def pick(name: str) -> Path:
        if onedrive and (onedrive / name).exists():
            return onedrive / name
        return home / name

    return {
        "home": home, "user": home,
        "desktop": desktop, "others": desktop / "Others",
        "downloads": home / "Downloads",
        "documents": pick("Documents"), "docs": pick("Documents"),
        "pictures": pick("Pictures"), "photos": pick("Pictures"),
        "music": home / "Music", "videos": home / "Videos",
    }


@app.post("/tool/open_folder")
def open_folder(arg: OpenFolder):
    """Open a folder in File Explorer by alias (downloads, documents...) or path."""
    raw = arg.target.strip()
    if not raw:
        raise HTTPException(400, "open_folder requires a target")
    key = raw.lower().removeprefix("my ").removesuffix(" folder").strip()
    folder = _folder_aliases().get(key)
    if folder is None:
        folder = Path(os.path.expandvars(raw)).expanduser()
    if not folder.exists():
        raise HTTPException(404, f"Folder not found: {folder}")
    if not folder.is_dir():
        folder = folder.parent
    os.startfile(str(folder))  # type: ignore[attr-defined]
    _invalidate_desktop_cache()
    return {"ok": True, "opened": str(folder)}


# ===================== BROWSER COWORK =====================
class BrowserGoto(BaseModel):
    url: str

class BrowserClick(BaseModel):
    selector: str | None = None
    text: str | None = None
    nth: int = 0  # which match to use when multiple match (0-based)

class BrowserType(BaseModel):
    selector: str
    text: str
    submit: bool = False

class BrowserScroll(BaseModel):
    dy: int = 400

class BrowserKey(BaseModel):
    key: str


@app.post("/tool/browser_open")
def browser_open():
    driver = _ensure_browser(headless=False)
    return {"ok": True, "url": driver.current_url, "title": driver.title, "engine": "selenium-chrome"}


@app.post("/tool/browser_goto")
def browser_goto(arg: BrowserGoto):
    driver = _ensure_browser(headless=False)
    url = arg.url if "://" in arg.url else f"https://{arg.url}"
    driver.get(url)
    _inject_cursor(driver)
    return {"ok": True, "url": driver.current_url, "title": driver.title}


@app.post("/tool/browser_click")
def browser_click(arg: BrowserClick):
    driver = _ensure_browser(headless=False)
    try:
        element = _find_element(driver, arg.selector, arg.text, clickable=True, nth=arg.nth)
        center = _element_center(driver, element)
        _move_cursor(driver, center["x"], center["y"])
        _flash_cursor(driver)
        try:
            element.click()
        except Exception:
            # Fallback: JS click bypasses overlay/intercept issues common on SERPs
            driver.execute_script("arguments[0].click();", element)
        return {"ok": True, "clicked": arg.selector or arg.text, "nth": arg.nth}
    except Exception as e:
        raise HTTPException(500, f"Click failed: {e}")


@app.post("/tool/browser_type")
def browser_type(arg: BrowserType):
    driver = _ensure_browser(headless=False)
    try:
        _webdriver, _By, Keys, _ActionChains, _WebDriverWait, _EC = _import_selenium()
        element = _find_element(driver, arg.selector, clickable=True)
        center = _element_center(driver, element)
        _move_cursor(driver, center["x"], center["y"])
        _flash_cursor(driver)
        element.click()
        element.send_keys(Keys.CONTROL, "a")
        element.send_keys(arg.text)
        if arg.submit:
            element.send_keys(Keys.ENTER)
        return {"ok": True, "typed": arg.text, "into": arg.selector}
    except Exception as e:
        raise HTTPException(500, f"Type failed: {e}")


@app.post("/tool/browser_press")
def browser_press(arg: BrowserKey):
    driver = _ensure_browser(headless=False)
    _webdriver, _By, Keys, ActionChains, _WebDriverWait, _EC = _import_selenium()
    key = getattr(Keys, arg.key.upper(), arg.key)
    ActionChains(driver).send_keys(key).perform()
    return {"ok": True, "pressed": arg.key}


@app.post("/tool/browser_scroll")
def browser_scroll(arg: BrowserScroll):
    driver = _ensure_browser(headless=False)
    driver.execute_script("window.scrollBy(0, arguments[0])", int(arg.dy))
    return {"ok": True, "dy": arg.dy}


@app.post("/tool/browser_read")
def browser_read():
    driver = _ensure_browser(headless=False)
    try:
        _inject_cursor(driver)
        return driver.execute_script(r"""
  const text = (document.body.innerText || '').slice(0, 4000);
  const els = [];
  const seenKeys = new Set();
  const isVisible = (el, r) => {
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.top > innerHeight + 400) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return false;
    return true;
  };
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let part = n.tagName.toLowerCase();
      if (n.classList && n.classList.length) {
        const cls = Array.from(n.classList).slice(0,2).map(c => '.' + CSS.escape(c)).join('');
        part += cls;
      }
      const parent = n.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === n.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n)+1})`;
      }
      parts.unshift(part);
      n = n.parentElement;
      if (n && n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
    }
    return parts.join(' > ');
  };

  // 1) Search-result links (Google/Bing/DuckDuckGo etc.) — enumerated for easy nth targeting
  const results = [];
  const resultSelectors = [
    'div#search a h3',           // Google
    'div.g a h3',                // Google
    'li.b_algo h2 a',            // Bing
    'h2 a[href]',                // generic
    'article a[href]',           // generic
    '#links .result__a',         // DuckDuckGo
    '[data-testid="result-title-a"]', // DDG new
  ];
  const resultLinks = new Set();
  for (const sel of resultSelectors) {
    document.querySelectorAll(sel).forEach(el => {
      const a = el.tagName === 'A' ? el : el.closest('a');
      if (!a || !a.href) return;
      if (a.href.startsWith('javascript:') || a.href.includes('#')) {/* still allow */}
      if (resultLinks.has(a.href)) return;
      const r = a.getBoundingClientRect();
      if (!isVisible(a, r)) return;
      resultLinks.add(a.href);
      results.push({
        index: results.length,
        title: (el.innerText || a.innerText || '').trim().slice(0, 140),
        href: a.href,
        selector: cssPath(a),
      });
    });
    if (results.length >= 15) break;
  }

  // 2) Generic interactive controls
  document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) return;
    const key = Math.round(r.top)+'_'+Math.round(r.left)+'_'+el.tagName;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    els.push({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0,100),
      href: el.tagName === 'A' ? el.href : null,
      id: el.id || null,
      name: el.getAttribute('name') || null,
      type: el.getAttribute('type') || null,
      selector: cssPath(el),
    });
  });

  return { url: location.href, title: document.title, text, results, controls: els.slice(0, 80) };
""")
    except Exception as e:
        raise HTTPException(500, f"Read failed: {e}")


@app.post("/tool/browser_close")
def browser_close():
    with _browser_lock:
        try:
            if _browser_state["driver"]:
                _browser_state["driver"].quit()
        finally:
            _browser_state.update({"driver": None})
    return {"ok": True}


# --------------------------------------------------------------------------- #
# ESP / IoT generic project routes (see esp_manager.py)
# --------------------------------------------------------------------------- #
try:
    import esp_manager
except Exception:  # pragma: no cover - keeps the agent alive if the file is missing
    esp_manager = None


def _esp():
    if esp_manager is None:
        raise HTTPException(500, "esp_manager.py is missing next to nexus_agent.py")
    return esp_manager


def _esp_call(fn, *args, **kwargs):
    mgr = _esp()
    try:
        return fn(*args, **kwargs)
    except mgr.EspError as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"{type(e).__name__}: {e}")


@app.get("/esp/projects")
def esp_projects_list():
    mgr = _esp()
    return {"projects": [mgr.redact(p) for p in mgr.list_projects()], "store": str(mgr.STORE_PATH)}


@app.post("/esp/projects")
async def esp_projects_save(request: Request):
    mgr = _esp()
    payload = await request.json()
    if isinstance(payload, dict) and "project" in payload:
        payload = payload["project"]
    project = _esp_call(mgr.save_project, payload)
    return {"ok": True, "project": mgr.redact(project)}


@app.delete("/esp/projects/{project_id}")
def esp_projects_delete(project_id: str):
    mgr = _esp()
    if not _esp_call(mgr.delete_project, project_id):
        raise HTTPException(404, f"No project '{project_id}'")
    return {"ok": True, "deleted": project_id}


@app.get("/esp/projects/{project_id}/status")
def esp_project_status(project_id: str):
    return _esp_call(_esp().project_status, project_id)


class EspCommandIn(BaseModel):
    project_id: str
    device_id: str
    command_id: str
    parameters: dict | None = None


@app.post("/esp/execute")
def esp_execute(payload: EspCommandIn):
    return _esp_call(
        _esp().execute_device_command,
        payload.project_id,
        payload.device_id,
        payload.command_id,
        payload.parameters or {},
    )


# ---- AI-facing tools (same /tool/<name> convention as every other tool) ----
@app.post("/tool/esp_list_projects")
def tool_esp_list_projects():
    return _esp().capabilities_summary()


@app.post("/tool/esp_get_project")
async def tool_esp_get_project(request: Request):
    mgr = _esp()
    body = await request.json()
    project = mgr.get_project(str(body.get("project_id", "")))
    if not project:
        raise HTTPException(404, f"No registered project matching '{body.get('project_id')}'")
    return mgr.redact(project)


@app.post("/tool/esp_register_project")
async def tool_esp_register_project(request: Request):
    mgr = _esp()
    body = await request.json()
    if isinstance(body, dict) and "project" in body:
        body = body["project"]
    project = _esp_call(mgr.save_project, body)
    return {
        "ok": True,
        "registered": mgr.redact(project),
        "summary": f"{project['name']} @ {project['protocol']}://{project['host']} with "
                   f"{len(project['devices'])} device(s)",
    }


@app.post("/tool/esp_delete_project")
async def tool_esp_delete_project(request: Request):
    body = await request.json()
    if not _esp_call(_esp().delete_project, str(body.get("project_id", ""))):
        raise HTTPException(404, f"No project '{body.get('project_id')}'")
    return {"ok": True}


@app.post("/tool/esp_status")
async def tool_esp_status(request: Request):
    body = await request.json()
    return _esp_call(_esp().project_status, str(body.get("project_id", "")))


@app.post("/tool/device_command")
async def tool_device_command(request: Request):
    body = await request.json()
    return _esp_call(
        _esp().execute_device_command,
        str(body.get("project_id", "")),
        str(body.get("device_id", "")),
        str(body.get("command_id", "")),
        body.get("parameters") or {},
    )


# --------------------------------------------------------------------------- #
# NEXUS Android Agent bridge (direct passthrough, no fallback)
# --------------------------------------------------------------------------- #
# The Android Agent app (dev.nexus.androidagent) dials *out* over Tailscale,
# long-polls this agent for work, runs the command on the device and posts its
# JSON envelope back. NEXUS drives it through /tool/phone_* below.
#
#   NEXUS (Artemis) -> this PC Agent -> (Tailscale, long-poll) -> Android Agent
#
# Auth is the same NEXUS_AGENT_TOKEN as every other route (the /agent/* paths
# are NOT in PUBLIC_PATHS, so the middleware enforces it). There is no other
# route to the phone: if the link is down, phone tools answer 503.

import asyncio as _asyncio
import json as _json
import uuid as _uuid

from fastapi.responses import JSONResponse

_PHONE_LOCK = threading.Lock()
_PHONE_AGENTS: dict[str, dict] = {}     # agent_id -> registration + liveness
_PHONE_PENDING: list[dict] = []         # commands waiting to be polled
_PHONE_RESULTS: dict[str, dict] = {}    # request_id -> envelope posted by phone
_PHONE_RESULT_AT: dict[str, float] = {} # request_id -> receive time (kept out of the envelope)
_PHONE_EVENTS: dict[str, threading.Event] = {}
_PHONE_POLL_MAX_WAIT = 30               # seconds a phone may hold a poll open
_PHONE_RESULT_KEEP = 200                # cap on remembered results

PHONE_TIMEOUT_DEFAULT = 30
PHONE_TIMEOUT_MIN = 1
PHONE_TIMEOUT_MAX = 120
# Screenshots (screenshot_b64) and UI trees (xml) are large. Every body on the
# phone path, in both directions, may be up to this size.
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024    # 16 MB (>= 8 MB required)

_TRANSPORT_PATHS = {"/agent/hello", "/agent/poll", "/agent/result", "/tool/phone_agent_command"}


@app.middleware("http")
async def _payload_size_limit(request: Request, call_next):
    """Explicit body cap for the phone path (uvicorn/Starlette have no smaller cap)."""
    if request.url.path in _TRANSPORT_PATHS:
        try:
            length = int(request.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length > MAX_PAYLOAD_BYTES:
            return JSONResponse(
                status_code=413,
                content={"ok": False, "code": "INVALID_ARGS", "message": "payload_too_large",
                         "max_bytes": MAX_PAYLOAD_BYTES},
            )
    return await call_next(request)


def clamp_timeout(value) -> int:
    """timeout_sec: default 30, clamped to 1..120. Non-numeric -> default."""
    if value is None:
        return PHONE_TIMEOUT_DEFAULT
    try:
        v = int(value)
    except (TypeError, ValueError):
        return PHONE_TIMEOUT_DEFAULT
    return max(PHONE_TIMEOUT_MIN, min(PHONE_TIMEOUT_MAX, v))


def _err(status: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "code": code, "message": message, **extra})


def _phone_prune() -> None:
    if len(_PHONE_RESULTS) > _PHONE_RESULT_KEEP:
        for rid in sorted(_PHONE_RESULTS, key=lambda r: _PHONE_RESULT_AT.get(r, 0))[:50]:
            _PHONE_RESULTS.pop(rid, None)
            _PHONE_RESULT_AT.pop(rid, None)
            _PHONE_EVENTS.pop(rid, None)


def _phone_online(entry: dict) -> bool:
    return (time.time() - float(entry.get("last_seen") or 0)) < 90


def _online_agents() -> list[dict]:
    return [a for a in _PHONE_AGENTS.values() if _phone_online(a)]


def _describe_size(payload: dict) -> str:
    """Log-safe summary: never prints screenshot_b64 / xml contents."""
    parts = []
    for key in ("screenshot_b64", "xml"):
        v = payload.get(key)
        if isinstance(v, str):
            parts.append(f"{key}={len(v)}B")
    return " ".join(parts)


@app.post("/agent/hello")
async def agent_hello(request: Request):
    """Registration from a NEXUS Android Agent."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "malformed_json")
    if not isinstance(payload, dict):
        raise HTTPException(400, "malformed_json")
    agent_id = str(payload.get("agent_id") or "unknown")[:64]
    caps = payload.get("capabilities")
    with _PHONE_LOCK:
        _PHONE_AGENTS[agent_id] = {
            "agent_id": agent_id,
            "agent_kind": payload.get("agent_kind") or "android",
            "protocol_version": payload.get("protocol_version"),
            "app_version": payload.get("app_version"),
            "device_model": payload.get("device_model"),
            "android_release": payload.get("android_release"),
            "android_sdk": payload.get("android_sdk"),
            # Stored exactly as reported (never filtered or renamed).
            "capabilities": caps if caps is not None else [],
            "registered_at": time.time(),
            "last_seen": time.time(),
        }
    print(f"[nexus] android agent registered: {agent_id} "
          f"({payload.get('device_model')} / Android {payload.get('android_release')}, "
          f"{len(caps) if isinstance(caps, list) else 0} capabilities)")
    return {"ok": True, "agent_id": agent_id, "registered": True, "agent_version": AGENT_VERSION}


@app.post("/agent/poll")
async def agent_poll(request: Request):
    """Long-poll: hand the phone any queued commands (or an empty list)."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    agent_id = str(payload.get("agent_id") or "unknown")[:64]
    try:
        wait = max(0, min(_PHONE_POLL_MAX_WAIT, int(payload.get("wait") or 25)))
    except (TypeError, ValueError):
        wait = 25
    with _PHONE_LOCK:
        entry = _PHONE_AGENTS.setdefault(agent_id, {"agent_id": agent_id, "agent_kind": "android", "capabilities": []})
        entry["last_seen"] = time.time()

    deadline = time.time() + wait
    while True:
        with _PHONE_LOCK:
            _PHONE_AGENTS[agent_id]["last_seen"] = time.time()
            if _PHONE_PENDING:
                batch = _PHONE_PENDING[:]
                _PHONE_PENDING.clear()
                return {"ok": True, "commands": batch}
        if time.time() >= deadline:
            return {"ok": True, "commands": []}
        # Non-blocking sleep so other requests keep flowing during a long-poll.
        await _asyncio.sleep(0.1)


@app.post("/agent/result")
async def agent_result(request: Request):
    """Envelope coming back from the phone, matched to its request by request_id."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "malformed_json")
    if not isinstance(payload, dict):
        raise HTTPException(400, "malformed_json")
    rid = payload.get("request_id")
    with _PHONE_LOCK:
        agent_id = str(payload.get("agent_id") or "")
        if agent_id in _PHONE_AGENTS:
            _PHONE_AGENTS[agent_id]["last_seen"] = time.time()
        if isinstance(rid, str) and rid:
            _PHONE_RESULTS[rid] = payload
            _PHONE_RESULT_AT[rid] = time.time()
            ev = _PHONE_EVENTS.get(rid)
            if ev:
                ev.set()
        _phone_prune()
    print(f"[nexus] android result <- {rid} code={payload.get('code')} {_describe_size(payload)}".rstrip())
    return {"ok": True}


def _phone_dispatch(command: str, args, timeout: int):
    """Queue one command, wait for its matching envelope, return it verbatim."""
    rid = f"req-{_uuid.uuid4().hex}"
    item = {"request_id": rid, "command": command, "args": args if args is not None else {}}
    ev = threading.Event()
    with _PHONE_LOCK:
        if not _online_agents():
            return _err(503, "DEVICE_ERROR", "phone_not_connected")
        _PHONE_EVENTS[rid] = ev
        _PHONE_PENDING.append(item)
    print(f"[nexus] android command -> {rid} {command} (timeout {timeout}s)")
    answered = ev.wait(timeout)
    with _PHONE_LOCK:
        _PHONE_EVENTS.pop(rid, None)
        if not answered:
            # Drop it if the phone never picked it up, so it doesn't run late.
            _PHONE_PENDING[:] = [p for p in _PHONE_PENDING if p.get("request_id") != rid]
            return _err(504, "TIMEOUT", "phone_timeout")
        result = _PHONE_RESULTS.pop(rid, None)
        _PHONE_RESULT_AT.pop(rid, None)
    if not isinstance(result, dict):
        return _err(504, "TIMEOUT", "phone_timeout")
    return JSONResponse(status_code=200, content=result)


@app.post("/tool/phone_agent_status")
@app.get("/tool/phone_agent_status")
def tool_phone_agent_status():
    """Which NEXUS Android Agents are connected, and what they can do."""
    now = time.time()
    with _PHONE_LOCK:
        agents = [
            {**a,
             "online": _phone_online(a),
             "last_seen": a.get("last_seen"),
             "seconds_since_seen": round(now - float(a.get("last_seen") or 0), 1)}
            for a in _PHONE_AGENTS.values()
        ]
        queued = len(_PHONE_PENDING)
    return {
        "ok": True,
        "agent_version": AGENT_VERSION,
        "connected": any(a["online"] for a in agents),
        "agents": agents,
        "queued_commands": queued,
        "max_payload_bytes": MAX_PAYLOAD_BYTES,
        "timeout_sec": {"default": PHONE_TIMEOUT_DEFAULT, "min": PHONE_TIMEOUT_MIN, "max": PHONE_TIMEOUT_MAX},
    }


@app.post("/tool/phone_agent_command")
async def tool_phone_agent_command(request: Request):
    """Run one command on the phone, checked against the phone's own capabilities.

    Accepts either {"command", "args", "timeout_sec"} or the wrapped form
    {"tool": "phone_agent_command", "args": {"command", "args", "timeout_sec"}}.
    """
    try:
        body = _json.loads(await request.body() or b"null")
    except Exception:
        return _err(400, "INVALID_ARGS", "malformed_json")
    if isinstance(body, dict) and body.get("tool") == "phone_agent_command" and isinstance(body.get("args"), dict):
        body = body["args"]
    if not isinstance(body, dict):
        return _err(400, "INVALID_ARGS", "body_must_be_object")
    command = body.get("command")
    if not isinstance(command, str) or not command.strip():
        return _err(400, "INVALID_ARGS", "missing_command")
    args = body.get("args")
    if args is not None and not isinstance(args, dict):
        return _err(400, "INVALID_ARGS", "args_must_be_object", command=command)
    timeout = clamp_timeout(body.get("timeout_sec"))

    with _PHONE_LOCK:
        online = _online_agents()
        if not online:
            return _err(503, "DEVICE_ERROR", "phone_not_connected")
        caps: set[str] = set()
        for a in online:
            c = a.get("capabilities")
            if isinstance(c, list):
                caps.update(x for x in c if isinstance(x, str))
    if command not in caps:
        return _err(400, "UNSUPPORTED", "unsupported_command", command=command)

    # Blocking wait runs off the event loop so parallel requests and polls continue.
    return await _asyncio.to_thread(_phone_dispatch, command, args, timeout)


@app.post("/tool/phone_ping")
@app.get("/tool/phone_ping")
def tool_phone_ping():
    """Liveness check against the phone itself."""
    return _phone_dispatch("ping", {"echo": "nexus"}, 15)


@app.post("/tool/phone_info")
@app.get("/tool/phone_info")
def tool_phone_info():
    """Device model / Android version / ABIs reported by the phone app."""
    return _phone_dispatch("device_info", {}, 15)


if __name__ == "__main__":
    import uvicorn
    _mark_dpi_aware()
    print("=" * 60)
    host = (os.environ.get("NEXUS_AGENT_HOST") or "127.0.0.1").strip()
    port = int(os.environ.get("NEXUS_AGENT_PORT") or 7337)
    print("  N.E.X.U.S. Local Agent")
    print(f"  Listening on http://{host}:{port}")
    print(f"  Android Agent bridge: /agent/hello|poll|result  (auth {'ON' if AGENT_TOKEN else 'OFF'})")
    print(f"  Phone payload limit: {MAX_PAYLOAD_BYTES // (1024*1024)} MB, timeout {PHONE_TIMEOUT_MIN}-{PHONE_TIMEOUT_MAX}s (default {PHONE_TIMEOUT_DEFAULT}s)")
    print("  Browser cowork: ask NEXUS to 'open a browser and...'")
    print("  ESP/IoT: register projects in the web UI or by describing them to NEXUS.")
    print("  Desktop cowork: ask NEXUS to inspect/click/type in desktop apps.")
    print("  Keep this window open while using the NEXUS web UI.")
    print("=" * 60)
    uvicorn.run(app, host=host, port=port, log_level="info")
