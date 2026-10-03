// Central NEXUS provider/model registry. Change models & priorities HERE only.
import type { ProviderConfig } from "./types";

const defaultRetry = { maxAttemptsPerProvider: 2, timeoutMs: 45_000 };
const defaultCooldown = {
  degradedAfter: 2,
  cooldownAfter: 3,
  baseCooldownMs: 30_000,
  maxCooldownMs: 10 * 60_000,
};

export const PROVIDERS: ProviderConfig[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    // OpenAI-compatible surface of the Gemini API (keeps one common adapter).
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    secretName: "GEMINI_API_KEY",
    enabled: true,
    priority: 1,
    role: "primary",
    capabilities: ["tools", "vision", "coding", "reasoning", "long_context", "fast"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    models: [
      {
        id: "gemini-3.7-flash",
        label: "Gemini 3.7 Flash",
        capabilities: ["tools", "vision", "coding", "reasoning", "long_context", "fast"],
        weight: 100,
        bestFor: ["GENERAL", "TOOL_USE", "COMPUTER_CONTROL", "RESEARCH", "VISION"],
      },
      {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        capabilities: ["tools", "vision", "coding", "reasoning", "long_context"],
        weight: 90,
        bestFor: ["CODING", "DEBUGGING", "REASONING", "LONG_CONTEXT"],
      },
      {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash Lite",
        capabilities: ["tools", "fast"],
        weight: 70,
        bestFor: ["SIMPLE_FAST"],
      },
      {
        id: "gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        capabilities: ["tools", "vision", "coding", "reasoning", "fast"],
        weight: 60,
      },
    ],
  },
  {
    id: "lovable",
    name: "Lovable AI",
    baseUrl: "https://ai.gateway.lovable.dev/v1",
    secretName: "LOVABLE_API_KEY",
    enabled: true,  // No API key — disable to skip attempts
    priority: 2,
    role: "fallback",
    capabilities: ["tools", "vision", "coding", "reasoning", "long_context", "fast"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    models: [
      {
        id: "google/gemini-2.5-flash",
        label: "Gemini 2.5 Flash (Lovable)",
        capabilities: ["tools", "vision", "coding", "reasoning", "long_context", "fast"],
        weight: 100,
      },
      {
        id: "google/gemini-2.5-pro",
        label: "Gemini 2.5 Pro (Lovable)",
        capabilities: ["tools", "vision", "coding", "reasoning", "long_context"],
        weight: 80,
        bestFor: ["CODING", "DEBUGGING", "REASONING"],
      },
      {
        id: "google/gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash Lite (Lovable)",
        capabilities: ["tools", "fast"],
        weight: 60,
        bestFor: ["SIMPLE_FAST"],
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    secretName: "OPENROUTER_API_KEY",
    enabled: true,
    priority: 3,
    role: "fallback",
    capabilities: ["tools", "coding", "reasoning", "long_context", "fast"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    discovery: true,
    headers: { "X-Title": "NEXUS" },
    models: [
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
        label: "Nemotron Ultra 550B (free)",
        capabilities: ["tools", "reasoning", "coding", "long_context"],
        weight: 100,
        bestFor: ["REASONING", "CODING", "LONG_CONTEXT"],
        free: true,
      },
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        label: "Nemotron Super 120B (free)",
        capabilities: ["tools", "reasoning", "coding"],
        weight: 90,
        bestFor: ["GENERAL", "TOOL_USE"],
        free: true,
      },
      {
        id: "google/gemma-4-31b-it:free",
        label: "Gemma 4 31B (free)",
        capabilities: ["tools", "vision", "coding", "reasoning"],
        weight: 80,
        bestFor: ["CODING", "VISION"],
        free: true,
      },
      {
        id: "google/gemma-4-26b-a4b-it:free",
        label: "Gemma 4 26B MoE (free)",
        capabilities: ["tools", "reasoning", "fast"],
        weight: 70,
        free: true,
      },
      {
        id: "z-ai/glm-5.2:free",
        label: "GLM 5.2 (free)",
        capabilities: ["tools", "reasoning"],
        weight: 65,
        free: true,
      },
      {
        id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        label: "Nemotron Nano Reasoning (free)",
        capabilities: ["reasoning", "fast"],
        weight: 55,
        bestFor: ["SIMPLE_FAST"],
        free: true,
      },
      {
        id: "minimax/minimax-m3:free",
        label: "MiniMax M3 (free)",
        capabilities: ["tools", "long_context"],
        weight: 50,
        free: true,
      },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    secretName: "CEREBRAS_API_KEY",
    enabled: true,
    priority: 4,
    role: "emergency",
    capabilities: ["tools", "coding", "reasoning", "fast"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    models: [
      {
        id: "gpt-oss-120b",
        label: "GPT OSS 120B (Cerebras)",
        capabilities: ["tools", "reasoning", "coding", "fast"],
        weight: 100,
      },
      {
        id: "gemma-4-31b",
        label: "Gemma 4 31B (Cerebras)",
        capabilities: ["tools", "coding", "fast"],
        weight: 80,
        bestFor: ["CODING"],
      },
    ],
  },
  {
    id: "grok",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    secretName: "XAI_API_KEY",
    enabled: false,  // No API key — disable to skip attempts
    priority: 5,
    role: "emergency",
    capabilities: ["tools", "vision", "coding", "reasoning", "long_context"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    models: [
      {
        id: "grok-3-mini",
        label: "Grok 3 Mini",
        capabilities: ["tools", "reasoning", "fast"],
        weight: 100,
      },
      {
        id: "grok-3",
        label: "Grok 3",
        capabilities: ["tools", "reasoning", "coding", "long_context"],
        weight: 80,
        bestFor: ["CODING", "REASONING"],
      },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    secretName: "GROQ_API_KEY",
    enabled: true,
    priority: 6,
    role: "emergency",
    capabilities: ["tools", "coding", "reasoning", "fast"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    models: [
      {
        id: "openai/gpt-oss-120b",
        label: "GPT OSS 120B (Groq)",
        capabilities: ["tools", "reasoning", "coding", "fast"],
        weight: 100,
      },
      {
        id: "openai/gpt-oss-20b",
        label: "GPT OSS 20B (Groq)",
        capabilities: ["tools", "fast"],
        weight: 80,
        bestFor: ["SIMPLE_FAST"],
      },
      {
        id: "qwen/qwen3.6-27b",
        label: "Qwen 3.6 27B (Groq)",
        capabilities: ["tools", "coding", "reasoning"],
        weight: 70,
        bestFor: ["CODING"],
      },
      {
        id: "qwen/qwen3.8-27b",
        label: "Qwen 3.8 27B (Groq)",
        capabilities: ["tools", "coding", "reasoning"],
        weight: 65,
      },
      {
        id: "groq/compound",
        label: "Groq Compound (Groq)",
        capabilities: ["tools", "reasoning"],
        weight: 60,
      },
      {
        id: "groq/compound-mini",
        label: "Groq Compound Mini (Groq)",
        capabilities: ["tools", "fast"],
        weight: 50,
        bestFor: ["SIMPLE_FAST"],
      },
    ],
  },
  {
    id: "kilo",
    name: "Kilo Gateway",
    baseUrl: "https://api.kilo.ai/api/gateway",
    secretName: "KILO_API_KEY",
    enabled: true,
    priority: 7,
    role: "fallback",
    capabilities: ["tools", "vision", "coding", "reasoning", "long_context", "fast"],
    retry: defaultRetry,
    cooldown: defaultCooldown,
    headers: { "X-Title": "NEXUS" },
    models: [
      {
        id: "inclusionai/ling-3.0-flash-vl:free",
        label: "Ling 3.0 Flash VL (free)",
        capabilities: ["tools", "vision", "reasoning", "fast"],
        weight: 100,
        bestFor: ["VISION", "GENERAL"],
        free: true,
      },
      {
        id: "inclusionai/ling-3.0-flash:free",
        label: "Ling 3.0 Flash (free)",
        capabilities: ["tools", "reasoning", "fast"],
        weight: 95,
        bestFor: ["GENERAL", "SIMPLE_FAST"],
        free: true,
      },
      {
        id: "nex-agi/nex-n2.5-pro:free",
        label: "Nex N2.5 Pro (free)",
        capabilities: ["tools", "reasoning", "coding", "long_context"],
        weight: 90,
        bestFor: ["CODING", "REASONING"],
        free: true,
      },
      {
        id: "minimax/minimax-m3:free",
        label: "MiniMax M3 (free)",
        capabilities: ["tools", "reasoning", "long_context"],
        weight: 85,
        bestFor: ["LONG_CONTEXT"],
        free: true,
      },
      {
        id: "minimax/minimax-m2.7:free",
        label: "MiniMax M2.7 (free)",
        capabilities: ["tools", "reasoning"],
        weight: 80,
        free: true,
      },
      {
        id: "tencent/hy3:free",
        label: "Hunyuan 3 (free)",
        capabilities: ["tools", "reasoning", "coding"],
        weight: 75,
        free: true,
      },
      {
        id: "inclusionai/ring-2.6-1t:free",
        label: "Ring 2.6 1T (free)",
        capabilities: ["tools", "reasoning", "long_context"],
        weight: 70,
        bestFor: ["REASONING"],
        free: true,
      },
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
        label: "Nemotron Ultra 550B (free)",
        capabilities: ["tools", "reasoning", "coding", "long_context"],
        weight: 65,
        free: true,
      },
      {
        id: "poolside/laguna-s-2.1:free",
        label: "Laguna S 2.1 (free)",
        capabilities: ["tools", "coding"],
        weight: 60,
        bestFor: ["CODING"],
        free: true,
      },
      {
        id: "dots-studio/dots-3-note-preview:free",
        label: "Dots 3 Note Preview (free)",
        capabilities: ["tools", "reasoning"],
        weight: 55,
        free: true,
      },
      {
        id: "tencent/hy3-preview:free",
        label: "Hunyuan 3 Preview (free)",
        capabilities: ["tools", "reasoning"],
        weight: 50,
        free: true,
      },
    ],
  },
];

/** Max provider attempts for a single user request (prevents infinite loops). */
export const MAX_PROVIDER_ATTEMPTS = 40;

export function getProviderConfig(id: string) {
  return PROVIDERS.find((p) => p.id === id);
}

/** Extra credential slots per provider: <PRIMARY>_2, <PRIMARY>_3, <PRIMARY>_4. */
export const PROVIDER_KEY_SLOTS = 4;

/**
 * All env var names that may hold a key for this provider, in priority order.
 * Slot 1 is the original secretName — existing single-key setups keep working.
 */
export function providerKeyNames(cfg: ProviderConfig): string[] {
  return Array.from({ length: PROVIDER_KEY_SLOTS }, (_, i) =>
    i === 0 ? cfg.secretName : `${cfg.secretName}_${i + 1}`,
  );
}

/** Every configured (non-empty) key for this provider, in slot order. */
export function providerApiKeys(cfg: ProviderConfig): string[] {
  return providerKeyEntries(cfg).map((e) => e.key);
}

/**
 * Configured keys for this provider as {slot, key} pairs, slot 1..4, in slot
 * order. Slot numbers are preserved even when an earlier slot is empty (e.g.
 * only slots 1 and 3 set), so health tracking and the Advanced Provider
 * Health panel can always label a key by its real slot ("Key 3"), not its
 * position in a compacted array.
 */
export function providerKeyEntries(cfg: ProviderConfig): Array<{ slot: number; key: string }> {
  return providerKeyNames(cfg)
    .map((name, i) => ({ slot: i + 1, key: process.env[name] }))
    .filter((e): e is { slot: number; key: string } => Boolean(e.key));
}

// Round-robin cursor per provider so repeated requests spread across keys.
// Kept for callers that just want "a" key without per-key fallback semantics
// (e.g. one-off discovery calls); the router itself no longer uses this —
// it walks providerKeyEntries() in slot order with per-key health, see
// router.ts.
const keyCursor = new Map<string, number>();

/** Next key for a provider call; rotates across the configured slots. */
export function nextProviderApiKey(cfg: ProviderConfig): string | undefined {
  const keys = providerApiKeys(cfg);
  if (!keys.length) return undefined;
  const i = (keyCursor.get(cfg.id) ?? 0) % keys.length;
  keyCursor.set(cfg.id, i + 1);
  return keys[i];
}
