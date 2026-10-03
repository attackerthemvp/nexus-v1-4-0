// NEXUS AI Router — task classification, provider/model selection, health-aware
// two-layer fallback (provider, then key within provider), cooldowns and
// normalized responses.
import { MAX_PROVIDER_ATTEMPTS, PROVIDERS, providerKeyEntries } from "./config";
import { classify } from "./classifier";
import { ACTIVE_MODEL_TOKEN } from "./persona";
import {
  getState,
  hasSecret,
  isAvailable,
  isKeyAvailable,
  isModelUsable,
  markModelUnavailable,
  recordKeyFailure,
  recordKeySuccess,
} from "./health";
import { callOpenAICompatible } from "./providers/openai-compatible";
import { filterAvailable } from "./providers/openrouter-discovery";
import {
  ProviderError,
  type Capability,
  type ModelDef,
  type NormalizedResponse,
  type ProviderConfig,
} from "./types";

const log = (...a: unknown[]) => console.log("[AI ROUTER]", ...a);

function scoreModel(m: ModelDef, task: string, preferred: Capability[]) {
  let score = m.weight;
  if (m.bestFor?.includes(task as any)) score += 60;
  for (const c of preferred) if (m.capabilities.includes(c)) score += 20;
  return score;
}

function eligibleModels(
  cfg: ProviderConfig,
  required: Capability[],
  preferred: Capability[],
  task: string,
) {
  return cfg.models
    .filter((m) => isModelUsable(cfg.id, m.id))
    .filter((m) => required.every((c) => m.capabilities.includes(c)))
    .sort((a, b) => scoreModel(b, task, preferred) - scoreModel(a, task, preferred));
}

/** Order a provider's configured keys: healthy/available ones first (by slot
 * number, so slot 1 is always preferred when equally healthy), then any
 * cooling-down keys as a last resort — mirrors how providers themselves are
 * ordered, one layer down. */
function orderKeys(cfg: ProviderConfig) {
  const entries = providerKeyEntries(cfg);
  const ready = entries.filter((e) => isKeyAvailable(cfg.id, e.slot));
  const resting = entries.filter((e) => !isKeyAvailable(cfg.id, e.slot));
  return [...ready, ...resting];
}

export interface RouteResult {
  response: NormalizedResponse;
  attempts: Array<{ provider: string; model: string; error: string }>;
}

/** User-controllable routing preferences (from NEXUS Settings → AI & Models). */
export interface RoutingOverrides {
  /** false = pin the chosen provider/model instead of classifying the task. */
  autoRouting?: boolean;
  providerId?: string;
  modelId?: string;
  /** false = do not try other providers when the first choice fails. */
  failover?: boolean;
  maxAttempts?: number;
}

export async function routeChat(params: {
  messages: any[];
  tools: any[];
  overrides?: RoutingOverrides;
}): Promise<RouteResult> {
  const { messages, tools } = params;
  const ov = params.overrides ?? {};
  const { task, required, preferred } = classify(messages, tools.length > 0);
  const maxAttempts = Math.max(
    1,
    Math.min(MAX_PROVIDER_ATTEMPTS, ov.maxAttempts ?? MAX_PROVIDER_ATTEMPTS),
  );
  log(`task=${task} required=[${required.join(",")}] auto=${ov.autoRouting !== false}`);

  // Order providers: configured & available first, by priority; then degraded/cooldown
  // ones as a last resort so NEXUS never dies just because everything is cooling down.
  const configured = PROVIDERS.filter((p) => p.enabled && hasSecret(p.id));
  const skipped = PROVIDERS.filter((p) => p.enabled && !hasSecret(p.id));
  for (const p of skipped) log(`${p.name} skipped: CONFIGURATION_MISSING (${p.secretName})`);

  const ready = configured.filter((p) => isAvailable(p.id)).sort((a, b) => a.priority - b.priority);
  const resting = configured
    .filter((p) => !isAvailable(p.id))
    .sort((a, b) => a.priority - b.priority);
  let order = [...ready, ...resting];

  // Pinned provider first (and only, when failover is disabled).
  const pinned = ov.autoRouting === false && ov.providerId
    ? order.find((p) => p.id === ov.providerId)
    : undefined;
  if (pinned) {
    order = ov.failover === false ? [pinned] : [pinned, ...order.filter((p) => p !== pinned)];
    log(`provider pinned to ${pinned.name}${ov.modelId ? ` / ${ov.modelId}` : ""}`);
  } else if (ov.failover === false && order.length) {
    order = [order[0]!];
  }

  if (!order.length) {
    throw new Error(
      "No AI provider is configured. Add at least one provider key (GEMINI_API_KEY, LOVABLE_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY or XAI_API_KEY).",
    );
  }

  const attempts: RouteResult["attempts"] = [];
  let attemptCount = 0;

  // Layer 1: providers, by priority.
  for (const cfg of order) {
    if (attemptCount >= maxAttempts) break;

    const keyOrder = orderKeys(cfg);
    if (!keyOrder.length) continue;

    // Layer 2: keys within this provider, slot 1 → 2 → 3 → 4.
    for (const { slot, key: apiKey } of keyOrder) {
      if (attemptCount >= maxAttempts) break;

      let models = eligibleModels(cfg, required, preferred, task);
      if (pinned && cfg === pinned && ov.modelId) {
        // Honour the pinned model, but only if it still satisfies hard requirements.
        const exact = models.filter((m) => m.id === ov.modelId);
        if (exact.length) models = ov.failover === false ? exact : [...exact, ...models.filter((m) => m.id !== ov.modelId)];
        else log(`pinned model ${ov.modelId} cannot serve this request — using auto selection`);
      }
      if (cfg.discovery && models.length) {
        try {
          models = await filterAvailable(models, apiKey);
        } catch {
          /* discovery is best-effort */
        }
      }
      if (!models.length) {
        // For discovery providers (OpenRouter/Kilo) availability is looked up
        // per key, so a different key slot may still have a usable model —
        // try the next key rather than abandoning the whole provider.
        log(`${cfg.name} key #${slot} has no model matching required capabilities — trying next key`);
        continue;
      }

      const tryModels = models.slice(0, cfg.retry.maxAttemptsPerProvider);
      let keyDone = false;

      for (const model of tryModels) {
        if (attemptCount >= maxAttempts) break;
        attemptCount++;
        log(`selected ${cfg.name} key #${slot} → ${model.label} (key state=${getState(cfg.id)})`);
        try {
          // Tell NEXUS which model is actually serving this request so it can answer
          // "what model are you using?" truthfully instead of guessing.
          const resolved = messages.map((m) =>
            m?.role === "system" && typeof m.content === "string" && m.content.includes(ACTIVE_MODEL_TOKEN)
              ? { ...m, content: m.content.replaceAll(ACTIVE_MODEL_TOKEN, `${model.label} (${model.id}) via ${cfg.name}`) }
              : m,
          );
          const response = await callOpenAICompatible(cfg, model, apiKey, { messages: resolved, tools });
          recordKeySuccess(cfg.id, slot, response.latencyMs);
          log(`request successful via ${cfg.name} key #${slot} / ${model.id} in ${(response.latencyMs / 1000).toFixed(1)}s`);
          return { response, attempts };
        } catch (e) {
          const err =
            e instanceof ProviderError ? e : new ProviderError("NETWORK", (e as Error).message);
          attempts.push({ provider: `${cfg.name} (key ${slot})`, model: model.id, error: `${err.category}` });
          log(`${cfg.name} key #${slot} / ${model.id} failed: ${err.category} ${err.status ?? ""} ${err.message.slice(0, 200)}`);
          const failOpts: { status?: number; retryAfterMs?: number } = {};
          if (err.status !== undefined) failOpts.status = err.status;
          if (err.retryAfterMs !== undefined) failOpts.retryAfterMs = err.retryAfterMs;
          recordKeyFailure(cfg.id, slot, err.category, err.message, failOpts);

          if (err.category === "MODEL_UNAVAILABLE") {
            markModelUnavailable(cfg.id, model.id);
            continue; // try the same key's next model
          }
          if (err.category === "BAD_REQUEST" || err.category === "AUTH" || err.category === "PAYMENT") {
            keyDone = true; // this key is bad — move to the next key slot, not the next provider
            break;
          }
          if (err.category === "RATE_LIMIT") {
            keyDone = true; // this key is rate-limited — try the next key slot
            break;
          }
          // TIMEOUT / SERVER_ERROR / NETWORK / INVALID_RESPONSE → next model on the same key
        }
      }

      if (keyDone) log(`falling back from ${cfg.name} key #${slot} to next key`);
    }

    log(`falling back from ${cfg.name} to next provider`);
  }

  const detail = attempts.map((a) => `${a.provider}(${a.error})`).join(", ") || "no attempts";
  throw new Error(
    `All configured AI providers are currently unavailable. Tried: ${detail}. Please try again shortly.`,
  );
}
