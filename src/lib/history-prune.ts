// Long autonomous runs accumulate huge tool outputs and screenshots. Sending the
// raw transcript is the main reason providers start returning empty responses or
// 400s mid-run (context overflow), which the user experiences as "the agent froze".
// This trims the payload while keeping the task intent and the recent work.

import type { ChatMessage } from "./chat-store";

export const MAX_TOOL_RESULT_CHARS = 6_000;
export const MAX_MESSAGES = 90;
export const MAX_IMAGES = 2;

function truncate(text: string, limit = MAX_TOOL_RESULT_CHARS) {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.25));
  return `${head}\n\n…[${text.length - head.length - tail.length} characters trimmed by NEXUS to protect the context window]…\n\n${tail}`;
}

function isImageMessage(m: ChatMessage) {
  return Array.isArray(m.content) && (m.content as any[]).some((p) => p?.type === "image_url");
}

/** Returns a model-safe copy of the transcript. Never mutates the stored chat. */
export function pruneHistory(messages: ChatMessage[]): ChatMessage[] {
  const kept =
    messages.length > MAX_MESSAGES
      ? [...messages.slice(0, 2), ...messages.slice(-(MAX_MESSAGES - 2))]
      : [...messages];

  // Keep only the most recent screenshots; older ones are pure token cost.
  const imageIdx = kept.map((m, i) => (isImageMessage(m) ? i : -1)).filter((i) => i >= 0);
  const dropImages = new Set(imageIdx.slice(0, Math.max(0, imageIdx.length - MAX_IMAGES)));

  return kept.map((m, i) => {
    if (dropImages.has(i))
      return { ...m, content: "[older screenshot removed to save context]" } as ChatMessage;
    if (typeof m.content === "string" && m.content.length > MAX_TOOL_RESULT_CHARS)
      return { ...m, content: truncate(m.content) } as ChatMessage;
    return m;
  });
}
