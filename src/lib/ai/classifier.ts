// Deterministic, zero-cost task classification (no extra AI calls).
import type { Capability, TaskType } from "./types";

const RX: Array<[TaskType, RegExp]> = [
  ["DEBUGGING", /\b(debug|stack ?trace|traceback|exception|error|bug|not working|crash|failing|fix this)\b/i],
  ["CODING", /\b(code|coding|function|refactor|typescript|python|javascript|rust|sql|regex|script|compile|api|class|component|implement)\b/i],
  ["COMPUTER_CONTROL", /\b(open|launch|click|type|screenshot|screen|desktop|browser|install|shutdown|folder|file|run command|terminal|esp|device|relay|sensor|led|motor)\b/i],
  ["REASONING", /\b(why|explain|reason|analyz|prove|strategy|compare|trade-?off|architect|design a|plan)\b/i],
  ["RESEARCH", /\b(research|find out|look up|search|latest|news|summarize|documentation)\b/i],
  ["VISION", /\b(image|photo|picture|screenshot|see this|look at)\b/i],
];

export interface Classification {
  task: TaskType;
  required: Capability[];
  preferred: Capability[];
}

export function classify(messages: any[], hasTools: boolean): Classification {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  const totalChars = messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : 200),
    0,
  );
  const hasImage =
    Array.isArray(lastUser?.content) &&
    lastUser.content.some((p: any) => p?.type === "image_url");
  const hasToolTraffic = messages.some((m) => m.role === "tool" || m.tool_calls);

  let task: TaskType = "GENERAL";
  if (hasImage) task = "VISION";
  else {
    for (const [t, rx] of RX) {
      if (rx.test(text)) {
        task = t;
        break;
      }
    }
    if (task === "GENERAL" && totalChars > 40_000) task = "LONG_CONTEXT";
    if (task === "GENERAL" && text.length > 0 && text.length < 60 && !hasToolTraffic)
      task = "SIMPLE_FAST";
    if (task === "GENERAL" && hasToolTraffic) task = "TOOL_USE";
  }

  const required: Capability[] = [];
  // NEXUS is a tool-driven assistant: tool calling is required whenever tools are sent.
  if (hasTools) required.push("tools");
  if (hasImage) required.push("vision");
  if (totalChars > 40_000) required.push("long_context");

  const preferred: Capability[] = [];
  if (task === "CODING" || task === "DEBUGGING") preferred.push("coding");
  if (task === "REASONING" || task === "RESEARCH") preferred.push("reasoning");
  if (task === "SIMPLE_FAST") preferred.push("fast");

  return { task, required, preferred };
}
