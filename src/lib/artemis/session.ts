// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/graph/perception.py, agents/validator/action_execution.py,
// execution_loop.py, incidents.py — Copyright 2026 Google LLC. Apache License 2.0.
// Modified for NEXUS: Python -> TypeScript; shared run context, observation,
// cancellation-safe boundaries, confirmation gate and typed event emission.

import type { AndroidAgentActuator } from "./actuator";
import { indexElements, parseHierarchy, renderElementList, type IndexedElement } from "./hierarchy";
import type { ArtemisLLM, LlmMessage } from "./llm";
import { NoteStore, StepMemory } from "./memory";
import { riskReason } from "./risk";
import { ArtemisCancelled, type ActionResult, type ArtemisEventInput, type ArtemisMode, type ConfirmRequest, type Incident, type Observation } from "./types";
import { validatePrecondition } from "./validator";

export type ArtemisContext = {
  goal: string;
  mode: ArtemisMode;
  llm: ArtemisLLM;
  actuator: AndroidAgentActuator;
  notes: NoteStore;
  memory: StepMemory;
  incidents: Incident[];
  emit: (e: ArtemisEventInput) => void;
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  signal?: AbortSignal;
  step: number;
  obs: Observation | null;
  elements: IndexedElement[];
  /** Draws the red target dot for the pixel safety net; null when unavailable (tests/SSR). */
  markTarget?: (b64: string, mime: string, norm: [number, number]) => Promise<string | null>;
};

/** Cancellation-safe boundary: called before every model call and device action. */
export function checkCancel(ctx: ArtemisContext) {
  if (ctx.signal?.aborted) throw new ArtemisCancelled();
}

export async function llmCall(ctx: ArtemisContext, agent: string, messages: LlmMessage[], tools: unknown[]) {
  checkCancel(ctx);
  const reply = await ctx.llm.call(agent, messages, tools);
  checkCancel(ctx);
  ctx.emit({ kind: "llm", agent, provider: reply.provider, model: reply.model });
  return reply;
}

export async function observe(ctx: ArtemisContext, summary?: string): Promise<Observation> {
  checkCancel(ctx);
  ctx.emit({ kind: "stage", stage: "observing", step: ctx.step });
  const obs = await ctx.actuator.observe();
  ctx.obs = obs;
  ctx.elements = obs.xml ? indexElements(parseHierarchy(obs.xml), obs.width, obs.height) : [];
  ctx.emit({
    kind: "observation",
    step: ctx.step,
    ...(obs.screenshotB64 ? { screenshotB64: obs.screenshotB64, screenshotMime: obs.screenshotMime ?? "image/jpeg" } : {}),
    elements: ctx.elements.length,
    ...(obs.foregroundPackage ? { foreground: obs.foregroundPackage } : {}),
    ...(summary ? { summary } : {}),
  });
  return obs;
}

export function observationText(ctx: ArtemisContext): string {
  const o = ctx.obs;
  const head = o ? `Screen ${o.width}x${o.height}${o.foregroundPackage ? `, foreground app: ${o.foregroundPackage}` : ""}.` : "No observation.";
  return `${head}\nVisible UI Elements (index, class, label, normalized 0-1000 center):\n${renderElementList(ctx.elements)}`;
}

export function incident(ctx: ArtemisContext, kind: Incident["kind"], detail: string) {
  const inc: Incident = { kind, detail, step: ctx.step };
  ctx.incidents.push(inc);
  ctx.emit({ kind: "incident", incident: inc });
}

/** Resolve an element-index target into normalized coordinates (agent → wire dialect). */
export function resolveTarget(ctx: ArtemisContext, target: unknown): { coords: [number, number] | null; element: IndexedElement | null; error?: string } {
  if (typeof target === "number") {
    const el = ctx.elements[target];
    if (!el) return { coords: null, element: null, error: `TARGET_NOT_FOUND: element index ${target} is not in the current indexed list.` };
    return { coords: el.center, element: el };
  }
  if (Array.isArray(target) && target.length === 2 && target.every((n) => typeof n === "number")) {
    return { coords: [target[0] as number, target[1] as number], element: null };
  }
  return { coords: null, element: null };
}

async function gate(ctx: ArtemisContext, action: string, args: Record<string, unknown>, label?: string) {
  const reason = riskReason(action, { args, ...(label ? { targetLabel: label } : {}) });
  if (!reason) return true;
  const req: ConfirmRequest = { id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, action, args, reason };
  ctx.emit({ kind: "stage", stage: "awaiting_confirmation", step: ctx.step });
  ctx.emit({ kind: "confirm_request", request: req });
  const approved = await ctx.confirm(req);
  ctx.emit({ kind: "confirm_result", requestId: req.id, approved });
  checkCancel(ctx);
  return approved;
}

export type ExecOutcome = { result: ActionResult; aborted?: boolean };

/**
 * Execute one agent-dialect action. `vetted` runs the Validator safety net
 * (XML-first precondition, pixel fallback, one dispatch retry). Bursts are unvetted.
 */
export async function executeAction(
  ctx: ArtemisContext,
  agent: string,
  action: string,
  rawArgs: Record<string, unknown>,
  opts: { vetted: boolean; thought: string },
): Promise<ExecOutcome> {
  checkCancel(ctx);
  let args = { ...rawArgs };
  let refElement: IndexedElement | null = null;
  if ("target" in args && action !== "swipe") {
    const r = resolveTarget(ctx, args["target"]);
    if (r.error) return record(ctx, agent, action, rawArgs, opts.thought, { ok: false, code: "TARGET_NOT_FOUND", message: r.error });
    if (r.coords) {
      args["target"] = r.coords;
      refElement = r.element;
    }
  }
  if (action === "click_sequence" && Array.isArray(args["sequence"]) && (args["sequence"] as unknown[]).some((p) => !Array.isArray(p)))
    return record(ctx, agent, action, rawArgs, opts.thought, { ok: false, code: "INVALID_ARGS", message: "click_sequence entries must be normalized [x, y] pairs; element indexes are refused." });

  const label = refElement ? (refElement.text || refElement.contentDesc) : undefined;
  if (!(await gate(ctx, action, args, label))) {
    return { ...record(ctx, agent, action, rawArgs, opts.thought, { ok: false, code: "INVALID_ARGS", message: "The user aborted this step at the confirmation prompt." }), aborted: true };
  }

  if (opts.vetted && Array.isArray(args["target"])) {
    ctx.emit({ kind: "stage", stage: "validating", agent: "validator", step: ctx.step });
    const pre = await validatePrecondition(ctx, action, args["target"] as [number, number], refElement, opts.thought, args);
    ctx.emit({ kind: "validator", step: ctx.step, method: pre.method, verdict: pre.verdict, detail: pre.detail });
    if (pre.verdict === "blocked") {
      return record(ctx, agent, action, rawArgs, opts.thought, { ok: false, code: "TARGET_NOT_FOUND", message: `Safety net blocked the action: ${pre.detail}` });
    }
    if (pre.verdict === "healed" && pre.coords) {
      incident(ctx, "coordinate_healed", `${action} target moved to [${pre.coords.join(", ")}]: ${pre.detail}`);
      args["target"] = pre.coords;
    }
  }

  checkCancel(ctx);
  ctx.emit({ kind: "stage", stage: "executing", agent, step: ctx.step });
  ctx.emit({ kind: "action", step: ctx.step, action, args, ...(opts.vetted ? {} : { burst: true }) });
  if (action === "wait_for_delay") ctx.emit({ kind: "wait", step: ctx.step, ms: Number(args["time_in_ms"] ?? 0) });
  const wire = { ...args };
  delete wire["target_description"];
  delete wire["target_descriptions"];
  let result = await ctx.actuator.execute(action, wire);
  if (!result.ok && opts.vetted && result.code === "DEVICE_ERROR") {
    // "a flaky dispatch is retried once"
    ctx.emit({ kind: "retry", step: ctx.step, what: action, attempt: 2 });
    incident(ctx, "dispatch_retried", `${action}: ${result.message}`);
    checkCancel(ctx);
    result = await ctx.actuator.execute(action, wire);
  }
  if (!result.ok) incident(ctx, result.code === "UNSUPPORTED" ? "unsupported_action" : "dispatch_failed", `${action}: ${result.code} ${result.message}`);
  return record(ctx, agent, action, rawArgs, opts.thought, result);
}

function record(ctx: ArtemisContext, agent: string, action: string, args: Record<string, unknown>, thought: string, result: ActionResult): ExecOutcome {
  ctx.emit({ kind: "action_result", step: ctx.step, action, result });
  ctx.memory.add({ step: ctx.step, agent, thought, action, args, result: `${result.code}: ${result.message}`, ts: Date.now() });
  return { result };
}
