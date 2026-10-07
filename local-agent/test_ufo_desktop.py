"""UFO desktop control tests. Mock-only — no real mouse, keyboard or windows.

Run:  pip install fastapi httpx pytest && python -m pytest -q test_ufo_desktop.py
"""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import nexus_agent as na
import ufo_desktop as ufo


class Rect(SimpleNamespace):
    pass


class El:
    def __init__(self, ctype, name="", rect=(0, 0, 0, 0), cls="", children=(), visible=True,
                 enabled=True, handle=None, active=False):
        self.element_info = SimpleNamespace(control_type=ctype, name=name, class_name=cls,
                                            handle=handle, automation_id="")
        self._rect = rect
        self._children = list(children)
        self._visible, self._enabled, self._active = visible, enabled, active
        self.actions = []
        self.text_value = ""

    def rectangle(self):
        l, t, r, b = self._rect
        return Rect(left=l, top=t, right=r, bottom=b)

    def descendants(self):
        out = []
        for c in self._children:
            out.append(c)
            out.extend(c.descendants())
        return out

    def is_visible(self): return self._visible
    def is_enabled(self): return self._enabled
    def is_active(self): return self._active
    def has_keyboard_focus(self): return False
    def window_text(self): return self.element_info.name
    def click_input(self, **kwargs): self.actions.append(("click_input", kwargs))
    def set_edit_text(self, text): self.text_value = text; self.actions.append(("set_edit_text", text))
    def type_keys(self, keys, **kwargs): self.actions.append(("type_keys", keys))


class FakeUfoStrategy:
    def __init__(self, windows): self.windows = windows
    def get_desktop_windows(self, remove_empty=False): return self.windows
    def find_control_elements_in_descendants(self, root, **kwargs): return root.descendants()


class FakeUfoFacade:
    def __init__(self, windows): self.backend_strategy = FakeUfoStrategy(windows)
    def get_desktop_windows(self, remove_empty=False):
        return self.backend_strategy.get_desktop_windows(remove_empty)


class FakeUfoReceiver:
    """Exercise the UFO adapter boundary without importing Windows UIA or sending input."""
    def __init__(self, control, application): self.control, self.application = control, application
    def atomic_execution(self, method_name, params):
        return getattr(self.control, method_name)(**params)
    def set_edit_text(self, params):
        self.control.set_edit_text(params["text"])
        return "text set"
    def keyboard_input(self, params):
        if self.control is not None:
            self.control.type_keys(params["keys"])
        elif self.application is not None:
            self.application.actions.append(("keyboard_input", params["keys"]))
        return params["keys"]


class FakeDesktop:
    def __init__(self, windows): self._w = windows
    def windows(self): return self._w


class FakeGui:
    def __init__(self, size=(1920, 1080)):
        self.calls = []
        self._size = size
    def size(self): return self._size
    def click(self, x, y): self.calls.append(("single", x, y))
    def doubleClick(self, x, y): self.calls.append(("double", x, y))
    def rightClick(self, x, y): self.calls.append(("right", x, y))


def win32_app(handle=100):
    """Win32-style tree: menu bar items + buttons inside panes."""
    return El("Window", "PuTTY Configuration", (0, 0, 800, 600), cls="PuTTYConfigBox", handle=handle, children=[
        El("Pane", "", (0, 0, 800, 600), children=[
            El("MenuBar", "", (0, 0, 800, 20), children=[
                El("MenuItem", "Connection", (0, 0, 100, 20)),
                El("MenuItem", "Options", (100, 0, 200, 20)),
                El("MenuItem", "Help", (200, 0, 300, 20)),
            ]),
            El("Group", "Basic options", (10, 30, 790, 500), children=[
                El("Edit", "Host Name", (20, 40, 400, 60)),
                El("Button", "Open", (600, 550, 700, 580)),
                El("Button", "Hidden", (0, 0, 10, 10), visible=False),
                El("Button", "Disabled", (0, 0, 10, 10), enabled=False),
                El("Button", "ZeroSize", (5, 5, 5, 5)),
                El("Text", "Label only", (20, 70, 200, 90)),
            ]),
        ]),
    ])


def wpf_app(handle=200):
    return El("Window", "WPF Settings", (0, 0, 1000, 700), cls="HwndWrapper[App]", handle=handle, children=[
        El("Custom", "", (0, 0, 1000, 700), children=[
            El("TabItem", "General", (0, 0, 100, 30)),
            El("TabItem", "Advanced", (100, 0, 200, 30)),
            El("CheckBox", "Start with Windows", (20, 50, 220, 70)),
            El("RadioButton", "Dark", (20, 80, 120, 100)),
            El("ComboBox", "Language", (20, 110, 220, 130)),
            El("Hyperlink", "Learn more", (20, 140, 120, 160)),
            El("ListItem", "Item A", (300, 50, 500, 70)),
            El("TreeItem", "Node", (300, 80, 500, 100)),
        ]),
    ])


def popup_menu():
    return El("Menu", "Connection", (0, 20, 150, 120), cls="#32768", children=[
        El("MenuItem", "Connect", (0, 20, 150, 40)),
        El("MenuItem", "Disconnect", (0, 40, 150, 60)),
    ])


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(na, "AGENT_TOKEN", "")
    monkeypatch.setattr(ufo.time, "sleep", lambda s: None)
    ufo._ACTIVE_CONTROLS.clear()
    ufo._ACTIVE_ELEMENTS.clear()
    ufo._ACTIVE_APP = None
    yield


@pytest.fixture
def gui(monkeypatch):
    g = FakeGui()
    monkeypatch.setattr(ufo, "_get_gui", lambda: g)
    return g


def use(monkeypatch, windows, fg):
    monkeypatch.setattr(ufo, "_get_desktop", lambda: FakeDesktop(windows))
    monkeypatch.setattr(ufo, "_foreground_handle", lambda: fg)


@pytest.fixture
def client():
    return TestClient(na.app)


# ---------------------------------------------------------------- extraction / filtering
def test_win32_extraction_filters_noise():
    ext = ufo.UFOControlExtractor(FakeDesktop([win32_app()]), (1920, 1080), 100)
    title, items = ext.extract()
    assert title == "PuTTY Configuration"
    assert [(c.name, c.control_type) for c in items] == [
        ("Connection", "MenuItem"), ("Options", "MenuItem"), ("Help", "MenuItem"),
        ("Host Name", "Edit"), ("Open", "Button"),
    ]
    assert items[0].rect == [0, 0, 100, 20]
    assert items[4].center == [650, 565]


def test_wpf_extraction_keeps_interactive_types():
    _, items = ufo.UFOControlExtractor(FakeDesktop([wpf_app()]), (1920, 1080), 200).extract()
    types = {c.control_type for c in items}
    assert types == {"TabItem", "CheckBox", "RadioButton", "ComboBox", "Hyperlink", "ListItem", "TreeItem"}
    assert not any(c.control_type in {"Window", "Pane", "Group", "Custom"} for c in items)


def test_foreground_window_chosen_over_others():
    _, items = ufo.UFOControlExtractor(FakeDesktop([wpf_app(), win32_app()]), (1920, 1080), 100).extract()
    assert items[0].name == "Connection"


# ---------------------------------------------------------------- popups
def test_popup_32768_is_prioritized():
    _, items = ufo.UFOControlExtractor(FakeDesktop([win32_app(), popup_menu()]), (1920, 1080), 100).extract()
    assert [c.name for c in items[:2]] == ["Connect", "Disconnect"]
    assert all(c.is_popup for c in items[:2])
    assert not any(c.is_popup for c in items[2:])


# ---------------------------------------------------------------- IDs / cache
def test_sequential_ids_and_cache(monkeypatch, gui, client):
    use(monkeypatch, [win32_app()], 100)
    data = client.get("/ufo/controls").json()
    assert [c["id"] for c in data["controls"]] == [1, 2, 3, 4, 5]
    assert data["window_title"] == "PuTTY Configuration"
    assert data["token_estimate"] > 0
    assert "[1] Connection — MenuItem" in data["listing"]
    assert set(ufo._ACTIVE_CONTROLS) == {1, 2, 3, 4, 5}
    assert ufo._ACTIVE_CONTROLS[2].center == [150, 10]
    assert client.post("/ufo/controls").json()["controls"] == data["controls"]


def test_tool_alias_and_health(monkeypatch, gui, client):
    use(monkeypatch, [win32_app()], 100)
    assert client.post("/tool/ufo_get_controls").json()["controls"][0]["name"] == "Connection"
    h = client.get("/health").json()
    assert h["agent_version"] == "2026.10.04"
    assert {"ufo_get_controls", "ufo_click_control", "ufo_click_norm"} <= set(h["tools"])
    assert "/ufo/click_control" in h["ufo"]


# ---------------------------------------------------------------- clicks
@pytest.mark.parametrize("ct", ["single", "double", "right"])
def test_click_types_use_verified_center(monkeypatch, gui, client, ct):
    use(monkeypatch, [win32_app()], 100)
    client.get("/ufo/controls")
    r = client.post("/ufo/click_control", json={"control_id": 5, "click_type": ct}).json()
    assert gui.calls == [(ct, 650, 565)]
    assert r["clicked"]["point"] == [650, 565]


def test_click_reveals_popup_and_regenerates_ids(monkeypatch, gui, client):
    windows = [win32_app()]
    use(monkeypatch, windows, 100)
    client.get("/ufo/controls")
    orig = gui.click
    def click(x, y):
        orig(x, y)
        windows.append(popup_menu())  # menu opens after the click
    gui.click = click
    r = client.post("/ufo/click_control", json={"control_id": 1}).json()
    assert r["popup_opened"] is True
    assert [c["name"] for c in r["popup_controls"]] == ["Connect", "Disconnect"]
    assert ufo._ACTIVE_CONTROLS[1].name == "Connect"


def test_unknown_id_never_guesses(monkeypatch, gui, client):
    use(monkeypatch, [win32_app()], 100)
    assert client.post("/ufo/click_control", json={"control_id": 3}).status_code == 404
    assert gui.calls == []


def test_vendored_ufo_receiver_clicks_actual_element(monkeypatch, gui, client):
    app = win32_app()
    use(monkeypatch, [app], 100)
    monkeypatch.setattr(ufo, "_get_ufo", lambda: (FakeUfoFacade([app]), FakeUfoReceiver))
    data = client.get("/ufo/controls").json()
    assert data["engine"] == "microsoft-ufo"
    result = client.post("/ufo/click_control", json={"control_id": 5}).json()
    button = next(el for el in app.descendants()
                  if el.element_info.control_type == "Button" and el.element_info.name == "Open")
    assert button.actions == [("click_input", {"button": "left", "double": False})]
    assert result["clicked"]["via"] == "ufo.click_input"
    assert gui.calls == []


def test_vendored_ufo_receiver_types_into_exact_edit(monkeypatch, gui, client):
    app = win32_app()
    edit = next(el for el in app.descendants()
                if el.element_info.control_type == "Edit" and el.element_info.name == "Host Name")
    use(monkeypatch, [app], 100)
    monkeypatch.setattr(ufo, "_get_ufo", lambda: (FakeUfoFacade([app]), FakeUfoReceiver))
    client.get("/ufo/controls")
    result = client.post("/ufo/type_into_control", json={
        "control_id": 4, "text": "192.168.1.8", "clear_first": True,
    }).json()
    assert edit.text_value == "192.168.1.8"
    assert edit.actions == [("set_edit_text", "192.168.1.8")]
    assert result["typed"]["via"] == "ufo.set_edit_text"
    assert gui.calls == []


# ---------------------------------------------------------------- normalized grid
@pytest.mark.parametrize("size,expect", [
    ((1920, 1080), {(0, 0): (0, 0), (500, 500): (960, 540), (1000, 1000): (1919, 1079)}),
    ((3840, 2160), {(0, 0): (0, 0), (500, 500): (1920, 1080), (1000, 1000): (3839, 2159)}),
])
def test_norm_mapping(monkeypatch, client, size, expect):
    g = FakeGui(size)
    monkeypatch.setattr(ufo, "_get_gui", lambda: g)
    for (nx, ny), (x, y) in expect.items():
        assert ufo.norm_to_pixels(nx, ny, *size) == (x, y)
        g.calls.clear()
        r = client.post("/ufo/click_norm", json={"norm_x": nx, "norm_y": ny, "click_type": "double"}).json()
        assert g.calls == [("double", x, y)] and r["point"] == [x, y]


def test_norm_bounds_validated(client, gui):
    assert client.post("/ufo/click_norm", json={"norm_x": 1001, "norm_y": 0}).status_code == 422
    assert gui.calls == []
