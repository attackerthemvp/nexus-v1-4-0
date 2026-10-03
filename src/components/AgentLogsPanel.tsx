import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { X, Trash2, Filter } from "lucide-react";
import {
  clearAgentLog,
  getAgentLog,
  subscribeAgentLog,
  type AgentLogEntry,
  type AgentLogKind,
} from "@/lib/agent-log";

const KINDS: Array<{ id: AgentLogKind | "all"; label: string }> = [
  { id: "all", label: "ALL" },
  { id: "tool", label: "TOOLS" },
  { id: "poll", label: "POLLING" },
  { id: "status", label: "STATUS" },
  { id: "error", label: "ERRORS" },
];

function toneOf(e: AgentLogEntry) {
  if (e.kind === "error" || e.ok === false) return "text-destructive";
  if (e.kind === "poll") return "text-accent";
  if (e.kind === "status") return "text-muted-foreground";
  return "text-primary";
}

export function AgentLogsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const entries = useSyncExternalStore(subscribeAgentLog, getAgentLog, () => getAgentLog());
  const [kind, setKind] = useState<AgentLogKind | "all">("all");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const shown = useMemo(
    () => (kind === "all" ? entries : entries.filter((e) => e.kind === kind)).slice().reverse(),
    [entries, kind],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/70 backdrop-blur-sm">
      <button className="flex-1" aria-label="Close agent logs" onClick={onClose} />
      <aside className="panel flex h-full w-full max-w-xl flex-col rounded-none border-y-0 border-r-0">
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <h2 className="font-display text-sm tracking-[0.2em] text-primary text-glow">
              AGENT LOGS
            </h2>
            <p className="font-mono text-[10px] text-muted-foreground">
              Tool calls, background polling and errors
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={clearAgentLog}
              title="Clear log"
              className="rounded border border-border p-1.5 text-muted-foreground hover:border-destructive hover:text-destructive"
            >
              <Trash2 size={14} />
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded border border-border p-1.5 text-muted-foreground hover:border-primary hover:text-primary"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="flex items-center gap-1.5 border-b border-border/60 px-4 py-2">
          <Filter size={12} className="text-muted-foreground" />
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={`rounded border px-2 py-0.5 font-mono text-[10px] tracking-wider transition ${
                kind === k.id
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-primary"
              }`}
            >
              {k.label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {shown.length} entries
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px]">
          {shown.length === 0 ? (
            <p className="text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {shown.map((e) => (
                <li key={e.id} className="rounded border border-border/50 bg-input/30 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                    <span className={`tracking-wider ${toneOf(e)}`}>{e.label}</span>
                    <span className="text-muted-foreground/70">[{e.kind}]</span>
                    {e.durationMs != null && (
                      <span className="ml-auto text-muted-foreground">{e.durationMs}ms</span>
                    )}
                  </div>
                  {e.args != null && (
                    <div className="mt-1 truncate text-muted-foreground/80">
                      {JSON.stringify(e.args)}
                    </div>
                  )}
                  {e.detail && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
{e.detail}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
