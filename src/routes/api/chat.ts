import { createFileRoute } from "@tanstack/react-router";

import { NEXUS_PERSONA } from "@/lib/ai/persona";
import { routeChat } from "@/lib/ai/router";
import { mergeSettings } from "@/lib/settings-store";
import { isToolAllowedBySettings } from "@/lib/tool-policy";
import { ANDROID_INTENT_RULES } from "@/lib/android-apps";


const SYSTEM_PROMPT = `${NEXUS_PERSONA}
# OPERATIONS MANUAL (how you work — the persona above always wins on identity and tone)

You have access to tools that let you control the user's computer through a local helper agent. NEVER fabricate tool results — only state outcomes after a tool returns.

## AUTONOMOUS EXECUTION CONTRACT
- For actionable tasks, continue working without waiting for encouragement. Progress narration is not completion.
- For coding repairs, follow inspect → reproduce → diagnose → modify → automated tests → manual/end-to-end verification → final report when the user requests those stages.
- Never claim a command, test, build, or verification passed unless a tool result proves it.
- Respect every filesystem boundary stated by the user. Never inspect, copy, create, or modify files outside the authorized path.
- After using any operational tool, you MUST finish the run with exactly one control tool:
  - finish_task(report): only after the requested work and verification are complete. Put the full user-facing final report in report.
  - request_user_input(question, reason): only when a destructive action needs approval, a credential is unavailable, or a decision cannot safely be inferred.
- Never end an operational run with future-tense prose such as "I will now...". Perform that step with a tool instead.
- Investigate tool errors and failed tests. Do not treat them as completion.

## SYSTEM TOOLS
- run_command(command, cwd?, timeout_sec?): Shell command. Use for installs, launching apps, scripts. Pass timeout_sec 300+ for installs, builds and test suites.
- open_path(path), open_url(url), list_dir(path), search_files(root, query), read_file(path, start_line?, end_line?, line_numbers?), write_file(path, content), system_info().

## CODING MODE 👨‍💻 — YOU ARE A REAL SOFTWARE ENGINEER ON THIS MACHINE
You can read, search, patch, build, test, run and commit real code on the user's computer. Work like a careful engineer, not a snippet generator.
- project_tree(root, depth?): map an unfamiliar project first.
- grep(root, pattern, glob?): search file CONTENTS for symbols, imports, error strings. search_files only matches file NAMES.
- read_file(path, start_line?, end_line?, line_numbers?): read the exact region before editing. NEVER patch a file you have not read in this run.
- apply_patch(path, edits[]): the DEFAULT way to change existing code. Each edit is exact search/replace; 'find' must be copied verbatim from the file (indentation included) with enough surrounding context to be unique. If the match count is wrong nothing is written — re-read and retry with more context. Every patch returns a unified diff and a backup path.
- write_file: only for brand-new files or a full intentional rewrite.
- restore_backup(backup) / list_backups(): undo a bad edit.
- run_command / run_command_bg + command_status: build, install, run test suites, start dev servers, then poll their output.
- git_status, git_diff, git_branch, git_commit, git_push (push only if the user enabled it).

CODING LOOP (follow it, do not skip steps):
1. Locate: project_tree / grep / read_file until you understand the actual code — never guess an API, path, or symbol.
2. Reproduce: run the build, test, or command that shows the problem.
3. Change: apply_patch with minimal, surgical edits. One concern per patch.
4. Verify: re-run the build/tests/command. Read the real output.
5. If it fails: read the error, investigate, fix, re-verify. Failing output is never completion.
6. Report: finish_task with what changed, the diffs/files touched, the exact commands run, their results, and anything still unverified.
Rules: stay strictly inside the authorised workspace; never invent test results; never claim "should work" — prove it with a tool result; keep the user's code style and don't reformat unrelated lines.


## DESKTOP COWORK MODE 🖥️ — YOU CAN SEE THE SCREEN
You are NOT a blind text agent. desktop_read and desktop_screenshot return an actual screenshot of the user's screen as an image you can SEE. Use your vision to identify ANY element — buttons drawn on canvases, game launchers (TLauncher, Steam), installers, custom-rendered UIs — and click them by x/y coordinates. Never say "I cannot see your screen" or "I cannot interact with desktop apps". You can. Use these tools.
- launch_app(name): THE way to open any app. It checks if the app is already running (and brings it forward), searches the user's Desktop and its "Others" folder for shortcuts, then falls back to validated Windows search. NEVER use run_command to start apps (most are not on PATH) and NEVER hunt for desktop icons visually when launch_app can do it.
- show_desktop(): Minimizes all windows so the desktop icons are reachable. Idempotent — safe to call even if the desktop is already showing. Call it BEFORE interacting with desktop icons.
- ufo_get_controls(): INSPECT FIRST. Uses Microsoft's actual UFO UIA inspector on Windows (cached control tree, enabled/visible filtering) to list interactive controls by fresh numbered IDs. Open popups/menus are listed first.
- ufo_click_control(control_id, click_type?): PREFERRED way to click — calls Microsoft's UFO ControlReceiver on the actual UIA element. The response contains newly revealed popup controls with NEW IDs. NEVER reuse IDs from an earlier list; IDs are regenerated after every action.
- ufo_type_into_control(control_id, text, clear_first?, submit?): Use for text fields. Calls Microsoft's UFO set_edit_text on the exact field; clear_first defaults true. Do not substitute desktop_type after selecting a control because it can steal child focus.
- ufo_keyboard_input(keys, control_id?): Use Microsoft's UFO keyboard_input for accelerator shortcuts such as "{VK_MENU}c" (Alt+C). Without control_id it targets the currently inspected app window.
- ufo_click_norm(norm_x, norm_y, click_type?): FALLBACK ONLY when ufo_get_controls returns no usable controls (game launchers, canvases, custom-rendered UI). 0-1000 grid read off the screenshot. Never bypass an available control ID with this or with raw x/y.
- desktop_read(ocr?): Returns screen size, mouse position, active window, UI Automation controls, AND a screenshot of the screen attached as an image. ALWAYS call before desktop clicks. LOOK at the image, then act. OCR is OFF by default (slow) — pass ocr=true only when the text you need is too small or missing from controls.
- desktop_screenshot(): Just a fresh screenshot when you need to re-check after an action.
- desktop_click(x?, y?, text?, nth?, button?, clicks?, double?, window?): Click by EXACT x/y pixel coordinates (preferred when you can see the target visually) OR by visible control text. For game launchers and custom canvases, ALWAYS use x/y read off the screenshot. Use double=true for DESKTOP ICONS, shortcuts and files in Explorer — a single click only selects them, it does NOT open them. Use window="title" to bring the right window to the front first when several windows are involved.
- desktop_type(text, submit?, window?): Type/paste text into the focused field. submit=true presses Enter.
- desktop_hotkey(keys, window?): Combos like ["ctrl","l"], ["alt","f4"], ["win","r"].
- desktop_press(key, window?): Single key — Enter, Tab, Escape, Space, ArrowDown.
- desktop_scroll(amount, window?): Scroll the active window; negative scrolls down.
- list_windows(): Every open app window (title + process) and which one is active. Use it to see what is open before closing/arranging.
- close_app(name, force?): Close an app's windows politely. If it reports still_open (e.g. an unsaved-changes prompt), look at the screen and tell the user; only use force=true when the user wants it killed.
- window_action(action, name?): maximize | minimize | restore | snap_left | snap_right | focus. Without name it acts on the active window.
- set_volume(level?, mute?): Set PC volume 0-100 and/or mute/unmute.
- media_control(action): play_pause | next | previous | stop | mute — controls whatever is playing (Spotify, YouTube, VLC).
- open_folder(target): Open a folder in File Explorer — aliases downloads, documents, desktop, others, pictures, music, videos, home — or any path.

Workflow (UFO grounding): launch_app(name) → ufo_get_controls → ufo_click_control(id) → use the fresh IDs it returns → repeat; fall back to desktop_read + ufo_click_norm only when no controls are exposed. Legacy workflow: launch_app(name) → desktop_read → LOOK at the screenshot → desktop_click(x, y) on what you see → desktop_read again to confirm. The screenshot uses the same coordinate system as the "screen" field — full pixel coords, top-left origin. Desktop icons and files ALWAYS need double=true (or click then Enter). If a click or keypress must land in a specific window, pass window= so the agent focuses it first instead of acting on whatever happens to be in front.

## NATIVE INTERNET 🌐 (PREFERRED for any web information)
You have built-in internet access that runs on the NEXUS server — no local browser, no local agent required. It also works when the local agent is OFFLINE.
- web_search(query, limit?): live web search returning titles, URLs and snippets.
- web_fetch(url, max_chars?): fetch a page and read its text.
Workflow: web_search → pick the best 1-3 URLs → web_fetch each → answer with the facts and cite the URLs.
NEVER open a browser window on the user's PC just to look something up. Use browser cowork mode ONLY when the task requires interacting with a real logged-in site (clicking, forms, accounts) or the user explicitly asks to see it on their screen.

## BROWSER COWORK MODE 🖱️

You can drive a real Chrome window alongside the user through the local Selenium agent. They see your moves via a glowing red assistant cursor overlaid on the page. They use the same window with their normal cursor — you cowork.
- browser_open(): Launch the cowork window (does this once on first use).
- browser_goto(url): Navigate.
- browser_read(): Returns { url, title, text, results, controls }. 'results' is an enumerated list of search-result links (index, title, href, selector) — perfect for SERPs. 'controls' lists every visible interactive element with a robust CSS selector. ALWAYS call this before clicking/typing on a fresh page.
- browser_click(selector?, text?, nth?): Click an element. STRONGLY prefer the 'selector' field returned by browser_read. To open the Nth search result, use the selector from results[N] (or pass text + nth=N). 'nth' is 0-based and selects among multiple matches.
- browser_type(selector, text, submit?): Focus & type into an input. Set submit=true to press Enter after.
- browser_press(key): Press a single key (Enter, Tab, Escape, etc.).
- browser_scroll(dy): Scroll by pixels (positive = down).
- browser_close(): Close the cowork window.

Workflow for browser tasks: open → goto → read → click/type → read again → repeat. To open the 2nd or 3rd search result, read the page, then call browser_click with the selector from results[1] or results[2] (NOT just by visible text — duplicate text on SERPs causes wrong clicks). Be patient, narrate briefly what you're doing.

## ESP / IoT PROJECTS 🔌 (generic, schema-driven)
The user builds ESP8266/ESP32 projects. You control them WITHOUT any code changes.
- esp_list_projects(): ALWAYS call this first when the user mentions any device/project/sensor. It returns every registered project with its devices, command ids, HTTP methods, endpoints and parameter specs. This is your ONLY source of truth for ESP capabilities.
- esp_register_project(project): When the user describes a new project in natural language, extract name, host (IP/hostname), devices, commands, HTTP methods, endpoints, parameters (type/min/max) and register it. Ask the user for anything critical that is missing (IP address, method, endpoint) — never invent it. Path parameters use {braces} in the endpoint; JSON bodies use a body template like {"speed": "{speed}"}. Confirm what was registered afterwards.
- esp_get_project(project_id), esp_status(project_id), esp_delete_project(project_id).
- device_command(project_id, device_id, command_id, parameters): The single way to actuate hardware. The local agent looks up the saved definition and performs the HTTP request on the LAN.
RULES: never invent endpoints, hosts or commands that are not registered — if something is missing, ask. Ask for confirmation before commands marked confirm:true or anything clearly destructive. Never print stored credentials.

## ANDROID PHONE CONTROL 📱
Real chain: you → NEXUS PC Agent (local agent) → NEXUS Android Agent app on the phone → the device.
The NEXUS Android Agent is the ONLY Android path. There is no ADB anywhere in NEXUS.

PRIMARY — NEXUS Android Agent (phone_* tools):
- phone_agent_status(): which phones are registered, their model/Android version/capabilities, whether they are online ("connected"), and the queue depth. Use this to answer "is my Android connected/what's its status".
- phone_ping(): liveness round-trip to the phone itself. Use for "ping my phone".
- phone_info(): model / manufacturer / Android release / SDK / ABIs reported BY THE PHONE APP. Use for "info about my Android device".
- phone_agent_command(command, args?, timeout_sec?): runs ONE capability from the phone app's allow-list. There is no shell on the phone. Get the exact capability names from phone_agent_status().agents[].capabilities first — never invent one. Unknown command → 400 unsupported_command; no phone → 503; phone silent → 504.

ROUTING RULES (follow exactly):
1. Multi-step phone tasks (open an app AND do something, message someone, navigate, fill in, tap through screens) → call phone_task(goal). It hands the goal to the Artemis engine, which plans, observes, acts, validates and verifies on the phone using the user's selected Flash/Pro mode. Never pick or mention a mode yourself. Report its final outcome (done / stuck / needs_user / stopped) honestly.
2. Simple status questions ("is my phone connected", "ping my phone", "phone info") → phone_agent_status / phone_ping / phone_info.
3. Report the VERIFIED state from tool output. Never claim a phone action succeeded without a tool result.
4. On an error, keep the real detail (503 not connected / 504 no answer / 400 unsupported_command) and explain it in one line, with the concrete fix (open the NEXUS Android Agent app, point it at the PC's Tailscale address + token, press Start).

${ANDROID_INTENT_RULES}

## PERMANENT MEMORY 🧠
You have a permanent memory that is shared across ALL chats (separate from this conversation's history). Relevant memories are injected below as MEMORY CONTEXT when they apply.
- remember_fact(text, category): Save a durable, useful fact — preferences, projects, devices, important facts, standing instructions. Be CONSERVATIVE: never save one-off questions, temporary commands, or ordinary chit-chat. NEVER save passwords, API keys, tokens or any credential (the tool refuses them).
- forget_fact(query): Remove memories matching a description when the user says "forget ...".
- recall_memories(query?): Look up what you remember, e.g. when asked "what do you remember about me?".
Only confirm a save once the tool returns success, and mention it briefly — don't keep announcing it.

Style: concise, markdown code blocks for commands, confirm destructive actions — always in the NEXUS voice defined at the top.`;

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { messages, memories, ai, coding, settings } = (await request.json()) as {
            messages: any[];
            memories?: string[];
            /** Coding workspace context from NEXUS Settings → Coding. */
            coding?: {
              enabled: boolean;
              workspaceRoot: string;
              activeProject: string;
              mode: "autonomous" | "confirm";
              commandTimeoutSec: number;
              gitEnabled: boolean;
              allowPush: boolean;
            };
            /** Routing preferences from NEXUS Settings → AI & Models (never secrets). */

            ai?: {
              autoRouting?: boolean;
              providerId?: string;
              modelId?: string;
              failover?: boolean;
              maxAttempts?: number;
            };
            /** Permission settings, re-validated here instead of trusted client-side only. */
            settings?: unknown;
          };

          // Untrusted input merged onto defaults, so a missing/partial payload
          // still yields a complete, valid policy object.
          const policySettings = mergeSettings(
            settings ?? (coding ? { coding } : undefined),
          );

          const tools = [

            {
              type: "function",
              function: {
                name: "run_command",
                description: "Execute a shell command on the user's local machine. Use for installing apps, running CLIs, system tasks.",
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "string", description: "The shell command to execute" },
                    cwd: { type: "string", description: "Optional working directory" },
                    timeout_sec: { type: "number", description: "Seconds to wait (1-900). Use 300+ for installs, builds and test suites." },
                  },
                  required: ["command"],

                },
              },
            },
            {
              type: "function",
              function: {
                name: "finish_task",
                description: "Finish an operational run only after all requested work and verification are complete. The report is shown directly to the user.",
                parameters: {
                  type: "object",
                  properties: {
                    report: { type: "string", description: "Complete final report with changes, tests, results, verification, and any honest limitations" },
                  },
                  required: ["report"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "request_user_input",
                description: "Pause only for a genuine blocker that cannot be resolved autonomously, such as destructive confirmation, unavailable credentials, or an ambiguous consequential choice.",
                parameters: {
                  type: "object",
                  properties: {
                    question: { type: "string", description: "The single specific question the user must answer" },
                    reason: { type: "string", description: "Why work cannot continue safely without the answer" },
                  },
                  required: ["question", "reason"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "open_path",
                description: "Open a file, folder, or application using the OS default handler.",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "open_url",
                description: "Open a URL in the default browser.",
                parameters: {
                  type: "object",
                  properties: { url: { type: "string" } },
                  required: ["url"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "list_dir",
                description: "List files in a directory.",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "search_files",
                description: "Recursively search for files by name pattern.",
                parameters: {
                  type: "object",
                  properties: {
                    root: { type: "string" },
                    query: { type: "string" },
                  },
                  required: ["root", "query"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "read_file",
                description: "Read a text file. Use start_line/end_line to window large files and line_numbers=true when planning a patch.",
                parameters: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    start_line: { type: "number" },
                    end_line: { type: "number" },
                    line_numbers: { type: "boolean" },
                  },
                  required: ["path"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "write_file",
                description: "Write or overwrite a whole text file. Prefer apply_patch for edits to existing files.",
                parameters: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["path", "content"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "apply_patch",
                description: "Surgically edit a file with exact search/replace edits. Each edit must match exactly the expected number of times or NOTHING is written. Returns a unified diff and a backup path.",
                parameters: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    create_if_missing: { type: "boolean" },
                    edits: {
                      type: "array",
                      description: "Ordered edits. 'find' must be verbatim text from the file including indentation, with enough context to be unique.",
                      items: {
                        type: "object",
                        properties: {
                          find: { type: "string" },
                          replace: { type: "string" },
                          expected_count: { type: "number", description: "How many matches to replace (default 1)" },
                        },
                        required: ["find", "replace"],
                      },
                    },
                  },
                  required: ["path", "edits"],
                },
              },
            },
            { type: "function", function: { name: "grep", description: "Search file CONTENTS across a project (regex by default). Use this to locate symbols, imports and error strings before editing.", parameters: { type: "object", properties: { root: { type: "string" }, pattern: { type: "string" }, glob: { type: "string", description: "Optional filename glob, e.g. *.tsx" }, regex: { type: "boolean" }, ignore_case: { type: "boolean" }, max_results: { type: "number" } }, required: ["root", "pattern"] } } },
            { type: "function", function: { name: "project_tree", description: "Show a project's folder structure (build/vendor folders skipped). Call this first when opening an unfamiliar codebase.", parameters: { type: "object", properties: { root: { type: "string" }, depth: { type: "number" }, max_entries: { type: "number" } }, required: ["root"] } } },
            { type: "function", function: { name: "run_command_bg", description: "Start a long-running process (dev server, watcher) in the background and get a job_id.", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } } },
            { type: "function", function: { name: "command_status", description: "Poll a background job's output; set stop=true to terminate it.", parameters: { type: "object", properties: { job_id: { type: "string" }, stop: { type: "boolean" } }, required: ["job_id"] } } },
            { type: "function", function: { name: "list_backups", description: "List recent automatic backups NEXUS made before edits.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "restore_backup", description: "Undo an edit by restoring a backup path returned by apply_patch/write_file.", parameters: { type: "object", properties: { backup: { type: "string" } }, required: ["backup"] } } },
            { type: "function", function: { name: "git_status", description: "git status of a repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } } },
            { type: "function", function: { name: "git_diff", description: "git diff of a repo, optionally limited to paths.", parameters: { type: "object", properties: { repo: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["repo"] } } },
            { type: "function", function: { name: "git_branch", description: "Show the current branch, or switch/create one.", parameters: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" }, create: { type: "boolean" } }, required: ["repo"] } } },
            { type: "function", function: { name: "git_commit", description: "Stage and commit changes with a message.", parameters: { type: "object", properties: { repo: { type: "string" }, message: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["repo", "message"] } } },
            { type: "function", function: { name: "git_push", description: "Push commits to a remote (disabled unless the user enabled pushing).", parameters: { type: "object", properties: { repo: { type: "string" }, remote: { type: "string" }, branch: { type: "string" } }, required: ["repo"] } } },

            {
              type: "function",
              function: {
                name: "system_info",
                description: "Get OS, CPU, RAM, and disk info from the local machine.",
                parameters: { type: "object", properties: {} },
              },
            },
            { type: "function", function: { name: "launch_app", description: "Open an application reliably: focuses it if already running, else searches the user's Desktop and its 'Others' folder for the shortcut, else uses validated Windows search. ALWAYS use this to open apps — never run_command and never hunt for icons.", parameters: { type: "object", properties: { name: { type: "string", description: "App name, e.g. 'TLauncher', 'Steam'" }, search_dirs: { type: "array", items: { type: "string" }, description: "Optional extra folders to search for shortcuts" } }, required: ["name"] } } },
            { type: "function", function: { name: "list_windows", description: "List every open app window (title + process) and the active one.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "close_app", description: "Close an app's windows politely; force=true kills it if it will not close.", parameters: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" } }, required: ["name"] } } },
            { type: "function", function: { name: "window_action", description: "Maximize, minimize, restore, snap left/right or focus a window (active window when name is omitted).", parameters: { type: "object", properties: { action: { type: "string", enum: ["maximize", "minimize", "restore", "snap_left", "snap_right", "focus"] }, name: { type: "string" } }, required: ["action"] } } },
            { type: "function", function: { name: "set_volume", description: "Set the PC master volume (0-100) and/or mute/unmute.", parameters: { type: "object", properties: { level: { type: "number" }, mute: { type: "boolean" } } } } },
            { type: "function", function: { name: "media_control", description: "Control background media playback.", parameters: { type: "object", properties: { action: { type: "string", enum: ["play_pause", "next", "previous", "stop", "mute"] } }, required: ["action"] } } },
            { type: "function", function: { name: "open_folder", description: "Open a folder in File Explorer by alias (downloads, documents, desktop, others, pictures, music, videos, home) or path.", parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } } },
            { type: "function", function: { name: "ufo_get_controls", description: "Inspect the foreground window's UI Automation tree (plus any open popup/menu, listed first with is_popup=true). Returns compact numbered interactive controls like '[1] Connection — MenuItem' with verified bounds. Call this FIRST before clicking in an app.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "ufo_click_control", description: "Click the verified centre of a control ID from the LATEST ufo_get_controls/ufo_click_control result. Returns newly revealed popup controls and fresh IDs — never reuse older IDs.", parameters: { type: "object", properties: { control_id: { type: "integer", description: "ID from the latest control list" }, click_type: { type: "string", enum: ["single", "double", "right"] } }, required: ["control_id"] } } },
            { type: "function", function: { name: "ufo_click_norm", description: "FALLBACK ONLY for surfaces with no usable UI Automation controls (games, canvases, custom-rendered launchers): click on a 0-1000 normalized screen grid (0,0 top-left, 1000,1000 bottom-right).", parameters: { type: "object", properties: { norm_x: { type: "integer", minimum: 0, maximum: 1000 }, norm_y: { type: "integer", minimum: 0, maximum: 1000 }, click_type: { type: "string", enum: ["single", "double", "right"] } }, required: ["norm_x", "norm_y"] } } },
            { type: "function", function: { name: "show_desktop", description: "Minimize all windows so desktop icons are reachable. Idempotent — safe to call even if the desktop is already visible.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "desktop_read", description: "Inspect the active desktop screen. Returns screen size, mouse position, active window, UI controls, AND a screenshot image you can SEE. Always call before desktop clicks. Look at the image to find anything UIA misses (game buttons, custom canvases). OCR is off by default; pass ocr=true only when needed (slow).", parameters: { type: "object", properties: { ocr: { type: "boolean", description: "Enable OCR text extraction (slow, opt-in)" } } } } },
            { type: "function", function: { name: "desktop_screenshot", description: "Take a fresh screenshot of the screen — you receive it as a visible image. Use after an action to confirm the result.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "desktop_click", description: "Click in a desktop app by coordinates or by visible text from desktop_read. Prefer text for real controls; use x/y for visual/OCR targets. Use double=true for desktop icons, shortcuts and files (single click only selects them). Use window to focus a specific window first.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, nth: { type: "number", description: "0-based match index when multiple controls/text items match" }, button: { type: "string", description: "left, right, or middle" }, clicks: { type: "number" }, double: { type: "boolean", description: "Double-click — required for desktop icons and files" }, window: { type: "string", description: "Bring the window with this title to the front before clicking" } } } } },
            { type: "function", function: { name: "desktop_type", description: "Type or paste text into the focused desktop control. submit=true presses Enter after typing. Use window to focus a specific window first.", parameters: { type: "object", properties: { text: { type: "string" }, submit: { type: "boolean" }, window: { type: "string" } }, required: ["text"] } } },
            { type: "function", function: { name: "desktop_hotkey", description: "Press a desktop keyboard shortcut, e.g. ['ctrl','l'], ['alt','f4'], ['win','r']. Use window to focus a specific window first.", parameters: { type: "object", properties: { keys: { type: "array", items: { type: "string" } }, window: { type: "string" } }, required: ["keys"] } } },
            { type: "function", function: { name: "desktop_press", description: "Press one desktop key such as Enter, Tab, Escape, Space, ArrowDown. Use window to focus a specific window first.", parameters: { type: "object", properties: { key: { type: "string" }, window: { type: "string" } }, required: ["key"] } } },
            { type: "function", function: { name: "desktop_scroll", description: "Scroll the active desktop window; negative usually scrolls down, positive scrolls up. Use window to focus a specific window first.", parameters: { type: "object", properties: { amount: { type: "number" }, window: { type: "string" } } } } },
            { type: "function", function: { name: "esp_list_projects", description: "List every registered ESP/IoT project with its devices, commands, endpoints and parameter specs. Call before any device control so you never guess an endpoint.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "esp_get_project", description: "Get one registered ESP project definition (credentials redacted).", parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } } },
            { type: "function", function: { name: "esp_status", description: "Check whether a registered ESP project is reachable on the LAN.", parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } } },
            { type: "function", function: { name: "esp_delete_project", description: "Delete a registered ESP project.", parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } } },
            { type: "function", function: { name: "esp_register_project", description: "Register (or update) an ESP/IoT project from the user's natural-language description. Build the structured definition yourself; ask the user for missing critical details instead of guessing.", parameters: { type: "object", properties: { id: { type: "string", description: "optional slug; omit to derive from name" }, name: { type: "string" }, description: { type: "string" }, host: { type: "string", description: "IP address or hostname of the ESP" }, protocol: { type: "string", description: "http or https" }, port: { type: "number" }, timeout: { type: "number" }, auth: { type: "object", description: "optional { type: none|basic|bearer|header, username, password, token, header_name, header_value }" }, devices: { type: "array", description: "Devices/components. Each: { id, name, description, commands: [{ id, name, method, endpoint, parameters, body, headers, confirm }], sensors: [{ id, name, method, endpoint, unit }] }. Path params use {braces} in endpoint; JSON body templates use \"{param}\" placeholders.", items: { type: "object" } } }, required: ["name", "host", "devices"] } } },
            { type: "function", function: { name: "device_command", description: "Execute a registered command or read a registered sensor on an ESP project through the local agent. Only use project/device/command ids returned by esp_list_projects.", parameters: { type: "object", properties: { project_id: { type: "string" }, device_id: { type: "string" }, command_id: { type: "string" }, parameters: { type: "object", description: "Values for the command's registered parameters" } }, required: ["project_id", "device_id", "command_id"] } } },
            { type: "function", function: { name: "browser_open", description: "Launch the cowork Chrome window with the NEXUS red cursor overlay.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "browser_goto", description: "Navigate the cowork browser to a URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
            { type: "function", function: { name: "browser_read", description: "Read the current page: text + clickable controls with selectors. Call before clicking/typing.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "browser_click", description: "Click an element. Prefer 'selector' from browser_read.results[n].selector or controls[n].selector. Use 'text' + 'nth' (0-based) to pick the Nth match by visible text. For the 2nd/3rd search result, use results[1]/results[2] selector.", parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, nth: { type: "number", description: "0-based index when multiple elements match (default 0)" } } } } },
            { type: "function", function: { name: "browser_type", description: "Type into an input. submit=true presses Enter after.", parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["selector", "text"] } } },
            { type: "function", function: { name: "browser_press", description: "Press a single key (Enter, Tab, Escape, ArrowDown, etc.).", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } } },
            { type: "function", function: { name: "browser_scroll", description: "Scroll the page by dy pixels (positive = down).", parameters: { type: "object", properties: { dy: { type: "number" } } } } },
            { type: "function", function: { name: "remember_fact", description: "Save a durable, useful long-term fact to permanent cross-chat memory (preferences, projects, devices, important facts, standing instructions). Never use for credentials or temporary/one-off details.", parameters: { type: "object", properties: { text: { type: "string", description: "The fact, written as a concise standalone statement" }, category: { type: "string", description: "preference | project | device | fact | instruction" } }, required: ["text"] } } },
            { type: "function", function: { name: "forget_fact", description: "Delete memories from permanent memory matching a description.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
            { type: "function", function: { name: "recall_memories", description: "List or search permanent memories, e.g. when asked what you remember.", parameters: { type: "object", properties: { query: { type: "string" } } } } },
            { type: "function", function: { name: "browser_close", description: "Close the cowork browser window.", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "web_search", description: "Search the live internet natively (no local browser, works even when the local agent is offline). Returns titles, URLs and snippets.", parameters: { type: "object", properties: { query: { type: "string", description: "Search query" }, limit: { type: "number", description: "Number of results (1-15, default 6)" } }, required: ["query"] } } },
            { type: "function", function: { name: "web_fetch", description: "Fetch a URL natively and return its readable text content. Use after web_search to read a page.", parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "number", description: "Max characters of text to return (default 12000)" } }, required: ["url"] } } },
            
            // Android Tools

            // NEXUS Android Agent (on-device app, via the PC Agent over Tailscale).
            // PRIMARY Android path — no ADB, no USB.
            {
              type: "function",
              function: {
                name: "phone_task",
                description: "Run a multi-step task on the user's Android phone with the Artemis engine (plan, observe, act, validate, check). The user's manually selected Flash/Pro mode is applied automatically. Returns 'done|stuck|needs_user|stopped: summary'.",
                parameters: { type: "object", properties: { goal: { type: "string", description: "The user's goal, unchanged, in their words" } }, required: ["goal"] },
              },
            },
            {
              type: "function",
              function: {
                name: "phone_agent_status",
                description: "PRIMARY Android status check. Reports every NEXUS Android Agent registered with the PC Agent: online flag, device model, Android release/SDK, app version, its capability allow-list, seconds since last seen, and queued command count. Use this (never ADB) to determine whether an Android device is connected and what it can do.",
                parameters: { type: "object", properties: {} }
              }
            },
            {
              type: "function",
              function: {
                name: "phone_ping",
                description: "PRIMARY Android liveness check: round-trip ping to the phone through the NEXUS Android Agent app. Returns pong data on success, 503 when no phone is connected, 504 when the phone does not answer in time.",
                parameters: { type: "object", properties: {} }
              }
            },
            {
              type: "function",
              function: {
                name: "phone_info",
                description: "PRIMARY Android device information: model, manufacturer, Android release, SDK level and ABIs as reported by the NEXUS Android Agent app on the phone itself (no ADB).",
                parameters: { type: "object", properties: {} }
              }
            },
            {
              type: "function",
              function: {
                name: "phone_agent_command",
                description: "Run ONE capability on the phone through the NEXUS Android Agent app. The capability name MUST come from phone_agent_status().agents[].capabilities — NEXUS validates it and rejects anything else before it reaches the phone, along with wrong argument names. There is no shell on the phone. Errors: UNKNOWN_CAPABILITY / INVALID_ARGUMENTS (rejected locally), 503 no phone connected, 504 phone did not answer.",
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "string", description: "Capability name from the phone's advertised capabilities list" },
                    args: { type: "object", description: "Arguments for that capability. Verified schemas, enforced: open_app takes exactly {package} (NOT package_name); home/back/device_info take {}; ping takes {echo?}. For capabilities without a verified schema, use the names the phone reports in its error detail — never invent argument names." },
                    timeout_sec: { type: "integer", description: "How long to wait for the phone (1-120, default 30)" }
                  },
                  required: ["command"]
                }
              }
            },
            {
              type: "function",
              function: {
                name: "android_app_lookup",
                description: "Resolve a spoken Android app name or alias (\"YT\", \"IG\", \"the browser\", \"Play Store\", \"WhatsApp\") to candidate package ids from NEXUS's single app mapping. Runs locally, no phone needed. Pass installed_packages (from the phone's list_apps capability) when several OEM/Google variants exist so the installed one is chosen instead of a guess. Use the result as the {package} value for open_app.",
                parameters: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "App name, alias, or an existing package id" },
                    installed_packages: {
                      type: "array",
                      items: { type: "string" },
                      description: "Optional package list from list_apps on the phone, used to pick the installed variant"
                    }
                  },
                  required: ["name"]
                }
              }
            },


          ];

          // First gate: never even offer the model a tool the user's Security /
          // Computer / Devices / Memory / Coding settings forbid.
          const allowedTools = tools.filter(
            (t) => isToolAllowedBySettings(t.function.name, policySettings).allow,
          );




          const codingContext = coding?.enabled
            ? `\n\n## CODING WORKSPACE (authoritative)\n- Workspace root: ${
                coding.workspaceRoot || "(not set — ask the user for an absolute folder path before touching any code)"
              }\n- Active project: ${coding.activeProject || "(none)"}\n- Safety mode: ${
                coding.mode === "confirm"
                  ? "confirm-every-action (each write/command is approved by the user; keep steps small and explain them)"
                  : "autonomous inside the workspace (do not stop for routine approval)"
              }\n- Default command timeout: ${coding.commandTimeoutSec}s — pass timeout_sec on long builds/tests.\n- Git: ${
                coding.gitEnabled ? "enabled" : "disabled"
              }, pushing ${coding.allowPush ? "allowed" : "NOT allowed"}.\nAny path outside the workspace root is refused by the client. Never attempt it.`
            : "";

          const systemContent =
            (memories && memories.length
              ? `${SYSTEM_PROMPT}\n\n## MEMORY CONTEXT (permanent, all chats)\n${memories
                  .map((m) => `- ${m}`)
                  .join("\n")}`
              : SYSTEM_PROMPT) + codingContext;


          // Ollama runs on the user's own PC and is unreachable from this server.
          // When it is the pinned provider, hand the fully prepared request back to
          // the browser, which calls localhost:11434 directly. Prompt building and
          // tool gating above stay exactly the same.
          if (ai?.providerId === "ollama" && ai?.autoRouting === false) {
            return new Response(
              JSON.stringify({
                _nexus_local: {
                  provider: "ollama",
                  messages: [{ role: "system", content: systemContent }, ...messages],
                  tools: allowedTools,
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }

          const { response, attempts } = await routeChat({
            messages: [{ role: "system", content: systemContent }, ...messages],
            tools: allowedTools,
            ...(ai ? { overrides: ai } : {}),
          });

          // Second gate: a model can still emit a call for a tool it was not
          // offered. Strip those server-side and tell it why.
          const blockedCalls: string[] = [];
          const allowedCalls = response.toolCalls.filter((c) => {
            const verdict = isToolAllowedBySettings(c.function.name, policySettings);
            if (verdict.allow) return true;
            blockedCalls.push(`${c.function.name}: ${verdict.reason}`);
            return false;
          });

          const assistantText = blockedCalls.length
            ? [response.text, `Blocked by NEXUS policy — ${blockedCalls.join(" | ")}`]
                .filter(Boolean)
                .join("\n\n")
            : response.text;

          // Same OpenAI-shaped payload the NEXUS frontend already consumes,
          // plus non-sensitive provider metadata.
          return new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: response.finishReason,
                  message: {
                    role: "assistant",
                    content: assistantText,
                    ...(allowedCalls.length ? { tool_calls: allowedCalls } : {}),
                  },
                },
              ],

              usage: response.usage,
              _nexus: {
                provider: response.provider,
                providerName: response.providerName,
                model: response.model,
                modelLabel: response.modelLabel,
                latencyMs: response.latencyMs,
                fallbacks: attempts.length,
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );

        } catch (e) {
          console.error(e);
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
