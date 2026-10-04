"""
UFO desktop control for NEXUS, running on Microsoft UFO's own source code.

On Windows the control tree comes from UFO's ControlInspectorFacade (vendored verbatim in
./ufo_vendor: Win32 window anchoring, cached UIA FindAll, COM condition filtering) and every
action runs through UFO's ControlReceiver (click_input, set_edit_text, keyboard_input) on the
real control element. Off Windows / in tests a pywinauto-style fallback is used.

Instead of guessing pixel coordinates from OCR/screenshots, this module reads the
UI Automation control tree of the foreground window (plus any open transient
popup/menu), keeps only interactive controls, numbers them 1..N and clicks the
VERIFIED centre of the control the model picks. `click_norm` is a deterministic
0-1000 grid fallback for surfaces with no usable UIA tree (games, canvases).

Mounted into nexus_agent.py via `ufo_router` (/ufo/*) and `ufo_tool_router`
(/tool/ufo_* aliases used by the NEXUS web tool layer). All hardware access goes
through `_get_desktop()` / `_get_gui()` / `_foreground_handle()` so tests can mock it.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

IS_WIN = sys.platform.startswith("win")

ufo_router = APIRouter(prefix="/ufo")
ufo_tool_router = APIRouter(prefix="/tool")

UFO_ENDPOINTS = ["/ufo/controls", "/ufo/click_control", "/ufo/click_norm",
                 "/ufo/type_into_control", "/ufo/keyboard_input"]
UFO_TOOLS = ["ufo_get_controls", "ufo_click_control", "ufo_click_norm",
             "ufo_type_into_control", "ufo_keyboard_input"]
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ufo_vendor")

POPUP_SETTLE_SEC = 0.15  # closed-loop wait for menus/flyouts after a click
MAX_CONTROLS = 120

INTERACTIVE_TYPES = {
    "MenuItem", "Button", "SplitButton", "Edit", "CheckBox", "RadioButton",
    "TabItem", "ComboBox", "ListItem", "TreeItem", "Hyperlink", "DataItem",
    "MenuBarItem", "Slider", "Spinner", "Document",
}
CONTAINER_TYPES = {
    "Pane", "Group", "Window", "Custom", "Text", "Image", "Separator", "ToolBar",
    "StatusBar", "TitleBar", "ScrollBar", "Thumb", "Header", "HeaderItem", "Menu",
    "MenuBar", "List", "Tree", "Tab", "Table", "ToolTip", "Calendar", "ProgressBar",
}
# Win32 menu, WPF popup, XAML flyout / light-dismiss surfaces.
POPUP_CLASSES = {
    "#32768", "Popup", "PopupRoot", "Xaml_WindowedPopupClass", "DropDown",
    "ComboLBox", "Microsoft.UI.Content.PopupWindowSiteBridge", "FlyoutPresenter",
    "MenuFlyoutPresenter", "LightDismissOverlay",
}
POPUP_TYPES = {"Menu", "ToolTip"}
# Real UIA ControlType names passed to UFO's COM condition (MenuBarItem is not a UIA type).
UIA_QUERY_TYPES = INTERACTIVE_TYPES - {"MenuBarItem"}


class UFOControlItem(BaseModel):
    id: int
    name: str
    control_type: str
    rect: list[int]          # [left, top, right, bottom] screen pixels
    center: list[int]        # [x, y] exact centroid of rect
    norm_center: list[int]   # [x, y] on the 0-1000 grid
    is_popup: bool = False


class ClickControlIn(BaseModel):
    control_id: int
    click_type: Literal["single", "double", "right"] = "single"


class TypeIntoControlIn(BaseModel):
    control_id: int
    text: str
    clear_first: bool = True
    submit: bool = False


class KeyboardInputIn(BaseModel):
    keys: str                       # pywinauto syntax: "%c" Alt+C, "^a" Ctrl+A, "{ENTER}"
    control_id: Optional[int] = None


class ClickNormIn(BaseModel):
    norm_x: int = Field(ge=0, le=1000)
    norm_y: int = Field(ge=0, le=1000)
    click_type: Literal["single", "double", "right"] = "single"


_ACTIVE_CONTROLS: dict[int, UFOControlItem] = {}
_ACTIVE_ELEMENTS: dict[int, tuple[Any, Any]] = {}   # id -> (control wrapper, app window)
_STATE: dict[str, Any] = {"window_title": None, "ts": 0.0}
_LOCK = threading.Lock()


# --------------------------------------------------------------------------- backends
def _get_ufo():
    """(ControlInspectorFacade instance, ControlReceiver class) from vendored UFO, or None."""
    if not IS_WIN:
        return None
    try:
        if _VENDOR not in sys.path:
            sys.path.insert(0, _VENDOR)
        from ufo.automator.ui_control.inspector import ControlInspectorFacade  # type: ignore
        from ufo.automator.ui_control.controller import ControlReceiver  # type: ignore
        return ControlInspectorFacade("uia"), ControlReceiver
    except Exception as e:
        _STATE["ufo_error"] = f"{type(e).__name__}: {e}"
        return None


def _get_desktop():
    """pywinauto Desktop(backend='uia') or None when UIA is unavailable."""
    if not IS_WIN:
        return None
    try:
        from pywinauto import Desktop  # type: ignore
        return Desktop(backend="uia")
    except Exception:
        return None


def _get_gui():
    try:
        import pyautogui  # type: ignore
        return pyautogui
    except ImportError as e:
        raise HTTPException(500, f"PyAutoGUI is required for UFO clicks: {e}")


def _foreground_handle() -> Optional[int]:
    if not IS_WIN:
        return None
    try:
        import ctypes
        return int(ctypes.windll.user32.GetForegroundWindow()) or None  # type: ignore[attr-defined]
    except Exception:
        return None


def _screen_size() -> tuple[int, int]:
    w, h = _get_gui().size()
    return int(w), int(h)


# --------------------------------------------------------------------------- helpers
def _info(el, attr: str, default: Any = "") -> Any:
    try:
        v = getattr(el.element_info, attr)
        return default if v is None else v
    except Exception:
        return default


def _rect(el) -> Optional[list[int]]:
    try:
        r = el.rectangle()
        return [int(r.left), int(r.top), int(r.right), int(r.bottom)]
    except Exception:
        return None


def _call(el, name: str, default: bool = True) -> bool:
    try:
        return bool(getattr(el, name)())
    except Exception:
        return default


def _is_popup(el) -> bool:
    return _info(el, "class_name") in POPUP_CLASSES or _info(el, "control_type") in POPUP_TYPES


def _label(el) -> str:
    name = str(_info(el, "name") or "").strip()
    if not name:
        try:
            name = str(el.window_text() or "").strip()
        except Exception:
            name = ""
    if not name:
        name = str(_info(el, "automation_id") or "").strip()
    return name[:80]


class UFOControlExtractor:
    """Foreground window + transient popups → compact numbered interactive controls."""

    def __init__(self, desktop=None, screen: Optional[tuple[int, int]] = None,
                 foreground: Optional[int] = None, inspector=None):
        self.desktop = desktop
        self.inspector = inspector      # UFO ControlInspectorFacade when available
        self.screen = screen
        self.foreground = foreground
        self.elements: list[tuple[Any, Any]] = []

    # -- window resolution ------------------------------------------------------------
    def _top_windows(self) -> list:
        try:
            if self.inspector is not None:
                return list(self.inspector.get_desktop_windows(remove_empty=False))
            return list(self.desktop.windows())
        except Exception:
            return []

    def foreground_window(self, windows: list):
        """GetForegroundWindow handle match → focused/active flag → first visible titled window."""
        fg = self.foreground
        if fg:
            for w in windows:
                if _info(w, "handle", None) == fg:
                    return w
        for w in windows:
            if _call(w, "has_keyboard_focus", False) or _call(w, "is_active", False):
                return w
        for w in windows:
            if _call(w, "is_visible") and _label(w) and not _is_popup(w):
                return w
        return None

    def popups(self, windows: list, main) -> list:
        out = [w for w in windows if w is not main and _is_popup(w) and _call(w, "is_visible")]
        if self.inspector is not None:
            return out  # UFO's condition query below already reaches in-window popups
        # Menus/flyouts that live inside the main window's tree (XAML, WPF in-window popups).
        if main is not None:
            try:
                for d in main.descendants():
                    if _is_popup(d) and _call(d, "is_visible") and d not in out:
                        out.append(d)
            except Exception:
                pass
        return out

    # -- filtering --------------------------------------------------------------------
    def _keep(self, el) -> Optional[tuple[str, str, list[int]]]:
        ctype = str(_info(el, "control_type") or "")
        if ctype in CONTAINER_TYPES or ctype not in INTERACTIVE_TYPES:
            return None
        if not _call(el, "is_visible") or not _call(el, "is_enabled"):
            return None
        r = _rect(el)
        if not r or r[2] - r[0] <= 0 or r[3] - r[1] <= 0:
            return None
        if self.screen:
            w, h = self.screen
            if r[2] <= 0 or r[3] <= 0 or r[0] >= w or r[1] >= h:
                return None
        name = _label(el)
        if not name and ctype not in {"Edit", "Document", "ComboBox"}:
            return None
        return name, ctype, r

    def _nodes(self, root) -> list:
        if self.inspector is not None:
            # UFO: one cached FindAll with an enabled/on-screen/control-type COM condition.
            try:
                return list(self.inspector.find_control_elements_in_descendants(
                    root, control_type_list=sorted(UIA_QUERY_TYPES)))
            except Exception:
                return []
        try:
            return [root] + list(root.descendants())
        except Exception:
            return [root]

    def _collect(self, root, is_popup: bool, seen: set, app=None) -> list[tuple]:
        found = []
        nodes = self._nodes(root)
        for el in nodes:
            k = self._keep(el)
            if not k:
                continue
            key = (k[1], k[0], tuple(k[2]))
            if key in seen:
                continue
            seen.add(key)
            found.append((*k, is_popup, el, app if app is not None else root))
        return found

    def extract(self) -> tuple[Optional[str], list[UFOControlItem]]:
        self.elements = []
        if self.desktop is None and self.inspector is None:
            return None, []
        windows = self._top_windows()
        main = self.foreground_window(windows)
        seen: set = set()
        raw: list[tuple] = []
        for p in self.popups(windows, main):           # popups FIRST
            raw += self._collect(p, True, seen, main)
        if main is not None:
            raw += self._collect(main, False, seen, main)
        sw, sh = self.screen or (0, 0)
        items: list[UFOControlItem] = []
        for i, (name, ctype, r, pop, el, app) in enumerate(raw[:MAX_CONTROLS], start=1):
            self.elements.append((el, app))
            cx, cy = (r[0] + r[2]) // 2, (r[1] + r[3]) // 2
            nx = round(cx / sw * 1000) if sw else 0
            ny = round(cy / sh * 1000) if sh else 0
            items.append(UFOControlItem(id=i, name=name, control_type=ctype, rect=r,
                                        center=[cx, cy], norm_center=[nx, ny], is_popup=pop))
        return (_label(main) if main is not None else None), items


# --------------------------------------------------------------------------- core ops
def norm_to_pixels(norm_x: int, norm_y: int, width: int, height: int) -> tuple[int, int]:
    x = round(norm_x / 1000 * width)
    y = round(norm_y / 1000 * height)
    return min(max(x, 0), max(width - 1, 0)), min(max(y, 0), max(height - 1, 0))


def _do_click(x: int, y: int, click_type: str) -> None:
    gui = _get_gui()
    if click_type == "double":
        gui.doubleClick(x=x, y=y)
    elif click_type == "right":
        gui.rightClick(x=x, y=y)
    else:
        gui.click(x=x, y=y)


def refresh_controls() -> dict:
    try:
        screen = _screen_size()
    except HTTPException:
        screen = None
    ufo = _get_ufo()
    _STATE["engine_ufo"] = ufo is not None
    if ufo is not None:
        ext = UFOControlExtractor(None, screen, _foreground_handle(), inspector=ufo[0])
    else:
        ext = UFOControlExtractor(_get_desktop(), screen, _foreground_handle())
    title, items = ext.extract()
    with _LOCK:
        _ACTIVE_CONTROLS.clear()
        _ACTIVE_CONTROLS.update({c.id: c for c in items})
        _ACTIVE_ELEMENTS.clear()
        _ACTIVE_ELEMENTS.update({c.id: e for c, e in zip(items, ext.elements)})
        _STATE["window_title"] = title
        _STATE["ts"] = time.time()
    return _compact(title, items)


def _compact(title: Optional[str], items: list[UFOControlItem]) -> dict:
    lines = [f"[{c.id}] {c.name or '(unnamed)'} — {c.control_type}{' (popup)' if c.is_popup else ''}"
             for c in items]
    controls = [c.model_dump() for c in items]
    text = "\n".join(lines)
    out = {
        "engine": "microsoft-ufo" if _STATE.get("engine_ufo") else "fallback",
        "window_title": title,
        "controls": controls,
        "listing": text,
        "token_estimate": max(1, len(text) // 4) if text else 0,
    }
    if not items:
        out["hint"] = ("No UI Automation controls exposed. This surface is likely a canvas/game/"
                       "custom-rendered UI — use ufo_click_norm on the 0-1000 grid instead.")
    return out


def _resolve(control_id: int) -> tuple[UFOControlItem, Any, Any]:
    with _LOCK:
        c = _ACTIVE_CONTROLS.get(control_id)
        el, app = _ACTIVE_ELEMENTS.get(control_id, (None, None))
    if c is None:
        raise HTTPException(404, f"Control {control_id} is not in the current control list "
                                 "(IDs are regenerated after every UI change). Call ufo_get_controls again.")
    r = c.rect
    if r[2] - r[0] <= 0 or r[3] - r[1] <= 0:
        raise HTTPException(409, f"Control {control_id} has no usable bounds; re-inspect.")
    return c, el, app


def _receiver(el, app):
    """UFO ControlReceiver bound to the real control (it focuses the CONTROL, not the window)."""
    ufo = _get_ufo()
    if ufo is None or el is None:
        return None
    return ufo[1](el, app)


def _ufo_error(result: Any) -> Optional[str]:
    return result if isinstance(result, str) and result.startswith("An error occurred") else None


def _after_action(extra: dict) -> dict:
    with _LOCK:                                        # IDs are now stale
        _ACTIVE_CONTROLS.clear()
        _ACTIVE_ELEMENTS.clear()
    time.sleep(POPUP_SETTLE_SEC)
    after = refresh_controls()
    popup = [ctl for ctl in after["controls"] if ctl["is_popup"]]
    return {
        "ok": True, **extra,
        "popup_opened": bool(popup),
        "popup_controls": popup,
        "window_title": after["window_title"],
        "controls": after["controls"],
        "listing": after["listing"],
        "token_estimate": after["token_estimate"],
        "note": "Control IDs were regenerated — use ONLY the IDs in this response.",
    }


def click_control(arg: ClickControlIn) -> dict:
    c, el, app = _resolve(arg.control_id)
    x, y = c.center
    rec = _receiver(el, app)
    via = "ufo.click_input"
    if rec is not None:
        res = rec.click_input({"button": "right" if arg.click_type == "right" else "left",
                               "double": arg.click_type == "double"})
        if _ufo_error(res):
            raise HTTPException(500, f"UFO click failed on control {c.id}: {res[:300]}")
    else:
        via = "verified_center"
        _do_click(x, y, arg.click_type)
    return _after_action({"clicked": {"id": c.id, "name": c.name, "control_type": c.control_type,
                                      "point": [x, y], "click_type": arg.click_type, "via": via}})


def type_into_control(arg: TypeIntoControlIn) -> dict:
    c, el, app = _resolve(arg.control_id)
    if c.control_type not in {"Edit", "ComboBox", "Document"}:
        raise HTTPException(409, f"Control {c.id} '{c.name}' is a {c.control_type}, not a text field.")
    rec = _receiver(el, app)
    if rec is not None:
        via = "ufo.set_edit_text"
        res = rec.set_edit_text({"text": arg.text, "clear_current_text": arg.clear_first})
        if _ufo_error(res):
            raise HTTPException(500, f"UFO typing failed on control {c.id}: {res[:300]}")
        if arg.submit:
            rec.keyboard_input({"keys": "{ENTER}", "control_focus": True})
    else:
        via = "verified_center_keyboard"
        gui = _get_gui()
        x, y = c.center
        gui.click(x=x, y=y)                             # focus THIS field, never the window
        if arg.clear_first:
            gui.hotkey("ctrl", "a")
            gui.press("backspace")
        gui.write(arg.text, interval=0.01)
        if arg.submit:
            gui.press("enter")
    return _after_action({"typed": {"id": c.id, "name": c.name, "text": arg.text,
                                    "clear_first": arg.clear_first, "submit": arg.submit, "via": via}})


def _send_keys(keys: str) -> None:
    try:
        from pywinauto import keyboard  # type: ignore
    except Exception as e:
        raise HTTPException(500, f"pywinauto keyboard unavailable: {e}")
    keyboard.send_keys(keys)


def keyboard_input(arg: KeyboardInputIn) -> dict:
    if arg.control_id is not None:
        c, el, app = _resolve(arg.control_id)
        rec = _receiver(el, app)
        if rec is None:
            raise HTTPException(501, "UFO keyboard input needs Windows UI Automation.")
        res = rec.keyboard_input({"keys": arg.keys, "control_focus": True})
        if _ufo_error(res):
            raise HTTPException(500, f"UFO keyboard input failed: {res[:300]}")
    else:
        _send_keys(arg.keys)                            # foreground window, e.g. "%c" (Alt+C)
    return _after_action({"keys": arg.keys, "control_id": arg.control_id})


def click_norm(arg: ClickNormIn) -> dict:
    w, h = _screen_size()
    x, y = norm_to_pixels(arg.norm_x, arg.norm_y, w, h)
    _do_click(x, y, arg.click_type)
    with _LOCK:
        _ACTIVE_CONTROLS.clear()
        _ACTIVE_ELEMENTS.clear()
    return {"ok": True, "point": [x, y], "screen": [w, h], "click_type": arg.click_type,
            "note": "Control IDs invalidated — call ufo_get_controls before using IDs again."}


# --------------------------------------------------------------------------- routes
@ufo_router.get("/controls")
def get_controls():
    return refresh_controls()


@ufo_router.post("/controls")
def post_controls():
    return refresh_controls()


@ufo_router.post("/click_control")
def route_click_control(arg: ClickControlIn):
    return click_control(arg)


@ufo_router.post("/click_norm")
def route_click_norm(arg: ClickNormIn):
    return click_norm(arg)


# /tool/* aliases so the NEXUS web tool layer (POST /tool/<name>) reaches the same logic.
@ufo_tool_router.post("/ufo_get_controls")
def tool_get_controls():
    return refresh_controls()


@ufo_tool_router.post("/ufo_click_control")
def tool_click_control(arg: ClickControlIn):
    return click_control(arg)


@ufo_tool_router.post("/ufo_click_norm")
def tool_click_norm(arg: ClickNormIn):
    return click_norm(arg)


@ufo_router.post("/type_into_control")
def route_type_into_control(arg: TypeIntoControlIn):
    return type_into_control(arg)


@ufo_router.post("/keyboard_input")
def route_keyboard_input(arg: KeyboardInputIn):
    return keyboard_input(arg)


@ufo_tool_router.post("/ufo_type_into_control")
def tool_type_into_control(arg: TypeIntoControlIn):
    return type_into_control(arg)


@ufo_tool_router.post("/ufo_keyboard_input")
def tool_keyboard_input(arg: KeyboardInputIn):
    return keyboard_input(arg)
