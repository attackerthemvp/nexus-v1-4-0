// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/agents/planner/planner.py + planner.json — Copyright 2026 Google LLC.
// Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python/LangChain -> TypeScript; the plan-change validator's
// structured output (ValidationResult) is parsed from JSON.

import plannerPrompts from "./assets/planner.json";
import { extractJson, imagePart, type LlmMessage } from "./llm";
import { MEMORY_DECLARATIONS } from "./manifest";
import { renderPlanGrammarSpec, validatePlanFormat } from "./plan";
import { llmCall, observationText, type ArtemisContext } from "./session";
import { renderTemplate } from "./template";

type PlannerJson = { blocks: Record<string, string>; modes: Record<string, { system: string[]; human: string }> };
const P = plannerPrompts as PlannerJson;

export const CHECK_FLAGS = { midway_checks: true, final_check: true };

function system(mode: string, extra: string[] = []) {
  const ids = [...P.modes[mode]!.system, ...extra];
  return renderTemplate(ids.map((id) => P.blocks[id]).join("\n\n"), { ...CHECK_FLAGS });
}

const MAX_PLANNER_ROUNDS = 6;

/** Initial plan: the Planner must save a grammar-valid `task_plan` note. */
export async function runInitialPlanner(ctx: ArtemisContext): Promise<string> {
  ctx.emit({ kind: "stage", stage: "planning", agent: "planner", step: ctx.step });
  const sys = `${system("initial_plan", ["check_generation"])}\n\n${renderPlanGrammarSpec({ midway: CHECK_FLAGS.midway_checks, final: CHECK_FLAGS.final_check })}`;
  const content: Exclude<LlmMessage["content"], string> = [
    { type: "text", text: `${renderTemplate(P.modes["initial_plan"]!.human, { initial_goal: ctx.goal })}\n\nCurrent screen:\n${observationText(ctx)}` },
  ];
  if (ctx.obs?.screenshotB64) content.push(imagePart(ctx.obs.screenshotB64, ctx.obs.screenshotMime));
  const messages: LlmMessage[] = [{ role: "system", content: sys }, { role: "user", content }];
  const tools = [MEMORY_DECLARATIONS["save_note"], MEMORY_DECLARATIONS["read_note"], MEMORY_DECLARATIONS["list_notes"]];

  for (let round = 0; round < MAX_PLANNER_ROUNDS; round++) {
    const reply = await llmCall(ctx, "planner", messages, tools);
    if (reply.text.trim()) ctx.emit({ kind: "thought", agent: "planner", step: ctx.step, text: reply.text.trim() });
    messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.raw } })) });
    if (!reply.toolCalls.length) {
      messages.push({ role: "user", content: "You must save the plan with save_note(key='task_plan', content=...)." });
      continue;
    }
    for (const tc of reply.toolCalls) {
      let result: string;
      if (tc.name === "save_note" && tc.args["key"] === "task_plan") {
        const v = validatePlanFormat(String(tc.args["content"] ?? ""));
        result = v.ok ? ctx.notes.exec(tc.name, tc.args).result : `ERROR: ${v.error}`;
      } else result = ctx.notes.exec(tc.name, tc.args).result;
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    const plan = ctx.notes.get("task_plan");
    if (plan) {
      ctx.emit({ kind: "plan", content: plan, reason: "initial" });
      return plan;
    }
  }
  throw new Error("The Planner did not produce a valid task plan.");
}

/** Planner-as-validator for structural plan edits (approve / reject with feedback). */
export async function validatePlanChange(ctx: ArtemisContext, before: string, after: string, operatorThinking: string) {
  const human = renderTemplate(P.modes["validator"]!.human, {
    initial_goal: ctx.goal,
    history_str: ctx.memory.history(40, 10),
    operator_raw_thinking: operatorThinking,
    content_before: before,
    content_after: after,
  });
  const reply = await llmCall(
    ctx,
    "planner-validator",
    [
      { role: "system", content: system("validator") },
      { role: "user", content: `${human}\n\nRespond with JSON only: {"is_approved": true|false, "feedback": "<why>"}` },
    ],
    [],
  );
  const j = extractJson<{ is_approved?: boolean; feedback?: string }>(reply.text);
  return { approved: j?.is_approved !== false, feedback: j?.feedback ?? (j ? "" : "No structured verdict; approved by default.") };
}
