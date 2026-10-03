// Provider health monitor. In-memory per server instance; cheap and dependency-free.
//
// Two layers, matching the router's fallback order:
//   1. KEY layer   — per (provider, key slot). This is the source of truth:
//                    successes/failures/cooldowns are tracked per key, so one
//                    bad or rate-limited key never drags its siblings down.
//   2. PROVIDER layer — derived from its keys (best state among them, stats
//                    summed) purely for display and for provider-vs-provider
//                    ordering in the router. Nothing is tracked here directly.
import type { ErrorCategory, ProviderId, ProviderState } from "./types";
import { getProviderConfig, PROVIDERS, providerKeyEntries } from "./config";

interface Stats {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  latencies: number[];
  lastSuccess?: number;
  lastFailure?: number;
  lastError?: { category: ErrorCategory; status?: number; message: string };
  cooldownUntil?: number;
  cooldownStreak: number;
  rateLimited?: boolean;
}

function blankStats(): Stats {
  return { successes: 0, failures: 0, consecutiveFailures: 0, latencies: [], cooldownStreak: 0 };
}

/** model id -> disabled-until timestamp. Model availability is a provider-wide
 * fact (the model exists or it doesn't), not a per-key one, so this stays
 * separate from the key stats below. */
const badModels = new Map<ProviderId, Record<string, number>>();

// KEY-LEVEL stats, keyed by `${providerId}#${slot}`.
const keyStats = new Map<string, Stats>();
function ks(id: ProviderId, slot: number): Stats {
  const k = `${id}#${slot}`;
  let v = keyStats.get(k);
  if (!v) {
    v = blankStats();
    keyStats.set(k, v);
  }
  return v;
}

export function hasSecret(id: ProviderId): boolean {
  const cfg = getProviderConfig(id);
  if (!cfg) return false;
  return providerKeyEntries(cfg).length > 0;
}

/** Record a successful call made with a specific key slot. */
export function recordKeySuccess(id: ProviderId, slot: number, latencyMs: number) {
  const v = ks(id, slot);
  v.successes++;
  v.consecutiveFailures = 0;
  v.cooldownStreak = 0;
  v.rateLimited = false;
  delete v.cooldownUntil;
  v.lastSuccess = Date.now();
  v.latencies.push(latencyMs);
  if (v.latencies.length > 20) v.latencies.shift();
}

/** Record a failed call made with a specific key slot. Cooldown is scoped to
 * this key only — an AUTH/RATE_LIMIT failure on key 1 never touches key 2. */
export function recordKeyFailure(
  id: ProviderId,
  slot: number,
  category: ErrorCategory,
  message: string,
  opts: { status?: number; retryAfterMs?: number } = {},
) {
  const cfg = getProviderConfig(id);
  const v = ks(id, slot);
  v.failures++;
  v.consecutiveFailures++;
  v.lastFailure = Date.now();
  v.lastError = { category, message, ...(opts.status !== undefined ? { status: opts.status } : {}) };

  const pol = cfg?.cooldown;
  if (!pol) return;

  if (category === "RATE_LIMIT") {
    v.rateLimited = true;
    const wait = opts.retryAfterMs ?? Math.min(pol.baseCooldownMs * 2 ** v.cooldownStreak, pol.maxCooldownMs);
    v.cooldownStreak++;
    v.cooldownUntil = Date.now() + wait;
    return;
  }
  if (category === "AUTH" || category === "PAYMENT") {
    // This specific key is bad (revoked, wrong plan, out of credit) — back
    // off hard but never permanently, in case it's fixed server-side later.
    v.cooldownUntil = Date.now() + pol.maxCooldownMs;
    return;
  }
  if (v.consecutiveFailures >= pol.cooldownAfter) {
    const wait = Math.min(pol.baseCooldownMs * 2 ** v.cooldownStreak, pol.maxCooldownMs);
    v.cooldownStreak++;
    v.cooldownUntil = Date.now() + wait;
  }
}

export function markModelUnavailable(id: ProviderId, model: string, ms = 30 * 60_000) {
  const m = badModels.get(id) ?? {};
  m[model] = Date.now() + ms;
  badModels.set(id, m);
}

export function isModelUsable(id: ProviderId, model: string) {
  const until = badModels.get(id)?.[model];
  return !until || until < Date.now();
}

/** Health state of one specific key slot. */
export function getKeyState(id: ProviderId, slot: number): ProviderState {
  const cfg = getProviderConfig(id);
  if (!cfg || !cfg.enabled) return "OFFLINE";
  const v = ks(id, slot);
  if (v.cooldownUntil && v.cooldownUntil > Date.now()) return v.rateLimited ? "RATE_LIMITED" : "COOLDOWN";
  if (v.successes === 0 && v.failures === 0) return "UNKNOWN";
  if (v.consecutiveFailures >= cfg.cooldown.degradedAfter) return "DEGRADED";
  const total = v.successes + v.failures;
  if (total >= 5 && v.successes / total < 0.7) return "DEGRADED";
  return "HEALTHY";
}

export function isKeyAvailable(id: ProviderId, slot: number) {
  const st = getKeyState(id, slot);
  return st === "HEALTHY" || st === "UNKNOWN" || st === "DEGRADED";
}

// Best-state-wins ranking used to roll per-key states up into one provider state.
const STATE_RANK: ProviderState[] = [
  "HEALTHY",
  "UNKNOWN",
  "DEGRADED",
  "RATE_LIMITED",
  "COOLDOWN",
  "CONFIGURATION_MISSING",
  "OFFLINE",
];

/** Provider state, derived from its keys: the best state any configured key is in. */
export function getState(id: ProviderId): ProviderState {
  const cfg = getProviderConfig(id);
  if (!cfg || !cfg.enabled) return "OFFLINE";
  const entries = providerKeyEntries(cfg);
  if (!entries.length) return "CONFIGURATION_MISSING";
  let best: ProviderState = "OFFLINE";
  for (const { slot } of entries) {
    const st = getKeyState(id, slot);
    if (STATE_RANK.indexOf(st) < STATE_RANK.indexOf(best)) best = st;
  }
  return best;
}

/** True if at least one configured key for this provider can currently be tried. */
export function isAvailable(id: ProviderId) {
  const cfg = getProviderConfig(id);
  if (!cfg) return false;
  return providerKeyEntries(cfg).some(({ slot }) => isKeyAvailable(id, slot));
}

export function snapshot() {
  return PROVIDERS.map((cfg) => {
    const id = cfg.id;
    const entries = providerKeyEntries(cfg);

    const keySnaps = entries.map(({ slot }) => {
      const v = ks(id, slot);
      const total = v.successes + v.failures;
      const avg = v.latencies.length
        ? Math.round(v.latencies.reduce((a, b) => a + b, 0) / v.latencies.length)
        : null;
      return {
        slot,
        label: `Key ${slot}`,
        state: getKeyState(id, slot),
        successes: v.successes,
        failures: v.failures,
        consecutiveFailures: v.consecutiveFailures,
        successRate: total ? Math.round((v.successes / total) * 100) : null,
        avgLatencyMs: avg,
        lastSuccess: v.lastSuccess ?? null,
        lastFailure: v.lastFailure ?? null,
        lastError: v.lastError?.category ?? null,
        cooldownUntil: v.cooldownUntil ?? null,
      };
    });

    const successes = keySnaps.reduce((a, k) => a + k.successes, 0);
    const failures = keySnaps.reduce((a, k) => a + k.failures, 0);
    const total = successes + failures;
    const allLatencies = entries.flatMap(({ slot }) => ks(id, slot).latencies);
    const avg = allLatencies.length
      ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length)
      : null;

    return {
      id,
      name: cfg.name,
      role: cfg.role,
      priority: cfg.priority,
      state: getState(id),
      configured: entries.length > 0,
      successes,
      failures,
      successRate: total ? Math.round((successes / total) * 100) : null,
      avgLatencyMs: avg,
      // Per-key breakdown for the Advanced Provider Health panel. Never
      // includes key material — slot number + label only.
      keys: keySnaps,
      // Non-sensitive model catalogue so the Settings UI can pin a model.
      models: cfg.models.map((m) => ({
        id: m.id,
        label: m.label,
        capabilities: m.capabilities,
        usable: isModelUsable(id, m.id),
      })),
    };
  });
}
