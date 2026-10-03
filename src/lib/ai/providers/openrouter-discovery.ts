// Lightweight, cached discovery of currently-available FREE OpenRouter models.
// Never called on every message: results are cached for 6 hours.
import type { ModelDef } from "../types";

const TTL = 6 * 60 * 60 * 1000;
let cache: { at: number; ids: Set<string> } | null = null;
let inflight: Promise<Set<string>> | null = null;

async function fetchFreeModelIds(apiKey: string): Promise<Set<string>> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`discovery ${res.status}`);
  const data: any = await res.json();
  const ids = new Set<string>();
  for (const m of data?.data ?? []) {
    const p = m?.pricing ?? {};
    const free = Number(p.prompt ?? 1) === 0 && Number(p.completion ?? 1) === 0;
    if (free && typeof m.id === "string") ids.add(m.id);
  }
  return ids;
}

/** Returns null when discovery is unavailable — callers then trust the static registry. */
export async function getFreeModelIds(apiKey: string): Promise<Set<string> | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.ids;
  if (inflight) return inflight.catch(() => null);
  inflight = fetchFreeModelIds(apiKey)
    .then((ids) => {
      cache = { at: Date.now(), ids };
      inflight = null;
      return ids;
    })
    .catch((e) => {
      inflight = null;
      console.warn("[AI ROUTER] OpenRouter model discovery failed:", (e as Error).message);
      throw e;
    });
  return inflight.catch(() => null);
}

/** Filter registry models to those discovery says still exist (and are free). */
export async function filterAvailable(models: ModelDef[], apiKey: string): Promise<ModelDef[]> {
  const ids = await getFreeModelIds(apiKey);
  if (!ids || ids.size === 0) return models;
  const kept = models.filter((m) => !m.free || ids.has(m.id));
  return kept.length ? kept : models;
}
