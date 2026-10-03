// Shared NEXUS AI Router types. No secrets, no provider specifics here.

export type TaskType =
  | "GENERAL"
  | "CODING"
  | "DEBUGGING"
  | "REASONING"
  | "RESEARCH"
  | "TOOL_USE"
  | "COMPUTER_CONTROL"
  | "VISION"
  | "SIMPLE_FAST"
  | "LONG_CONTEXT";

export type Capability =
  | "tools"
  | "vision"
  | "coding"
  | "reasoning"
  | "long_context"
  | "fast";

export type ProviderId =
  | "gemini"
  | "lovable"
  | "openrouter"
  | "cerebras"
  | "grok"
  | "groq"
  | "kilo";

export type ProviderState =
  | "HEALTHY"
  | "DEGRADED"
  | "RATE_LIMITED"
  | "OFFLINE"
  | "COOLDOWN"
  | "CONFIGURATION_MISSING"
  | "UNKNOWN";

export interface ModelDef {
  id: string; // provider-native model id
  label: string;
  capabilities: Capability[];
  /** Higher = preferred within the provider. */
  weight: number;
  /** Task types this model is especially good at. */
  bestFor?: TaskType[];
  free?: boolean;
}

export interface RetryPolicy {
  maxAttemptsPerProvider: number;
  timeoutMs: number;
}

export interface CooldownPolicy {
  /** Failures before DEGRADED. */
  degradedAfter: number;
  /** Failures before COOLDOWN. */
  cooldownAfter: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  baseUrl: string;
  /** Name of the server-side env secret holding the API key. */
  secretName: string;
  enabled: boolean;
  priority: number;
  role: "primary" | "fallback" | "emergency";
  capabilities: Capability[];
  models: ModelDef[];
  retry: RetryPolicy;
  cooldown: CooldownPolicy;
  /** Extra static headers (never secrets). */
  headers?: Record<string, string>;
  /** Optional dynamic model discovery (OpenRouter). */
  discovery?: boolean;
}

export interface NexusToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NormalizedResponse {
  text: string;
  toolCalls: NexusToolCall[];
  provider: ProviderId;
  providerName: string;
  model: string;
  modelLabel: string;
  latencyMs: number;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type ErrorCategory =
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "NETWORK"
  | "MODEL_UNAVAILABLE"
  | "AUTH"
  | "BAD_REQUEST"
  | "INVALID_RESPONSE"
  | "PAYMENT";

export class ProviderError extends Error {
  category: ErrorCategory;
  status?: number;
  retryAfterMs?: number;
  constructor(
    category: ErrorCategory,
    message: string,
    opts: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.category = category;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
  /** Should the router move on / retry elsewhere? */
  get transient() {
    return (
      this.category === "RATE_LIMIT" ||
      this.category === "TIMEOUT" ||
      this.category === "SERVER_ERROR" ||
      this.category === "NETWORK" ||
      this.category === "MODEL_UNAVAILABLE" ||
      this.category === "INVALID_RESPONSE"
    );
  }
}

export interface ChatRequest {
  messages: any[];
  tools: any[];
  systemPrompt: string;
}
