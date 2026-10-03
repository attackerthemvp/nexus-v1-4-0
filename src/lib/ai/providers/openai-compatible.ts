// One adapter for every OpenAI-compatible provider (Gemini OpenAI surface,
// Lovable gateway, OpenRouter, Cerebras, xAI). Normalizes responses & errors.
import {
  ProviderError,
  type ModelDef,
  type NormalizedResponse,
  type ProviderConfig,
} from "../types";

function categorize(status: number, body: string) {
  if (status === 429) return "RATE_LIMIT" as const;
  if (status === 408) return "TIMEOUT" as const;
  if (status === 401 || status === 403) return "AUTH" as const;
  if (status === 402) return "PAYMENT" as const;
  if (status >= 500) return "SERVER_ERROR" as const;
  if (status === 404) return "MODEL_UNAVAILABLE" as const;
  if (status === 400 && /model|not found|unsupported|does not exist/i.test(body))
    return "MODEL_UNAVAILABLE" as const;
  return "BAD_REQUEST" as const;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export async function callOpenAICompatible(
  cfg: ProviderConfig,
  model: ModelDef,
  apiKey: string,
  body: { messages: any[]; tools: any[] },
): Promise<NormalizedResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.retry.timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(cfg.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        messages: body.messages,
        ...(body.tools.length && model.capabilities.includes("tools")
          ? { tools: body.tools, tool_choice: "auto" }
          : {}),
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new ProviderError(
      aborted ? "TIMEOUT" : "NETWORK",
      aborted ? `${cfg.name} timed out after ${cfg.retry.timeoutMs}ms` : `${cfg.name} network error`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    const opts: { status: number; retryAfterMs?: number } = { status: res.status };
    const ra = retryAfterMs(res);
    if (ra !== undefined) opts.retryAfterMs = ra;
    throw new ProviderError(categorize(res.status, text), `${cfg.name} ${res.status}: ${text}`, opts);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ProviderError("INVALID_RESPONSE", `${cfg.name} returned non-JSON`);
  }

  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new ProviderError("INVALID_RESPONSE", `${cfg.name} returned no message`);

  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls = rawCalls.map((tc: any, i: number) => ({
    id: tc.id || `call_${Date.now()}_${i}`,
    type: "function" as const,
    function: {
      name: tc.function?.name ?? tc.name ?? "",
      arguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
    },
  }));

  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    provider: cfg.id,
    providerName: cfg.name,
    model: model.id,
    modelLabel: model.label,
    latencyMs: Date.now() - started,
    finishReason: choice.finish_reason ?? null,
    usage: data.usage,
  };
}
