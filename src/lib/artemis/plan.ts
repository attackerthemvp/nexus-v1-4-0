// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/utils/plan_grammar.py — Copyright 2026 Google LLC.
// Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python -> TypeScript. Grammar text and regexes are exact.

export const STATUS_PENDING = " ";
export const STATUS_ACTIVE = "/";
export const STATUS_DONE = "x";
export const STATUS_BLOCKED = "!";
export const STATUS_CHARS = STATUS_PENDING + STATUS_ACTIVE + STATUS_DONE + STATUS_BLOCKED;
export const LOOP_TAG = "[Loop]";
export const CONTINUOUS_LOOP_TAG = "[Loop:continuous]";

export const CHECKBOX_LINE_RE = /^(\s*)-\s*\[([ /x!])\]\s*(.*)$/;
export const CHECK_LINE_RE = /^(\s*)-\s*(verify|assert)(@end)?\s*:\s*(\S.*?)\s*$/;
export const FINDING_LINE_RE = /^(\s*)-\s*finding\s*:\s*(.*)$/;

export type PlanStatus = " " | "/" | "x" | "!";
export type CheckItem = { kind: "verify" | "assert"; atEnd: boolean; text: string; anchor: string | null };
export type PlanItem = { indent: number; status: PlanStatus; text: string; line: number };
export type PlanSnapshot = {
  items: PlanItem[];
  milestones: PlanItem[];
  checks: CheckItem[];
  allDone: boolean;
  blocked: PlanItem[];
};

export const PLAN_GRAMMAR_BASE = `### Task Plan Grammar (machine-enforced contract)
Every checklist line MUST match \`<indent>- [<status>] <text>\`:
- Status characters: \`[ ]\` pending, \`[/]\` in progress, \`[x]\` completed, \`[!]\` blocked.
- Top-level lines (no indentation) are strategic milestones. Nested lines are their sub-goals: 2 spaces for a sub-goal, 4 spaces for a sub-sub-goal beneath it (deeper nesting is allowed). Only zero-indent lines count as milestones for termination and validation; nested lines are the executor's live ledger. All other text in the note is free-form context.
- \`[Loop]\` tags a BOUNDED iterative milestone: declare its exit boundary (e.g., \`(Exit: <condition>; Interval: <cadence>)\`) and mark it \`[x]\` only once that exit condition is verifiably met.
- \`[Loop:continuous]\` tags an UNBOUNDED continuous-monitoring milestone: it must stay \`[/]\` and can never be marked \`[x]\`, deleted, or untagged by you — the system mechanically rejects such edits. Only an explicit external stop signal injected by the user unlocks its completion; that signal is an external interruption delivered by the system, never something inferred from the screen or the plan.
- The task terminates only when every top-level milestone is \`[x]\`.`;

const CHECK_GRAMMAR_HEADER = `### Check Line Grammar (declared verification standards)
A top-level milestone may carry indented check lines, and the plan may end with task-level check lines at zero indentation:`;
const VERIFY_JUDGED_MIDWAY =
  "It is judged by an independent Checker at the moment the milestone is marked completed; a failed verify reopens the milestone for repair.";
const VERIFY_JUDGED_AT_EXIT =
  "It is judged once at task exit from the recorded evidence around the milestone's completion; there is no midway repair loop.";
const ASSERT_JUDGED_MIDWAY =
  "It is judged by the independent Checker when its milestone completes (at task exit for `@end`)";
const ASSERT_JUDGED_AT_EXIT = "It is judged once at task exit from the recorded evidence";
const CHECK_GRAMMAR_COMMON = `- \`- verify@end: ...\` / \`- assert@end: ...\` — the \`@end\` suffix defers judgment to task exit, using the final device state. Items without \`@end\` are judged from the evidence recorded around their anchored milestone's completion.
- Capability boundary (declare honestly, never promise more): all checks are POST-HOC audits over recorded evidence. They detect and record violations after the fact; they CANNOT block an action from happening, so "B must not run before A is confirmed" ordering rules are verified retroactively, not enforced. Transient prompts that were never captured in the execution history cannot be recovered — prefer expressing expectations as persistently probeable state.`;
const FINDING_GRAMMAR =
  "- `  - finding: ...` — a SYSTEM-authored standing headline pinned under a milestone whose verify criterion failed. You never author these lines: the system re-renders them on every plan write (deleting one only makes it reappear) and removes them automatically once the verify passes again or its repair budget is exhausted. Each finding names a `checker-...` note holding the full details and repair log — read it with `read_note`; note keys with the `checker-` prefix are reserved for the system and are read-only for you.";

/** Port of render_plan_grammar_spec. */
export function renderPlanGrammarSpec(opts: { midway: boolean; final: boolean }): string {
  if (!opts.midway && !opts.final) return PLAN_GRAMMAR_BASE;
  const lines = [
    CHECK_GRAMMAR_HEADER,
    `- \`  - verify: <expected state>\` — an acceptance criterion for its parent milestone. ${
      opts.midway ? VERIFY_JUDGED_MIDWAY : VERIFY_JUDGED_AT_EXIT
    }`,
    `- \`  - assert: <expected observation>\` — a test assertion. ${
      opts.midway ? ASSERT_JUDGED_MIDWAY : ASSERT_JUDGED_AT_EXIT
    } and a failure is recorded verbatim as a legitimate test result; assertions are NEVER repaired, worked around, or satisfied by constructing state.`,
    CHECK_GRAMMAR_COMMON,
  ];
  if (opts.midway) lines.push(FINDING_GRAMMAR);
  return `${PLAN_GRAMMAR_BASE}\n\n${lines.join("\n")}`;
}

export function parsePlan(content: string): PlanSnapshot {
  const items: PlanItem[] = [];
  const checks: CheckItem[] = [];
  let lastMilestone: string | null = null;
  content.split("\n").forEach((line, i) => {
    const cb = CHECKBOX_LINE_RE.exec(line);
    if (cb) {
      const item: PlanItem = {
        indent: cb[1]!.replace(/\t/g, "  ").length,
        status: cb[2] as PlanStatus,
        text: cb[3]!.trim(),
        line: i,
      };
      items.push(item);
      if (item.indent === 0) lastMilestone = item.text;
      return;
    }
    const ck = CHECK_LINE_RE.exec(line);
    if (ck) {
      const indent = ck[1]!.length;
      checks.push({
        kind: ck[2] as "verify" | "assert",
        atEnd: !!ck[3],
        text: ck[4]!,
        anchor: indent > 0 ? lastMilestone : null,
      });
    }
  });
  const milestones = items.filter((it) => it.indent === 0);
  return {
    items,
    milestones,
    checks,
    allDone: milestones.length > 0 && milestones.every((m) => m.status === "x"),
    blocked: milestones.filter((m) => m.status === "!"),
  };
}

/** Port of planner.validate_plan_format. */
export function validatePlanFormat(content: string): { ok: true } | { ok: false; error: string } {
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (s.startsWith("- [") && !CHECKBOX_LINE_RE.test(s)) {
      return {
        ok: false,
        error: `Invalid task status in line: ${line}. Must be one of '[ ]', '[/]', '[x]', '[!]'.`,
      };
    }
  }
  if (!parsePlan(content).items.length)
    return { ok: false, error: "Plan must contain at least one subgoal starting with '- [ ]'." };
  return { ok: true };
}

/** Milestones that became [x] between two plan versions (checkpoint trigger). */
export function newlyCompleted(before: string, after: string): string[] {
  const prev = new Map(parsePlan(before).milestones.map((m) => [m.text, m.status]));
  return parsePlan(after)
    .milestones.filter((m) => m.status === "x" && prev.get(m.text) !== "x")
    .map((m) => m.text);
}

/**
 * Structural edit detection (planner validator trigger): a milestone added,
 * removed or reworded — status-only changes are routine progress.
 */
export function isStructuralEdit(before: string, after: string): boolean {
  if (!before.trim()) return false;
  const a = parsePlan(before).milestones.map((m) => m.text);
  const b = parsePlan(after).milestones.map((m) => m.text);
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}

/** Continuous-loop guard: a [Loop:continuous] milestone may never be marked [x] or removed. */
export function violatesContinuousLoop(before: string, after: string): string | null {
  const prevCont = parsePlan(before).milestones.filter((m) => m.text.includes(CONTINUOUS_LOOP_TAG));
  const next = parsePlan(after).milestones;
  for (const p of prevCont) {
    const n = next.find((m) => m.text === p.text);
    if (!n) return `A ${CONTINUOUS_LOOP_TAG} milestone cannot be deleted or untagged: "${p.text}"`;
    if (n.status === "x") return `A ${CONTINUOUS_LOOP_TAG} milestone cannot be marked [x]: "${p.text}"`;
  }
  return null;
}

/** Reopen a milestone to [/] (checker repair loop) and pin a finding under it. */
export function reopenMilestone(content: string, milestone: string, finding: string): string {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => {
    const m = CHECKBOX_LINE_RE.exec(l);
    return m && m[1] === "" && m[3]!.trim() === milestone;
  });
  if (idx < 0) return content;
  lines[idx] = lines[idx]!.replace(/\[x\]/, "[/]");
  const cleaned = lines.filter((l, i) => !(i > idx && FINDING_LINE_RE.test(l) && l.includes(milestone.slice(0, 20))));
  cleaned.splice(idx + 1, 0, `  - finding: ${finding}`);
  return cleaned.join("\n");
}
