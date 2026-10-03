// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/agents/checker/checker.py + checker.json — Copyright 2026 Google LLC.
// Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python/Pydantic -> TypeScript; structured output parsed
// from JSON. Read-only device probes (ADB) are unsupported: evidence comes from
// the recorded history, notes and the latest screenshot only.

import checkerPrompts from "./assets/checker.json";
import { extractJson, imagePart, type LlmMessage } from "./llm";
import type { CheckItem } from "./plan";
import { llmCall, type ArtemisContext } from "./session";
import type { CheckVerdict } from "./types";

type CheckerJson = Record<string, string>;
const P = checkerPrompts as CheckerJson;

export type CheckReport = { verdicts: CheckVerdict[]; unmet_subgoals: string[] };

function formatItems(items: CheckItem[]) {
  return items.map((c) => `- ${c.kind}${c.atEnd ? "@end" : ""}: ${c.text}${c.anchor ? `   (anchor: ${c.anchor})` : ""}`).join("\n");
}

/** Port of _normalize_report: verbatim quoting, evidence discipline. */
export function normalizeReport(report: CheckReport, items: CheckItem[]): CheckReport {
  const verdicts: CheckVerdict[] = [];
  for (const item of items) {
    const v = report.verdicts.find((x) => x.item_text?.trim() === item.text.trim());
    if (!v) {
      verdicts.push({ item_text: item.text, kind: item.kind, status: "inconclusive", evidence: "No verdict was returned for this item; evidence missing." });
      continue;
    }
    const failedNoEvidence = v.status === "failed" && !v.evidence?.trim();
    verdicts.push({
      item_text: item.text,
      kind: item.kind,
      status: failedNoEvidence ? "inconclusive" : v.status,
      evidence: failedNoEvidence ? "A failed verdict without concrete evidence is invalid and was downgraded." : v.evidence,
      ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    });
  }
  return { verdicts, unmet_subgoals: report.unmet_subgoals ?? [] };
}

export async function runChecker(ctx: ArtemisContext, entry: "checkpoint" | "final", items: CheckItem[], milestone?: string): Promise<CheckReport> {
  ctx.emit({ kind: "stage", stage: "checking", agent: "checker", step: ctx.step });
  const system = [P["system"], P["base_rules"], P["verify_semantics"], P["assert_semantics"], P["anchor_guide"], entry === "final" ? P["final_guide"] : ""]
    .filter(Boolean)
    .join("\n\n");
  const content: Exclude<LlmMessage["content"], string> = [
    {
      type: "text",
      text: `Goal: ${ctx.goal}\n${milestone ? `Anchored milestone: ${milestone}\n` : ""}Entry: ${entry}\n\n### Check Items\n${formatItems(items)}\n\n### Current Plan\n${ctx.notes.get("task_plan") ?? "(none)"}\n\n### Execution History\n${ctx.memory.history(60, 20)}\n\nRead-only device probes are not available in this runtime. Judge from the history, notes and the screenshot below.\n\nReturn EXACTLY this JSON: {"verdicts": [{"item_text": "<verbatim>", "kind": "verify|assert", "status": "passed|failed|inconclusive", "evidence": "<concrete>", "suggestion": "<for failed verify>"}], "unmet_subgoals": ["<milestone text>"]}`,
    },
  ];
  if (ctx.obs?.screenshotB64) content.push({ type: "text", text: "Latest screenshot:" }, imagePart(ctx.obs.screenshotB64, ctx.obs.screenshotMime));
  const reply = await llmCall(ctx, "checker", [{ role: "system", content: system }, { role: "user", content }], []);
  const parsed = extractJson<CheckReport>(reply.text) ?? { verdicts: [], unmet_subgoals: [] };
  const report = normalizeReport({ verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts : [], unmet_subgoals: Array.isArray(parsed.unmet_subgoals) ? parsed.unmet_subgoals : [] }, items);
  ctx.emit({ kind: "checker", entry, ...(milestone ? { milestone } : {}), verdicts: report.verdicts });
  return report;
}
