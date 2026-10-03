// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/llm/* — Copyright 2026 Google LLC. Apache License, Version 2.0.
// Modified for NEXUS: direct Gemini/Vertex/LangChain clients are replaced by the
// NEXUS provider router (server function). The Artemis mode (Flash/Pro) is NOT
// a routing input: provider failover can never change it.

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type LlmToolCall = { id: string; name: string; args: Record<string, unknown>; raw: string };
export type LlmReply = { text: string; toolCalls: LlmToolCall[]; provider: string; model: string };

export interface ArtemisLLM {
  /** `agent` is informational (logging/UI); it never changes provider or mode. */
  call(agent: string, messages: LlmMessage[], tools: unknown[]): Promise<LlmReply>;
}

export function imagePart(b64: string, mime = "image/jpeg") {
  return { type: "image_url" as const, image_url: { url: `data:${mime};base64,${b64}` } };
}

export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return { __invalid_json: raw.slice(0, 300) };
  }
}

/** Extract the first JSON object from model text (structured-output fallback). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const src = fenced ? fenced[1]! : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(src.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
