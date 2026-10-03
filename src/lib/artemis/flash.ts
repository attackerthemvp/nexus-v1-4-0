// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/agents/flash/runner.py, flash_runner.md, flash_summarizer.md
// Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python -> TypeScript; model calls go through the NEXUS
// provider router; actions go through the zero-ADB Android Agent actuator.
// Flash actions are dispatched directly (no Validator), as upstream.

import flashRunner from "./assets/flash_runner.md?raw";
import flashSummarizer from "./assets/flash_summarizer.md?raw";
import { imagePart, type LlmMessage } from "./llm";
import { MEMORY_DECLARATIONS, REPORT_TASK_STATUS, declarationsFor, isDeviceAction } from "./manifest";
import { checkCancel, executeAction, llmCall, observe, observationText, type ArtemisContext } from "./session";
import { renderTemplate } from "./template";
import type { ArtemisOutcome } from "./types";

export const FLASH_MAX_TURNS = 40;
const NO_TOOL_CALL_NOTICE =
  "You did not call a tool. Every turn must end with exactly one action tool or `report_task_status`.";
const FINAL_TURN_NOTICE =
  "This is your FINAL turn. You must call `report_task_status` now with an honest status and explanation.";

export type FlashResult = { outcome: ArtemisOutcome; summary: string };

async function summarizeStep(ctx: ArtemisContext, step: number, before?: string, after?: string, mime?: string): Promise<string | null> {
  if (!before || !after) return null;
  ctx.emit({ kind: "stage", stage: "summarizing", agent: "summarizer", step });
  const reply = await llmCall(
    ctx,
    "flash-summarizer",
    [
      { role: "system", content: renderTemplate(flashSummarizer, { step_number: step }) },
      { role: "user", content: [{ type: "text", text: `Step ${step}. Action history:\n${ctx.memory.history(3, 3)}\nBefore:` }, imagePart(before, mime), { type: "text", text: "After:" }, imagePart(after, mime)] },
    ],
    [],
  );
  const s = reply.text.replace(/\s+/g, " ").trim();
  return s || null;
}

/** Replace image parts of past observations with their text summary (transcript discipline). */
function pruneImages(messages: LlmMessage[], summaries: Map<number, string>) {
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    const stepTag = m.content.find((p) => p.type === "text" && /^\[Observation step (\d+)\]/.test(p.text));
    if (!stepTag || stepTag.type !== "text") continue;
    const n = Number(/^\[Observation step (\d+)\]/.exec(stepTag.text)![1]);
    if (!m.content.some((p) => p.type === "image_url")) continue;
    m.content = [{ type: "text", text: `${stepTag.text.split("\n")[0]}\n[Visual summary] ${summaries.get(n) ?? "(screenshot omitted)"}` }];
  }
}

export async function runFlash(ctx: ArtemisContext): Promise<FlashResult> {
  const caps = ctx.actuator.caps.actions;
  const available = new Set<string>([...caps, "search_history"]);
  const tools = [...declarationsFor("flash", caps), MEMORY_DECLARATIONS["search_history"], REPORT_TASK_STATUS];
  const messages: LlmMessage[] = [{ role: "system", content: renderTemplate(flashRunner, { goal: ctx.goal, available_tools: available }) }];
  const summaries = new Map<number, string>();

  for (let turn = 1; turn <= FLASH_MAX_TURNS; turn++) {
    ctx.step = turn;
    const obs = await observe(ctx);
    const parts: Exclude<LlmMessage["content"], string> = [{ type: "text", text: `[Observation step ${turn}]\n${observationText(ctx)}${turn === FLASH_MAX_TURNS ? `\n\n${FINAL_TURN_NOTICE}` : ""}` }];
    if (obs.screenshotB64) parts.push(imagePart(obs.screenshotB64, obs.screenshotMime));
    messages.push({ role: "user", content: parts });

    ctx.emit({ kind: "stage", stage: "operating", agent: "flash", step: turn });
    const reply = await llmCall(ctx, "flash", messages, turn === FLASH_MAX_TURNS ? [REPORT_TASK_STATUS] : tools);
    const thought = reply.text.trim();
    if (thought) ctx.emit({ kind: "thought", agent: "flash", step: turn, text: thought });
    messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.raw } })) });

    if (!reply.toolCalls.length) {
      messages.push({ role: "user", content: NO_TOOL_CALL_NOTICE });
      continue;
    }
    let acted = false;
    for (const tc of reply.toolCalls) {
      checkCancel(ctx);
      if (tc.name === "report_task_status") {
        const ok = String(tc.args["status"]) === "completed";
        const summary = String(tc.args["explanation"] ?? "");
        return { outcome: ok ? "done" : "stuck", summary };
      }
      let content: string;
      if (tc.name === "search_history") content = ctx.memory.search(String(tc.args["query"] ?? ""));
      else if (isDeviceAction(tc.name) && !acted) {
        const { result, aborted } = await executeAction(ctx, "flash", tc.name, tc.args, { vetted: false, thought });
        if (aborted) return { outcome: "needs_user", summary: `You declined the step "${tc.name}". The task stopped there.` };
        content = `${result.code}: ${result.message}`;
        acted = true;
      } else content = isDeviceAction(tc.name) ? "SKIPPED: only one action per turn." : `ERROR: unknown tool ${tc.name}`;
      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }
    if (acted && obs.screenshotB64) {
      const after = await ctx.actuator.observe().catch(() => null);
      const s = await summarizeStep(ctx, turn, obs.screenshotB64, after?.screenshotB64, obs.screenshotMime);
      if (s) {
        summaries.set(turn, s);
        const rec = ctx.memory.steps[ctx.memory.steps.length - 1];
        if (rec) rec.summary = s;
      }
    }
    pruneImages(messages, summaries);
  }
  return { outcome: "stuck", summary: `Flash reached the ${FLASH_MAX_TURNS}-turn limit without reporting a result.` };
}
