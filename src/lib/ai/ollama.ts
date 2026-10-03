// Ollama provider (LOCAL). Unlike every other NEXUS provider, Ollama runs on the
// user's own PC, so it is unreachable from the NEXUS server. It is therefore
// called from the browser — exactly like the local NEXUS agent on 127.0.0.1 —
// while the server still builds the system prompt and the allowed tool list.
// No API key exists or is needed.

export const OLLAMA_DEFAULT_URLS = ["http://127.0.0.1:11434", "http://localhost:11434"];

export type OllamaModel = {
  id: string;
  label: string;
  /** Rough size/family info from `ollama list`, for the settings panel. */
  detail: string;
};

function candidateUrls(custom?: string): string[] {
  const trimmed = (custom ?? "").trim().replace(/\/+$/, "");
  return trimmed ? [trimmed] : OLLAMA_DEFAULT_URLS;
}

async function tryFetch(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The base URL that actually answers, or null when Ollama is not running. */
export async function resolveOllamaBase(custom?: string): Promise<string | null> {
  for (const base of candidateUrls(custom)) {
    try {
      const res = await tryFetch(`${base}/api/tags`, {}, 4000);
      if (res.ok) return base;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Equivalent of `ollama list` — the models installed on the user's PC. */
export async function listOllamaModels(custom?: string): Promise<OllamaModel[]> {
  const base = await resolveOllamaBase(custom);
  if (!base) return [];
  try {
    const res = await tryFetch(`${base}/api/tags`, {}, 6000);
    if (!res.ok) return [];
    const data: any = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    return models
      .map((m: any): OllamaModel | null => {
        const id = typeof m?.model === "string" ? m.model : typeof m?.name === "string" ? m.name : "";
        if (!id) return null;
        const size = m?.details?.parameter_size ? String(m.details.parameter_size) : "";
        const quant = m?.details?.quantization_level ? String(m.details.quantization_level) : "";
        return {
          id,
          label: id,
          detail: [size, quant].filter(Boolean).join(" · "),
        };
      })
      .filter((m: OllamaModel | null): m is OllamaModel => Boolean(m));
  } catch {
    return [];
  }
}

export type OllamaChatResult = {
  choices: Array<{ finish_reason: string | null; message: any }>;
  usage?: unknown;
  _nexus: {
    provider: string;
    providerName: string;
    model: string;
    modelLabel: string;
    latencyMs: number;
    fallbacks: number;
  };
};

/**
 * Chat completion against local Ollama, using its OpenAI-compatible surface so
 * the response shape (including tool_calls) matches every other NEXUS provider.
 */
export async function callOllamaChat(params: {
  messages: any[];
  tools: any[];
  modelId?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<OllamaChatResult> {
  const base = await resolveOllamaBase(params.baseUrl);
  if (!base) {
    throw new Error(
      `Ollama is not reachable at ${candidateUrls(params.baseUrl).join(" or ")}. Start Ollama on your PC (and allow this site with OLLAMA_ORIGINS).`,
    );
  }

  let model = (params.modelId ?? "").trim();
  if (!model) {
    const installed = await listOllamaModels(params.baseUrl);
    if (!installed.length) throw new Error("Ollama has no models installed. Run `ollama pull <model>` first.");
    model = installed[0]!.id;
  }

  const started = Date.now();
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: params.messages,
      ...(params.tools.length ? { tools: params.tools, tool_choice: "auto" } : {}),
    }),
  };
  if (params.signal) init.signal = params.signal;

  const res = await fetch(`${base}/v1/chat/completions`, init);
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`Ollama ${res.status}: ${text || "request failed"}`);
  }
  const data: any = await res.json();
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new Error("Ollama returned no message.");

  return {
    choices: [{ finish_reason: choice.finish_reason ?? null, message: choice.message }],
    usage: data.usage,
    _nexus: {
      provider: "ollama",
      providerName: "Ollama (local)",
      model,
      modelLabel: model,
      latencyMs: Date.now() - started,
      fallbacks: 0,
    },
  };
}
