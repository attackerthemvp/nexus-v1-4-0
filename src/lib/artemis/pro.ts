// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/graph/graph.py, graph/checkpoints.py, agents/operator/*
// Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: the LangGraph runtime is replaced by an explicit
// TypeScript state machine: Planner -> Operator -> Validator/Safety Net -> Checker.

import operatorPrompts from "./assets/operator.json";
import { runChecker } from "./checker";
import { imagePart, type LlmMessage } from "./llm";
import {
  HELPER_TOOLS,
  MEMORY_DECLARATIONS,
  OPERATOR_SHELL_ORDER,
  TURN_ENDING_ORDER,
  declarationsFor,
  isDeviceAction,
} from "./manifest";
import { isStructuralEdit, newlyCompleted, parsePlan, renderPlanGrammarSpec, reopenMilestone, violatesContinuousLoop } from "./plan";
import { CHECK_FLAGS, runInitialPlanner, validatePlanChange } from "./planner";
import { checkCancel, executeAction, incident, llmCall, observe, observationText, type ArtemisContext } from "./session";
import { applyContract, renderTemplate } from "./template";
import type { ArtemisOutcome } from "./types";

export const PRO_MAX_TURNS = 60;
const MAX_BURST = 3;
const MAX_TOOL_CALLS = 20;
const CHECKPOINT_MAX_REPAIRS = 2;
const MEMORY_NAMES = ["read_note", "list_notes", "search_history"];
const PLAN_TOOLS = ["save_note", "update_note", "append_note"];

export type ProResult = { outcome: ArtemisOutcome; summary: string };

function operatorSystem(ctx: ArtemisContext, available: Set<string>) {
  const contract = applyContract((operatorPrompts as { main_template: string }).main_template, available, {
    physical_actions: OPERATOR_SHELL_ORDER,
    turn_ending_actions: TURN_ENDING_ORDER,
    helper_tools: HELPER_TOOLS,
    adb_tools: [], // zero-ADB: never enumerated
    memory_tools: MEMORY_NAMES,
  });
  return renderTemplate(contract, {
    initial_goal: ctx.goal,
    plan_and_history: `### Current Plan\n${ctx.notes.get("task_plan") ?? "(none)"}\n\n### Execution History\n${ctx.memory.history(60, 8)}`,
    plan_grammar: renderPlanGrammarSpec({ midway: CHECK_FLAGS.midway_checks, final: CHECK_FLAGS.final_check }),
    max_burst_actions: MAX_BURST,
    max_tool_calls: MAX_TOOL_CALLS,
    checkpoint_max_repairs: CHECKPOINT_MAX_REPAIRS,
    checks_active: true,
    midway_checks_active: CHECK_FLAGS.midway_checks,
    verification_active: true,
    transcript_history: false,
  });
}

export async function runPro(ctx: ArtemisContext): Promise<ProResult> {
  ctx.step = 0;
  pendingMilestones = [];
  await observe(ctx);
  await runInitialPlanner(ctx);

  const caps = ctx.actuator.caps.actions;
  const available = new Set<string>([...caps, ...MEMORY_NAMES]);
  const tools = [
    ...declarationsFor("operator", caps),
    ...MEMORY_NAMES.map((n) => MEMORY_DECLARATIONS[n]!),
    ...PLAN_TOOLS.map((n) => MEMORY_DECLARATIONS[n]!),
  ];
  const repairs = new Map<string, number>();
  let finalRepairs = 0;
  let idleTurns = 0;

  for (let turn = 1; turn <= PRO_MAX_TURNS; turn++) {
    ctx.step = turn;
    checkCancel(ctx);
    if (turn > 1) await observe(ctx);

    // ---- terminal checks on the plan -------------------------------------------------
    const snap = parsePlan(ctx.notes.get("task_plan") ?? "");
    if (snap.blocked.length) return { outcome: "needs_user", summary: `Blocked milestone: ${snap.blocked.map((b) => b.text).join("; ")}` };
    if (snap.allDone) {
      const finals = snap.checks.filter((c) => c.atEnd || c.anchor === null);
      if (!finals.length) return { outcome: "done", summary: "All plan milestones are complete." };
      const report = await runChecker(ctx, "final", finals);
      const failed = report.verdicts.filter((v) => v.status === "failed");
      if (!failed.length) return { outcome: "done", summary: `All milestones complete; final checks: ${report.verdicts.map((v) => `${v.status} — ${v.item_text}`).join("; ")}` };
      if (failed.some((v) => v.kind === "assert") || ++finalRepairs > CHECKPOINT_MAX_REPAIRS)
        return { outcome: "stuck", summary: `Final check failed: ${failed.map((v) => `${v.item_text} (${v.evidence})`).join("; ")}` };
      const last = snap.milestones[snap.milestones.length - 1];
      if (last) reopen(ctx, last.text, failed.map((v) => v.evidence).join(" "));
      continue;
    }

    // ---- operator turn ---------------------------------------------------------------
    ctx.emit({ kind: "stage", stage: "operating", agent: "operator", step: turn });
    const user: Exclude<LlmMessage["content"], string> = [{ type: "text", text: observationText(ctx) }];
    if (ctx.obs?.screenshotB64) user.push(imagePart(ctx.obs.screenshotB64, ctx.obs.screenshotMime));
    const messages: LlmMessage[] = [{ role: "system", content: operatorSystem(ctx, available) }, { role: "user", content: user }];
    let ended = false;
    let thoughtAll = "";

    for (let call = 0; call < MAX_TOOL_CALLS && !ended; call++) {
      const reply = await llmCall(ctx, "operator", messages, tools);
      const thought = reply.text.trim();
      if (thought) {
        thoughtAll += `${thought}\n`;
        ctx.emit({ kind: "thought", agent: "operator", step: turn, text: thought });
      }
      messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.raw } })) });
      if (!reply.toolCalls.length) break;

      const actions = reply.toolCalls.filter((t) => isDeviceAction(t.name));
      for (const tc of reply.toolCalls.filter((t) => !isDeviceAction(t.name))) {
        let content: string;
        if (tc.name === "search_history") content = ctx.memory.search(String(tc.args["query"] ?? ""));
        else if (MEMORY_NAMES.includes(tc.name) || PLAN_TOOLS.includes(tc.name)) content = await handlePlanTool(ctx, tc.name, tc.args, thoughtAll);
        else content = `ERROR: tool ${tc.name} is not available.`;
        messages.push({ role: "tool", tool_call_id: tc.id, content });
      }
      if (actions.length) {
        ended = true;
        const burst = actions.slice(0, MAX_BURST);
        const vetted = burst.length === 1;
        let stop = false;
        for (const tc of actions) {
          let content = "SKIPPED: burst limit or an earlier action failed.";
          if (!stop && burst.includes(tc)) {
            const { result, aborted } = await executeAction(ctx, "operator", tc.name, tc.args, { vetted, thought: thoughtAll });
            if (aborted) return { outcome: "needs_user", summary: `You declined the step "${tc.name}". The task stopped there.` };
            content = `${result.code}: ${result.message}`;
            if (!result.ok) stop = true;
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content });
        }
      }
    }
    if (!ended) {
      if (++idleTurns >= 3) return { outcome: "stuck", summary: "The Operator stopped taking actions without completing the plan." };
    } else idleTurns = 0;

    // ---- checkpoints for newly completed milestones --------------------------------------
    for (const m of repairsPending(ctx)) {
      const items = parsePlan(ctx.notes.get("task_plan") ?? "").checks.filter((c) => c.anchor === m && !c.atEnd);
      if (!items.length) continue;
      const report = await runChecker(ctx, "checkpoint", items, m);
      const failed = report.verdicts.filter((v) => v.status === "failed");
      if (!failed.length) continue;
      const n = (repairs.get(m) ?? 0) + 1;
      repairs.set(m, n);
      if (failed.some((v) => v.kind === "assert") || n > CHECKPOINT_MAX_REPAIRS)
        return { outcome: "stuck", summary: `Checkpoint failed for "${m}": ${failed.map((v) => v.evidence).join("; ")}` };
      reopen(ctx, m, failed.map((v) => v.suggestion || v.evidence).join(" "));
    }
  }
  return { outcome: "stuck", summary: `Pro reached the ${PRO_MAX_TURNS}-turn limit without finishing the plan.` };
}

let pendingMilestones: string[] = [];
function repairsPending(_ctx: ArtemisContext) {
  const out = pendingMilestones;
  pendingMilestones = [];
  return out;
}

function reopen(ctx: ArtemisContext, milestone: string, finding: string) {
  const next = reopenMilestone(ctx.notes.get("task_plan") ?? "", milestone, finding);
  ctx.notes.restorePlan(next);
  incident(ctx, "check_failed", `Reopened "${milestone}": ${finding.slice(0, 200)}`);
  ctx.emit({ kind: "plan", content: next, reason: "reopen" });
}

async function handlePlanTool(ctx: ArtemisContext, name: string, args: Record<string, unknown>, thinking: string): Promise<string> {
  const { result, planBefore } = ctx.notes.exec(name, args);
  if (planBefore === undefined) return result;
  const after = ctx.notes.get("task_plan") ?? "";
  const loop = violatesContinuousLoop(planBefore, after);
  if (loop) {
    ctx.notes.restorePlan(planBefore);
    return `ERROR: ${loop}`;
  }
  if (isStructuralEdit(planBefore, after)) {
    const v = await validatePlanChange(ctx, planBefore, after, thinking);
    ctx.emit({ kind: "replan", step: ctx.step, approved: v.approved, feedback: v.feedback });
    if (!v.approved) {
      ctx.notes.restorePlan(planBefore);
      incident(ctx, "plan_rejected", v.feedback);
      return `REJECTED by the plan validator: ${v.feedback}`;
    }
  }
  pendingMilestones.push(...newlyCompleted(planBefore, after));
  ctx.emit({ kind: "plan", content: after, reason: "update" });
  return result;
}
