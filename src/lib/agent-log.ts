// In-app agent activity log: tool calls, polling status, and errors.
// Purely client-side ring buffer so the HUD can show what NEXUS is doing.

export type AgentLogKind = "tool" | "status" | "poll" | "error";

export type AgentLogEntry = {
  id: string;
  ts: number;
  kind: AgentLogKind;
  /** Tool name or a short label for status/poll lines. */
  label: string;
  detail?: string;
  args?: unknown;
  ok?: boolean;
  durationMs?: number;
};

const MAX_ENTRIES = 400;
let entries: AgentLogEntry[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeAgentLog(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAgentLog(): AgentLogEntry[] {
  return entries;
}

export function logAgent(entry: Omit<AgentLogEntry, "id" | "ts">): AgentLogEntry {
  const full: AgentLogEntry = {
    ...entry,
    id: `l_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  };
  entries = [...entries, full].slice(-MAX_ENTRIES);
  emit();
  return full;
}

export function clearAgentLog() {
  entries = [];
  emit();
}
