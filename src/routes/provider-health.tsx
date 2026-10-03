import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Key, RefreshCw, Signal } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/provider-health")({
  head: () => ({
    meta: [
      { title: "NEXUS — Advanced Provider Health" },
      {
        name: "description",
        content: "Per-key health, cooldowns and success rates for every configured AI provider.",
      },
      { property: "og:title", content: "NEXUS — Advanced Provider Health" },
      { property: "og:description", content: "Per-key AI provider health monitoring." },
    ],
  }),
  component: ProviderHealthPage,
});

interface KeySnapshot {
  slot: number;
  label: string;
  state: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  lastSuccess: number | null;
  lastFailure: number | null;
  lastError: string | null;
  cooldownUntil: number | null;
}

interface ProviderSnapshot {
  id: string;
  name: string;
  role: string;
  priority: number;
  state: string;
  configured: boolean;
  successes: number;
  failures: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  keys: KeySnapshot[];
  models: Array<{ id: string; label: string; capabilities: string[]; usable: boolean }>;
}

const OK_STATES = new Set(["HEALTHY", "UNKNOWN", "DEGRADED"]);

function stateColor(state: string) {
  if (state === "HEALTHY") return "text-primary";
  if (state === "UNKNOWN") return "text-muted-foreground";
  if (state === "DEGRADED") return "text-[color:var(--jarvis-warn,theme(colors.amber.400))]";
  if (state === "RATE_LIMITED" || state === "COOLDOWN") return "text-[color:var(--jarvis-warn,theme(colors.amber.400))]";
  if (state === "CONFIGURATION_MISSING") return "text-muted-foreground";
  return "text-destructive";
}

function dotColor(state: string) {
  if (OK_STATES.has(state)) return "bg-primary";
  if (state === "RATE_LIMITED" || state === "COOLDOWN") return "bg-[color:var(--jarvis-warn,theme(colors.amber.400))]";
  return "bg-destructive";
}

function formatWhen(ts: number | null) {
  if (!ts) return "—";
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function formatCooldown(until: number | null) {
  if (!until) return null;
  const remaining = until - Date.now();
  if (remaining <= 0) return null;
  const secs = Math.ceil(remaining / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.ceil(secs / 60)}m`;
}

function KeyRow({ k }: { k: KeySnapshot }) {
  const cooldown = formatCooldown(k.cooldownUntil);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/30 py-2.5 pl-8 pr-4">
      <div className="flex min-w-0 items-center gap-2">
        <Key size={12} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono text-[11px] text-foreground">{k.label}</span>
        <span
          className={cn("flex items-center gap-1.5 font-mono text-[10px] tracking-wide", stateColor(k.state))}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", dotColor(k.state))} aria-hidden />
          {k.state}
          {cooldown ? ` · retry in ${cooldown}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>
          {k.successes}/{k.successes + k.failures} ok
          {k.successRate !== null ? ` (${k.successRate}%)` : ""}
        </span>
        {k.avgLatencyMs !== null && <span>{k.avgLatencyMs}ms avg</span>}
        {k.lastError && <span className="text-destructive/90">last error: {k.lastError}</span>}
        <span>last success {formatWhen(k.lastSuccess)}</span>
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderSnapshot }) {
  return (
    <section className="panel overflow-hidden rounded-lg">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Signal size={14} className="text-primary" aria-hidden />
          <div>
            <h3 className="font-display text-[12px] tracking-[0.14em] text-foreground">{p.name}</h3>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {p.role} · priority {p.priority} · {p.keys.length} key{p.keys.length === 1 ? "" : "s"} configured
            </p>
          </div>
        </div>
        <span className={cn("flex items-center gap-1.5 font-mono text-[11px] tracking-wide", stateColor(p.state))}>
          <span className={cn("h-2 w-2 rounded-full", dotColor(p.state))} aria-hidden />
          {p.state}
          {p.successRate !== null ? ` · ${p.successRate}% overall` : ""}
          {p.avgLatencyMs ? ` · ${p.avgLatencyMs}ms avg` : ""}
        </span>
      </header>

      {p.keys.length === 0 ? (
        <p className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
          No API key configured — add {p.id.toUpperCase()}_API_KEY (or _2/_3/_4) server-side.
        </p>
      ) : (
        <div className="divide-y-0">
          {p.keys.map((k) => (
            <KeyRow key={k.slot} k={k} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProviderHealthPage() {
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-status");
      if (!res.ok) throw new Error(`ai-status ${res.status}`);
      const data = await res.json();
      setProviders(data.providers ?? []);
      setLastRefresh(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const sorted = [...providers].sort((a, b) => a.priority - b.priority);

  return (
    <div className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link to="/" className="flex items-center gap-1.5 font-mono text-[11px] text-primary hover:text-accent">
              <ArrowLeft size={13} aria-hidden />
              BACK TO NEXUS
            </Link>
            <h1 className="mt-2 font-display text-lg tracking-[0.1em] text-foreground">
              ADVANCED PROVIDER HEALTH
            </h1>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              Layer 1: providers, by priority. Layer 2: each provider's keys, slot 1 → 4. A key's cooldown
              never affects its siblings. API keys are stored server-side only and are never shown here.
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 self-start rounded border border-primary/50 px-3 py-1.5 font-display text-[11px] tracking-wider text-primary transition hover:bg-primary/10"
          >
            <RefreshCw size={12} className={cn(loading && "animate-spin")} aria-hidden />
            {loading ? "REFRESHING…" : "REFRESH"}
          </button>
        </header>

        {error && (
          <p className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            Failed to load provider health: {error}
          </p>
        )}

        {!error && sorted.length === 0 && !loading && (
          <p className="font-mono text-[11px] text-muted-foreground">No providers configured.</p>
        )}

        <div className="flex flex-col gap-4">
          {sorted.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </div>

        {lastRefresh && (
          <p className="text-center font-mono text-[10px] text-muted-foreground">
            Last refreshed {formatWhen(lastRefresh)} · auto-refreshes every 15s
          </p>
        )}
      </div>
    </div>
  );
}
