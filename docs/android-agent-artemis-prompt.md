# Prompt for an AI: update the NEXUS Android Agent app for Artemis (zero ADB)

You are editing the **NEXUS Android Agent** Android app (Java, minSdk 27 / Android 8.1). The app already connects to the user's PC "NEXUS local agent" over their Tailscale tailnet with a token, receives commands, and returns results. Your job: add the capabilities the Artemis phone engine needs. **Never use ADB, adb shell, port forwarding, debug ports or ADB-delivered tokens — anywhere, including tests and setup.**

## 1. Find the existing pieces first
- Find the class that receives commands from the PC agent (search for the command names it already supports, e.g. `open_app`, `home`, `back`, `ping`). This is the *command handler*.
- Find where the app builds its **capability list** (the list returned in status/registration). Every new command must be added there, and only when it is actually available at runtime (e.g. screenshot only when MediaProjection permission is active).
- Find the Accessibility Service (or create `NexusAccessibilityService`).

## 2. Result envelope (every command)
Return JSON: `{ "ok": bool, "code": "OK|INVALID_ARGS|TARGET_NOT_FOUND|DEVICE_ERROR|PACKAGE_NOT_FOUND|TIMEOUT|UNSUPPORTED", "message": "...", ...extra }`. Unknown/unavailable command → `ok:false, code:"UNSUPPORTED"`.

## 3. Coordinates
All coordinates are **normalized 0–1000** on both axes (x = px / width × 1000). Convert to pixels using the current real display size (account for rotation).

## 4. Capabilities to add (exact names and arguments)
| Command | Args | Implementation | Parity |
|---|---|---|---|
| `snapshot` | – | Latest MediaProjection frame + UI hierarchy XML together. Return `screenshot_b64` (JPEG, max side ~1080), `screenshot_mime`, `xml`, `width`, `height`, `foreground_package`, `ts`, `skew_ms` (frame vs tree time). | full (needs capture permission) |
| `take_screenshot` | – | MediaProjection frame only (`screenshot_b64`, `width`, `height`). | full (needs permission) |
| `get_ui_hierarchy` (alias `dump_ui`) | – | Traverse `getRootInActiveWindow()`; emit XML `<hierarchy><node index text resource-id class package content-desc checkable checked clickable enabled focusable focused scrollable long-clickable password selected bounds="[l,t][r,b]">…</node></hierarchy>` (same fields as Android's uiautomator dump). Include `width`,`height`,`foreground_package`. | full |
| `click` | `target:[x,y]` | `dispatchGesture` tap (50 ms stroke). | full |
| `click_sequence` | `sequence:[[x,y],…]`, `delay_ms` (default 300) | Taps in order, waiting `delay_ms` between, each awaited via GestureResultCallback. Stop and report index on first failure. **Required** by Flash mode. | full |
| `long_press` | `target:[x,y]`, `duration_ms` (default 1000) | dispatchGesture single long stroke. | full |
| `swipe` | `direction` (up/down/left/right) or `start:[x,y]`,`end:[x,y]`, `duration_ms` | dispatchGesture path. | full |
| `input_text` | `text`, optional `target:[x,y]`, `clear` | Tap target if given, find focused editable node, `ACTION_SET_TEXT` (append unless clear). | full |
| `focus_and_clear_text` | `target:[x,y]` | Tap, then `ACTION_SET_TEXT` with "". | full |
| `erase_one_char` | – | Focused node: set text minus last char. | full |
| `press_key` | `key`: enter/back/home/app_switch | back/home/app_switch → `performGlobalAction`; enter → `ACTION_IME_ENTER` (API 30+) else click the IME action / focused node's submit; else UNSUPPORTED. Arbitrary keycodes: UNSUPPORTED. | degraded for ENTER on API<30 |
| `manage_app` | `action`: launch/stop, `app_name` (label or package) | launch: resolve label→package via PackageManager (with `<queries>` for launcher intents), `getLaunchIntentForPackage`. stop: **cannot force-stop** without system rights → go Home and report `message:"degraded: dismissed to home"`. | launch full, stop degraded |
| `open_link` | `url` | `ACTION_VIEW` intent, FLAG_ACTIVITY_NEW_TASK. | full |
| `wait_for_text` | `text`, `timeout_ms` (default 10000) | Poll hierarchy every 300 ms; OK when found, else TIMEOUT. | full |
| `clipboard` | `action` get/set, `text` | ClipboardManager (get only while app has focus on Android 10+; else UNSUPPORTED). | degraded |

Keep existing commands (`open_app`, `home`, `back`, `recents`, …) working.

## 5. Screenshots on Android 8.1 (API 27)
Do **not** use `AccessibilityService.takeScreenshot()` (API 30). Implement `ScreenCaptureService`:
- One-time consent via `MediaProjectionManager.createScreenCaptureIntent()` from a visible activity button "Allow screen capture".
- Foreground service with persistent notification (`FOREGROUND_SERVICE`; on API 29+ `foregroundServiceType="mediaProjection"`).
- `ImageReader` (RGBA_8888) + `VirtualDisplay`; keep the latest frame with timestamp; recreate on rotation/size change; handle row padding.
- `MediaProjection.Callback.onStop` → mark capture unavailable, remove `snapshot`/`take_screenshot` from the capability list, and return `UNSUPPORTED` with message "screen capture permission not granted" until the user re-grants. Never fall back to anything else.

## 6. Setup (in-app, no ADB)
- `accessibility_service_config.xml`: `canPerformGestures="true"`, `canRetrieveWindowContent="true"`, `accessibilityFlags="flagReportViewIds|flagRetrieveInteractiveWindows|flagIncludeNotImportantViews"`.
- Manifest: `FOREGROUND_SERVICE`, `INTERNET`, `<queries><intent><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent></queries>`.
- Setup screen shows: Accessibility enabled? Screen capture granted? Connected to PC? with buttons to open each setting; OEM battery-optimisation guidance ("Don't optimise" / autostart).

## 7. Transport
Keep the existing authenticated tailnet connection to the PC agent. No new ports. New commands just plug into the existing handler and capability list.

## 8. Acceptance checklist (use app UI tests / mocks only, never ADB)
- [ ] Every command above returns the envelope; unknown → UNSUPPORTED.
- [ ] `click_sequence` executes in order and reports the failing index.
- [ ] `snapshot` returns image + XML with `skew_ms`; after revoking capture it returns UNSUPPORTED and the capability disappears.
- [ ] `manage_app stop` reports degraded, never claims force-stop.
- [ ] `press_key` with an arbitrary keycode → UNSUPPORTED.
- [ ] Capability list reflects runtime availability.
- [ ] No ADB references in code, docs, setup or tests.
