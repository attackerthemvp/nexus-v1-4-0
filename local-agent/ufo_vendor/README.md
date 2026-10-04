# Vendored Microsoft UFO (MIT)

Source: https://github.com/microsoft/UFO @ a795552d976c4c019d7c2f778a0effb5cef7de6b
License: see LICENSE (Copyright (c) Microsoft Corporation, MIT).

Copied verbatim (unmodified):
- ufo/automator/basic.py
- ufo/automator/puppeteer.py
- ufo/automator/app_apis/basic.py
- ufo/automator/ui_control/inspector.py  (ControlInspectorFacade, UIA cached FindAll, condition filtering)
- ufo/automator/ui_control/controller.py (ControlReceiver: click_input, set_edit_text, keyboard_input, ...)

NEXUS-specific:
- `__init__.py` files are package markers only (upstream re-exports pull in screenshot/agent
  modules NEXUS does not use).
- `config/config_loader.py` is a small shim providing the `ufo_config.system.*` input settings.

Windows dependencies: pywinauto, uiautomation, comtypes, pywin32, psutil, pyautogui.
Used by local-agent/ufo_desktop.py. Do not edit the verbatim files; update by re-copying upstream.
