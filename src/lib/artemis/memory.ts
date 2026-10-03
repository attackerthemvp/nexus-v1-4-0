// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/memory/step_memory.py, transcript.py, context_policy.py, notes tools
// Copyright 2026 Google LLC. Apache License, Version 2.0.
// Modified for NEXUS: Python -> TypeScript, in-memory per task run.

import type { StepRecord } from "./types";

export class NoteStore {
  private notes = new Map<string, string>();
  get(key: string) {
    return this.notes.get(key);
  }
  keys() {
    return [...this.notes.keys()];
  }
  save(key: string, content: string) {
    this.notes.set(key, content);
  }
  /** Executes a memory tool; returns [result text, previous task_plan if changed]. */
  exec(name: string, args: Record<string, unknown>): { result: string; planBefore?: string } {
    const key = typeof args["key"] === "string" ? args["key"] : "";
    const content = typeof args["content"] === "string" ? args["content"] : "";
    if (key.startsWith("checker-") && name !== "read_note")
      return { result: "ERROR: note keys with the `checker-` prefix are reserved for the system and are read-only." };
    const before = this.notes.get("task_plan") ?? "";
    switch (name) {
      case "list_notes":
        return { result: this.keys().length ? this.keys().join("\n") : "(no notes)" };
      case "read_note":
        return { result: this.notes.has(key) ? this.notes.get(key)! : `ERROR: note '${key}' not found.` };
      case "save_note":
        if (!key) return { result: "ERROR: key is required." };
        this.notes.set(key, content);
        return { result: `Saved note '${key}'.`, ...(key === "task_plan" ? { planBefore: before } : {}) };
      case "append_note": {
        if (!key) return { result: "ERROR: key is required." };
        const prev = this.notes.get(key);
        this.notes.set(key, prev ? `${prev}\n${content}` : content);
        return { result: `Appended to note '${key}'.`, ...(key === "task_plan" ? { planBefore: before } : {}) };
      }
      case "update_note": {
        const prev = this.notes.get(key);
        const oldT = String(args["old_text"] ?? "");
        const newT = String(args["new_text"] ?? "");
        if (prev == null) return { result: `ERROR: note '${key}' not found.` };
        const count = oldT ? prev.split(oldT).length - 1 : 0;
        if (count !== 1) return { result: `ERROR: old_text must match exactly once (matched ${count}).` };
        this.notes.set(key, prev.replace(oldT, newT));
        return { result: `Updated note '${key}'.`, ...(key === "task_plan" ? { planBefore: before } : {}) };
      }
      default:
        return { result: `ERROR: unknown memory tool ${name}` };
    }
  }
  /** Roll back a rejected task_plan edit. */
  restorePlan(content: string) {
    this.notes.set("task_plan", content);
  }
}

export class StepMemory {
  steps: StepRecord[] = [];
  add(r: StepRecord) {
    this.steps.push(r);
  }
  search(query: string): string {
    const q = query.toLowerCase();
    const hits = this.steps.filter((s) => `${s.thought} ${s.action} ${JSON.stringify(s.args)} ${s.result} ${s.summary ?? ""}`.toLowerCase().includes(q));
    return hits.length ? hits.slice(-10).map(formatStep).join("\n") : `No history matches '${query}'.`;
  }
  /**
   * Context policy: the most recent steps verbatim, older ones compressed to
   * their visual summary (or action line). Mirrors build_history_for.
   */
  history(limit = 60, verbatim = 8): string {
    const recent = this.steps.slice(-limit);
    if (!recent.length) return "(no steps executed yet)";
    return recent
      .map((s, i) => (i >= recent.length - verbatim ? formatStep(s) : `Step ${s.step}: ${s.summary ?? `${s.action} → ${s.result.slice(0, 80)}`}`))
      .join("\n");
  }
}

export function formatStep(s: StepRecord): string {
  const args = JSON.stringify(s.args);
  return `Step ${s.step} [${s.agent}] ${s.thought ? `thought: ${s.thought.replace(/\s+/g, " ").slice(0, 300)} | ` : ""}action: ${s.action}(${args.length > 200 ? `${args.slice(0, 200)}…` : args}) → ${s.result.replace(/\s+/g, " ").slice(0, 200)}${s.summary ? ` | summary: ${s.summary}` : ""}`;
}
