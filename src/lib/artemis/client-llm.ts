// NEXUS addition: browser-side ArtemisLLM that calls /api/artemis-llm.
// No request timeout on model calls; only user Stop (AbortSignal) cancels.
import { parseToolArgs, type ArtemisLLM, type LlmMessage, type LlmReply } from "./llm";

export function createClientLLM(opts: { signal?: AbortSignal; ai?: unknown; endpoint?: string }): ArtemisLLM {
  return {
    async call(_agent: string, messages: LlmMessage[], tools: unknown[]): Promise<LlmReply> {
      const r = await fetch(opts.endpoint ?? "/api/artemis-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(opts.signal ? { signal: opts.signal } : {}),
        body: JSON.stringify({ messages, tools, ...(opts.ai ? { ai: opts.ai } : {}) }),
      });
      const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return {
        text: data.text ?? "",
        provider: data.provider ?? "?",
        model: data.model ?? "?",
        toolCalls: (data.toolCalls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
          id: c.id,
          name: c.function.name,
          raw: c.function.arguments ?? "{}",
          args: parseToolArgs(c.function.arguments),
        })),
      };
    },
  };
}
