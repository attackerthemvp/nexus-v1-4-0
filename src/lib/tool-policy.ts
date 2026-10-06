// Client-side enforcement layer for NEXUS tool calls.
// Every local-agent / ESP / memory tool call passes through checkToolPolicy
// before it is executed, so the Security, Computer, Devices and Memory
// settings have REAL effect (blocked calls return an error to the model).
import type { NexusSettings } from "@/lib/settings-store";
import { ANDROID_REPEAT_SAFE_COMMANDS } from "@/lib/android-apps";

export type ToolCategory =
  | "read_files"
  | "write_files"
  | "run_commands"
  | "desktop"
  | "browser"
  | "esp"
  | "memory"
  | "control"
  | "info";

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  run_command: "run_commands",
  open_path: "run_commands",
  open_url: "run_commands",
  list_dir: "read_files",
  search_files: "read_files",
  read_file: "read_files",
  write_file: "write_files",
  apply_patch: "write_files",
  restore_backup: "write_files",
  list_backups: "read_files",
  grep: "read_files",
  project_tree: "read_files",
  run_command_bg: "run_commands",
  command_status: "run_commands",
  git_status: "read_files",
  git_diff: "read_files",
  git_branch: "run_commands",
  git_commit: "run_commands",
  git_push: "run_commands",

  system_info: "info",
  desktop_read: "desktop",
  desktop_screenshot: "desktop",
  desktop_click: "desktop",
  desktop_type: "desktop",
  desktop_hotkey: "desktop",
  desktop_press: "desktop",
  desktop_scroll: "desktop",
  show_desktop: "desktop",
  ufo_get_controls: "desktop",
  ufo_click_control: "desktop",
  ufo_click_norm: "desktop",
  ufo_type_into_control: "desktop",
  ufo_keyboard_input: "desktop",
  list_windows: "desktop",
  close_app: "desktop",
  window_action: "desktop",
  set_volume: "desktop",
  media_control: "desktop",
  open_folder: "desktop",
  browser_open: "browser",
  browser_goto: "browser",
  browser_read: "browser",
  browser_click: "browser",
  browser_type: "browser",
  browser_press: "browser",
  browser_scroll: "browser",
  browser_close: "browser",
  esp_list_projects: "esp",
  esp_get_project: "esp",
  esp_status: "esp",
  esp_delete_project: "esp",
  esp_register_project: "esp",
  device_command: "esp",
  web_search: "info",
  web_fetch: "info",
  remember_fact: "memory",
  forget_fact: "memory",
  recall_memories: "memory",
  finish_task: "control",
  request_user_input: "control",

  // Android Tools
  device_status: "info",
  device_info: "info",
  launch_app: "desktop",
  device_screenshot: "desktop",
  screenshot: "desktop",
  device_tap: "desktop",
  tap: "desktop",
  device_type_text: "desktop",
  type_text: "desktop",
  device_keyevent: "desktop",
  android_capabilities: "info",
  device_connect: "info",
  device_disconnect: "info",

  // NEXUS Android Agent (on-device app via the PC Agent) — primary Android path.
  phone_agent_status: "info",
  phone_ping: "info",
  phone_info: "info",
  phone_agent_command: "desktop",
  android_app_lookup: "info",

};

/**
 * Tools whose repetition is harmless: pure reads, status checks and
 * "go to a stable state" actions. The agent loop guard only blocks these when
 * they repeat back-to-back with an unchanged result (a genuine stuck loop).
 */
const REPEAT_SAFE_TOOLS = new Set([
  "phone_agent_status",
  "phone_ping",
  "phone_info",
  "android_app_lookup",
  "android_capabilities",
  "device_status",
  "device_info",
  "device_screenshot",
  "screenshot",
  "desktop_read",
  "desktop_screenshot",
  "show_desktop",
  "ufo_get_controls",
  "list_windows",
  "browser_read",
  "system_info",
  "esp_status",
  "esp_list_projects",
  "esp_get_project",
  "command_status",
  "git_status",
  "git_diff",
  "list_dir",
  "read_file",
  "recall_memories",
]);

export function isRepeatSafeToolCall(name: string, args: Record<string, unknown>): boolean {
  if (REPEAT_SAFE_TOOLS.has(name)) return true;
  if (name === "phone_agent_command") {
    const cmd = typeof args["command"] === "string" ? args["command"] : "";
    return ANDROID_REPEAT_SAFE_COMMANDS.has(cmd);
  }
  if (name === "device_keyevent") {
    const k = args["keycode"];
    return k === 3 || k === 4 || k === "3" || k === "4"; // HOME / BACK
  }
  return false;
}

export function toolCategory(name: string): ToolCategory {
  return CATEGORY_BY_TOOL[name] ?? "info";
}

/** Tools that reach the machine through the local NEXUS agent. */
export function isLocalAgentTool(name: string) {
  const c = toolCategory(name);
  return c === "read_files" || c === "write_files" || c === "run_commands" || c === "desktop" || c === "browser";
}

const DESTRUCTIVE_RX =
  /(\brm\s+-[rf]|\brmdir\b|\bdel\s+\/|\bformat\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bdrop\s+(table|database)\b|Remove-Item|\bdiskpart\b|\bkill(all)?\b|>\s*\/dev\/sd)/i;

export function looksDestructive(name: string, args: Record<string, unknown>): boolean {
  if (name === "esp_delete_project") return true;
  const text = [args["command"], args["path"], args["url"]]
    .filter((v) => typeof v === "string")
    .join(" ");
  return DESTRUCTIVE_RX.test(text);
}

/** Tools that must stay inside the configured coding workspace. */
const PATH_ARG_KEYS = ["path", "root", "repo", "cwd", "backup"] as const;

function normalizePath(p: string): string {
  const unified = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/** True when `child` is the workspace root itself or lives inside it. */
export function isInsideWorkspace(child: string, root: string): boolean {
  const c = normalizePath(child);
  const r = normalizePath(root);
  if (!r) return true;
  if (!c) return false;
  return c === r || c.startsWith(r + "/");
}

/** Every filesystem path referenced by a tool call. */
export function pathArgsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  const paths = args["paths"];
  if (Array.isArray(paths))
    for (const v of paths) if (typeof v === "string" && v.trim() && !v.startsWith("-")) out.push(v);
  return out;
}

export type PolicyDecision =

  | { allow: true; confirm?: { title: string; detail: string } }
  | { allow: false; reason: string };

export function checkToolPolicy(
  name: string,
  args: Record<string, unknown>,
  s: NexusSettings,
): PolicyDecision {
  const category = toolCategory(name);
  const p = s.security.permissions;

  // --- Hard blocks (enforced: the tool is never executed) ---
  if (isLocalAgentTool(name) && !s.computer.agentEnabled)
    return { allow: false, reason: "Computer control is disabled in NEXUS Settings → Computer." };
  if (category === "esp" && !s.devices.enabled)
    return { allow: false, reason: "Device (ESP/IoT) control is disabled in NEXUS Settings → Devices." };
  if (category === "read_files" && !p.readFiles)
    return { allow: false, reason: "File reading is not permitted (Settings → Security)." };
  if (category === "write_files" && !p.writeFiles)
    return { allow: false, reason: "File writing is not permitted (Settings → Security)." };
  if (category === "run_commands" && !p.runCommands)
    return { allow: false, reason: "Running commands is not permitted (Settings → Security)." };
  if (category === "desktop" && !p.desktopControl)
    return { allow: false, reason: "Desktop control is not permitted (Settings → Security)." };
  if (category === "browser" && !p.browserControl)
    return { allow: false, reason: "Browser control is not permitted (Settings → Security)." };
  if (category === "esp" && !p.espControl)
    return { allow: false, reason: "ESP/device control is not permitted (Settings → Security)." };
  if (category === "memory" && !s.memory.enabled)
    return { allow: false, reason: "NEXUS Memory is disabled in Settings → Memory." };
  if (name === "remember_fact" && !s.memory.autoRemember)
    return { allow: false, reason: "Automatic memory saving is disabled in Settings → Memory." };

  // --- Coding workspace containment (Settings → Coding) ---
  const coding = s.coding;
  const CODING_TOOLS = new Set([
    "apply_patch",
    "grep",
    "project_tree",
    "restore_backup",
    "list_backups",
    "run_command_bg",
    "command_status",
    "git_status",
    "git_diff",
    "git_branch",
    "git_commit",
    "git_push",
  ]);
  if (CODING_TOOLS.has(name) && !coding.enabled)
    return { allow: false, reason: "The coding toolkit is disabled in NEXUS Settings → Coding." };
  if (name === "git_push" && !coding.allowPush)
    return { allow: false, reason: "Pushing to a git remote is disabled in Settings → Coding." };
  if (name.startsWith("git_") && !coding.gitEnabled)
    return { allow: false, reason: "Git actions are disabled in Settings → Coding." };

  if (coding.workspaceRoot && (isLocalAgentTool(name) || CODING_TOOLS.has(name))) {
    for (const candidate of pathArgsOf(args)) {
      if (!isInsideWorkspace(candidate, coding.workspaceRoot))
        return {
          allow: false,
          reason: `Outside the authorised workspace (${coding.workspaceRoot}): ${candidate}. Stay inside the workspace or ask the user to change it in Settings → Coding.`,
        };
    }
  }

  const codingSummary = JSON.stringify(args).slice(0, 400);
  if (
    coding.enabled &&
    coding.mode === "confirm" &&
    (category === "write_files" || category === "run_commands")
  )
    return {
      allow: true,
      confirm: { title: `Confirm-every-action mode: ${name}`, detail: codingSummary },
    };

  // --- Confirmations (enforced with a blocking prompt before execution) ---

  const summary = JSON.stringify(args).slice(0, 400);
  if (s.security.confirmDestructive && looksDestructive(name, args))
    return { allow: true, confirm: { title: `Potentially destructive: ${name}`, detail: summary } };
  if (s.computer.confirmCommands && category === "run_commands")
    return { allow: true, confirm: { title: `Run command: ${name}`, detail: summary } };
  if (s.computer.confirmFileWrites && category === "write_files")
    return { allow: true, confirm: { title: `Write file: ${name}`, detail: summary } };
  if (s.computer.confirmDesktopControl && category === "desktop" && name !== "desktop_read" && name !== "desktop_screenshot")
    return { allow: true, confirm: { title: `Desktop action: ${name}`, detail: summary } };
  if (s.devices.confirmDeviceActions && (name === "device_command" || name === "esp_delete_project"))
    return { allow: true, confirm: { title: `Device action: ${name}`, detail: summary } };

  return { allow: true };
}

/**
 * Category-level gate, safe to run on the server where tool arguments are not
 * yet known. Used to strip forbidden tools from the list sent to the model and
 * to reject tool calls the model returns anyway.
 */
export function isToolAllowedBySettings(name: string, s: NexusSettings): PolicyDecision {
  const decision = checkToolPolicy(name, {}, s);
  return decision.allow ? { allow: true } : decision;
}

