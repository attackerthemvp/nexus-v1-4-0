# Desktop Automation Overhaul — Fast, Reliable App Launching and Control

## Goal
Make NEXUS desktop control fast and stop the "stupid" failures (single-clicking desktop icons, clicking behind Chrome, typing into the wrong window, 10+ second screen reads). Opening an app becomes one reliable action that follows your search order. This is an upgrade to the existing PC-control implementation — everything NEXUS already does well (tool surface, policies, confirmations, phone passthrough) stays as-is; nothing is rebuilt.

## What you will notice
- "Open TLauncher" (or any app) works in one step, usually in under 2 seconds.
- NEXUS no longer clicks behind other windows or single-clicks desktop icons.
- Each "look at the screen" step drops from 5–15 seconds to well under a second.
- Clicks land where they should, even with Windows display scaling at 125% / 150%.

## 1. New `launch_app(name)` action — your search order
```text
launch_app("tlauncher")
  0. Already running? If a window/process matching the name exists and can be
     brought to the foreground -> SUCCESS (no new process is started)
  1. Search  %USERPROFILE%\OneDrive\Desktop            (.lnk, .exe, .url, .appref-ms)
  2. Search  %USERPROFILE%\OneDrive\Desktop\Others
  3. Windows search: press Win, type the name, wait for results,
     VALIDATE the highlighted result matches the requested name, then Enter
  -> confirm success via foreground window/process match, report which tier worked
```
- No hardcoded user paths: folders are resolved from `%USERPROFILE%` (with a OneDrive/Desktop fallback to `%USERPROFILE%\Desktop` if OneDrive is absent). Nothing user-specific is baked in.
- Name matching is forgiving: ignores case, spaces, dashes and ".lnk" ("tlauncher", "TLauncher", "t launcher" all match). Best match wins; ties are reported back instead of guessing.
- Files are opened the way a double-click would (Windows "open" on the shortcut), so shortcuts keep their start folder and arguments.
- Success = a matching window in the foreground, whether it was already running or just started. After launching, it waits up to ~8 seconds for the window and brings it to the front.
- Windows search is never blind: before pressing Enter it reads the search results (UIA) and only accepts a result whose name matches the request; otherwise it reports "not found" instead of launching the wrong thing.
- Both folders are configurable in Settings → Computer ("App search folders"), pre-filled with the two `%USERPROFILE%`-based defaults.
- Recent successful launches are remembered for the session so repeat opens are instant.

## 2. New `show_desktop` action — idempotent
- Win+D is a toggle, so it is never pressed blindly: first check whether the desktop is already visible (active window is the shell desktop / no app window in front). Only if an app window is in front, press Win+D; then confirm the desktop is in front. Calling it twice in a row is safe and changes nothing the second time.
- Used automatically before any desktop-icon interaction.

## 3. Click fixes
- `desktop_click` gains `double: true` and `button: "right"` options.
- Rule baked into NEXUS's instructions: desktop icons and files in Explorer are always double-clicked; buttons single-clicked.
- Before clicking/typing/hotkeys, the target window is brought to the front, and the action is refused with a clear message if focus could not be taken (no more typing into the void).
- Wrong-instance protection: windows are matched by exact title + process name + handle, not title substring alone. When several windows match (e.g. two Chrome windows), the action lists them and asks which one instead of picking arbitrarily.
- Mouse safety corner trip no longer crashes the action; it is caught and reported.

## 4. Speed: fast screen reading
- `desktop_read` default becomes "fast": screenshot + active window title/size + a shallow list of the active window's controls, with a time limit (~1.5s) so deep app trees can't freeze it.
- Text recognition (OCR) becomes opt-in (`ocr: true`) and only scans the active window, not the whole screen.
- Screenshots are downscaled and compressed before sending to the AI.
- Click-by-text uses the last read's results; on a miss it does one quick targeted re-scan, not two full scans.
- No stale reads: cached click targets are invalidated whenever the active window handle/title changes, after any click/type/hotkey/scroll action, and after a short freshness window (~10s). Before using a cached target, the agent re-verifies the control still exists at the cached position; if verification fails it does one targeted re-scan instead of clicking a stale coordinate.

## 5. Display scaling fix
- Agent marks itself DPI-aware at startup so screenshots and click coordinates use the same pixel grid; the scale factor is reported in `desktop_read` for transparency.

## 6. NEXUS instructions (web app)
- "To open an app, always use launch_app first. Never guess with shell commands."
- "Before interacting with desktop icons, call show_desktop. Double-click icons."
- "Prefer the screenshot to decide where to click; request OCR only when text is too small."

## 7. Tests (mock-only, no real mouse/keyboard)
- Launch order: Desktop hit, Others hit, falls through to Windows search; fuzzy matching and tie handling.
- Double-click flag produces two clicks; focus failure returns a clear error.
- `desktop_read` fast mode respects its time limit and skips OCR by default.
- Existing phone passthrough tests keep passing.

## Technical details
- Agent (`local-agent/nexus_agent.py`):
  - New routes `/tool/launch_app`, `/tool/show_desktop`; added to `/health` tool list.
  - Launch uses `os.startfile`; Windows-search tier uses pyautogui (`win`, typewrite, `enter`); window detection via pywinauto/pygetwindow diff of top-level windows before/after.
  - Folder list read from request args (`search_dirs`) with defaults to the two paths; `%USERPROFILE%` expansion supported.
  - `ctypes.windll.shcore.SetProcessDpiAwareness(2)` at startup (fallback `user32.SetProcessDPIAware`).
  - `_read_desktop_controls`: replace full `descendants()` with depth-limited walk + deadline; OCR limited to active window rect; `pyautogui.FAILSAFE` exceptions caught per action.
  - `_focus_window(title|handle)` helper used by click/type/hotkey/press/scroll.
  - New test file `local-agent/test_desktop_actions.py` with pyautogui/pywinauto/os.startfile mocked.
- Web app:
  - `src/lib/tool-policy.ts`: `launch_app` and `show_desktop` as "desktop" category; `show_desktop` repeat-safe. Confirmations stay risk-based exactly as today — ordinary desktop actions (including `launch_app`/`show_desktop`) require no confirmation; only the existing destructive/dangerous patterns do.
  - `src/routes/api/chat.ts`: tool schemas for `launch_app` (`name`), `show_desktop`, `desktop_click.double/button`, `desktop_read.ocr`; updated desktop system instructions.
  - `src/lib/settings-store.ts` + Settings → Computer: "App search folders" list, sent as `search_dirs`.
  - `src/lib/tool-policy.test.ts`: cases for the new tools.
- Delivery: after building, copy the updated `nexus_agent.py` to your PC and restart the agent (same as last time). New Python deps: none beyond existing pyautogui/pywinauto.
