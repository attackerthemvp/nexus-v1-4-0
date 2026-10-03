// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/mcp/action_manifest.py, action_specs.py, agents/validator/tool_declarations.py
// Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python -> TypeScript; declarations in OpenAI function format;
// ADB-only tools (run_adb_command, manage_task) are UNSUPPORTED (zero-ADB architecture).

/** Rule 1: structurally required by the Flash prompt ("atomic chained execution"). */
export const REQUIRED_ACTIONS = new Set(["click_sequence"]);
export const OPTIONAL_ACTIONS = new Set([
  "click",
  "long_press",
  "input_text",
  "swipe",
  "press_key",
  "manage_app",
  "wait_for_delay",
  "wait_for_text",
  "open_link",
  "erase_one_char",
  "focus_and_clear_text",
]);
/** Client-side adapter only; never declared to an LLM. */
export const INTERNAL_ACTIONS = new Set(["observe_screen", "take_screenshot", "get_ui_hierarchy"]);
export const DEVICE_ACTIONS = new Set([...REQUIRED_ACTIONS, ...OPTIONAL_ACTIONS, ...INTERNAL_ACTIONS]);

/** Backend-independent tools NEXUS implements. */
export const NEXUS_MEMORY_TOOLS = ["read_note", "list_notes", "save_note", "update_note", "append_note", "search_history"] as const;
/** Upstream tools that are deliberately unsupported in NEXUS (documented in docs/artemis-port.md). */
export const UNSUPPORTED_UPSTREAM_TOOLS = new Set([
  "run_adb_command", // ADB — forbidden by architecture
  "manage_task", // ADB background tasks — forbidden by architecture
  "ask_explorer",
  "ask_diagnoser",
  "ask_committee",
  "video_analyzer",
  "analyze_task_output",
  "replay_steps",
  "get_step_screenshot",
]);

export class ActuatorContractError extends Error {}

/** Port of validate_actuator, split per profile: Pro does not depend on click_sequence. */
export function validateCapabilities(caps: Set<string>, profile: "flash" | "pro"): void {
  if (profile === "flash") {
    const missing = [...REQUIRED_ACTIONS].filter((a) => !caps.has(a));
    if (missing.length)
      throw new ActuatorContractError(
        `The phone does not implement required action(s): ${missing.join(", ")}. These are structurally depended on by the Flash prompt and cannot be assembled away. Update the NEXUS Android Agent app (see the Artemis phone-app instructions), or switch to Pro yourself.`,
      );
  }
  const hasObserve = caps.has("observe_screen") || (caps.has("take_screenshot") && caps.has("get_ui_hierarchy"));
  if (!hasObserve)
    throw new ActuatorContractError(
      "The phone cannot provide a screen observation (needs snapshot/observe_screen, or take_screenshot + get_ui_hierarchy). Update the NEXUS Android Agent app and grant screen-capture permission.",
    );
}

const TARGET_DESCRIPTION =
  "What the target is, in a few words (e.g. 'play button', 'search input', 'video body'). REQUIRED when target is a coordinate pair; ignored for an element index.";
const INDEX_OR_COORDS = {
  description: "Can be an element index number (int, e.g. 3) OR normalized coordinates (list of 2 integers, e.g. [500, 600]).",
  anyOf: [{ type: "integer" }, { type: "array", items: { type: "integer" } }],
};

type Decl = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
const decl = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Decl => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const ACTION_DECLARATIONS: Record<string, Decl> = {
  click: decl(
    "click",
    "[ACTION] Click on the target location on the screen (supports element index or absolute normalized coordinates).",
    {
      target: { ...INDEX_OR_COORDS, description: `Click target. ${INDEX_OR_COORDS.description}` },
      target_description: { type: "string", description: TARGET_DESCRIPTION },
      times: { type: "integer", description: "Number of consecutive clicks on this target. Use this for double-clicks or multi-clicks (e.g. 7 to enter developer mode). Default is 1." },
      delay_ms: { type: "integer", description: "Delay in milliseconds between consecutive clicks. Default is 100." },
    },
    ["target"],
  ),
  click_sequence: decl(
    "click_sequence",
    "[ACTION] Executes a sequence of taps one by one in order on the specified targets (e.g. [[500, 280], [885, 362]]). The screen will be returned ONLY after all clicks in the sequence have completed.",
    {
      sequence: {
        type: "array",
        items: { type: "array", items: { type: "integer" }, description: "Normalized coordinates [x, y] in 0-1000 scale (e.g., [500, 280])." },
        description: "List of targets to tap in sequence, e.g. [[500, 280], [885, 362]].",
      },
      target_descriptions: {
        type: "array",
        items: { type: "string" },
        description: "What each target is, in a few words, one entry per sequence entry in the same order (e.g. ['video body', 'skip button']). Required: a coordinate names nothing by itself.",
      },
      delay_ms: { type: "integer", description: "Delay between consecutive taps in milliseconds (default 50ms)." },
    },
    ["sequence", "target_descriptions"],
  ),
  long_press: decl(
    "long_press",
    "[ACTION] Long press on the target location on the screen (supports element index or absolute normalized coordinates).",
    {
      target: { ...INDEX_OR_COORDS, description: `Long press target. ${INDEX_OR_COORDS.description}` },
      target_description: { type: "string", description: TARGET_DESCRIPTION },
      duration: { type: "integer", description: "Long press duration in milliseconds (default 1000)." },
    },
    ["target"],
  ),
  input_text: decl(
    "input_text",
    "[ACTION] Type text into the target input field (supports replacing whole text or appending to the end, and multi-line strings with '\\n').",
    {
      text: { type: "string", description: "The text content to input. Supports multi-line content with '\\n'." },
      target: { ...INDEX_OR_COORDS, description: `Input target field. Can be an input box element index number (int, e.g. 3) OR normalized coordinates (list of 2 integers, e.g. [500, 600]).` },
      target_description: { type: "string", description: TARGET_DESCRIPTION },
      clear_exist: { type: "boolean", description: "Whether to clear existing text before typing. True (default): clear/replace entire text. False: append at the end of existing content." },
    },
    ["text", "target"],
  ),
  swipe: decl(
    "swipe",
    "[ACTION] Perform a swipe, drag, or slider-adjustment gesture on the screen.\n\n• Directional Scrolling ('direction'): Recommended for general browsing and standard page scrolling in most scenarios. Automatically computes safe swipe vectors and adaptive duration, retains a ~40% visual overlap anchor for zero-omission traversal, and prevents inertial flings. Supports scoping to a sub-container via 'target'. If it fails on certain custom layouts, fall back to specifying exact coordinates ('start' and 'end') directly.\n• Precise Coordinate Gestures ('start', 'end'): Best for local, fine-grained interactions such as adjusting sliders/SeekBars (e.g., volume, brightness, progress bars), drag-and-drop / list reordering, or as a reliable fallback when directional scrolling fails on specific containers. Always drag slightly PAST the target position to overcome touch slop and reliably trigger the update. When setting a slider to Maximum (100%) or Minimum (0%), swipe fully to the extreme boundary.",
    {
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Direction for scrolling and swiping: 'up' (drags bottom-to-top, scrolling down to reveal content below), 'down' (drags top-to-bottom, scrolling up to reveal content above), 'left' (drags right-to-left, scrolling right), 'right' (drags left-to-right, scrolling left)." },
      start: { type: "array", items: { type: "integer" }, description: "Start normalized coordinates [start_x, start_y] in 0-1000 scale." },
      end: { type: "array", items: { type: "integer" }, description: "End normalized coordinates [end_x, end_y] in 0-1000 scale." },
      target: { description: "Optional target element index (e.g. 2) or container bounds [left, top, right, bottom] to scope the directional swipe within.", anyOf: [{ type: "integer" }, { type: "array", items: { type: "integer" } }] },
      target_description: { type: "string", description: "What is being dragged, in a few words (e.g. 'brightness slider knob'). REQUIRED for coordinate gestures ('start'/'end' or a coordinates list); ignored for directional scrolling." },
      duration: { type: "integer", description: "Optional swipe/drag duration in milliseconds (default 800; computed automatically for directional swipes)." },
    },
    [],
  ),
  press_key: decl(
    "press_key",
    "[ACTION] Press a physical or virtual system button (e.g. ENTER, BACK, HOME, APP_SWITCH).",
    { key: { type: "string", enum: ["ENTER", "BACK", "HOME", "APP_SWITCH"], description: "Standard Android system button name (ENTER, BACK, HOME, APP_SWITCH)." } },
    ["key"],
  ),
  manage_app: decl(
    "manage_app",
    "[ACTION] Launch or force stop a specified application.",
    {
      action: { type: "string", enum: ["launch", "stop"], description: "The action type." },
      app_name: { type: "string", description: "Human-readable app name or package name." },
    },
    ["action", "app_name"],
  ),
  wait_for_delay: decl(
    "wait_for_delay",
    "[ACTION] Wait for a fixed number of milliseconds to let loading, transitions or countdowns settle.",
    { time_in_ms: { type: "integer", description: "How long to wait, in milliseconds." } },
    ["time_in_ms"],
  ),
};

export const REPORT_TASK_STATUS: Decl = decl(
  "report_task_status",
  "[REPORT] Use this tool to return your final answer when you are done with the task. This is the ONLY way to return your final conclusion.",
  {
    status: { type: "string", description: "Whether the task was completed successfully ('completed') or failed/unreachable ('failed')." },
    explanation: { type: "string", description: "Provide the final explanation or summary of the task execution." },
  },
  ["status", "explanation"],
);

export const MEMORY_DECLARATIONS: Record<string, Decl> = {
  save_note: decl("save_note", "[MEMORY] Create or overwrite a note. Use key='task_plan' to write the task plan.", { key: { type: "string" }, content: { type: "string" } }, ["key", "content"]),
  update_note: decl("update_note", "[MEMORY] Replace an exact substring inside an existing note.", { key: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["key", "old_text", "new_text"]),
  append_note: decl("append_note", "[MEMORY] Append content to the end of a note (creates it if missing).", { key: { type: "string" }, content: { type: "string" } }, ["key", "content"]),
  read_note: decl("read_note", "[MEMORY] Read a note by key.", { key: { type: "string" } }, ["key"]),
  list_notes: decl("list_notes", "[MEMORY] List all note keys.", {}, []),
  search_history: decl("search_history", "[MEMORY] Search the recorded execution history (step thoughts, actions, results) for a phrase.", { query: { type: "string" } }, ["query"]),
};

/** Operator physical-action enumeration order (OPERATOR_SHELL_ORDER). */
export const OPERATOR_SHELL_ORDER = ["click", "input_text", "swipe", "press_key", "manage_app", "wait_for_delay", "long_press"] as const;
export const TURN_ENDING_ORDER = ["click", "swipe", "input_text", "long_press", "press_key", "manage_app", "wait_for_delay"] as const;
export const HELPER_TOOLS = ["ask_explorer", "ask_diagnoser", "video_analyzer"] as const;
export const ADB_TOOLS = ["run_adb_command", "manage_task"] as const;
export const MEMORY_TOOLS_ORDER = ["read_note", "list_notes", "search_history", "replay_steps", "get_step_screenshot"] as const;

/** Port of filter_declarations: only actions the phone can perform are declared. */
export function declarationsFor(profile: "flash" | "operator", caps: Set<string>): Decl[] {
  const names = profile === "flash"
    ? ["click_sequence", ...OPERATOR_SHELL_ORDER]
    : [...OPERATOR_SHELL_ORDER];
  return names.filter((n) => caps.has(n) && ACTION_DECLARATIONS[n]).map((n) => ACTION_DECLARATIONS[n]!);
}

export function isDeviceAction(name: string) {
  return DEVICE_ACTIONS.has(name) && !INTERNAL_ACTIONS.has(name);
}
