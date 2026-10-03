// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/graph/graph.py (run lifecycle, terminal outcomes) — Copyright 2026 Google LLC.
// Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: explicit lifecycle; the manually selected mode is fixed for
// the whole run; every state change is emitted as a typed event.

import { AndroidAgentActuator, negotiateCapabilities, type PhoneTransport } from "./actuator";
import { runFlash } from "./flash";
import type { ArtemisLLM } from "./llm";
import { ActuatorContractError, validateCapabilities } from "./manifest";
import { NoteStore, StepMemory } from "./memory";
import { runPro } from "./pro";
import type { ArtemisContext } from "./session";
import { ArtemisCancelled, type ArtemisEvent, type ArtemisEventInput, type ArtemisMode, type ArtemisOutcome, type ConfirmRequest } from "./types";

export type RunOptions = {
  goal: string;
  mode: ArtemisMode;
  llm: ArtemisLLM;
  transport: PhoneTransport;
  /** Capability names the phone advertised (phone_agent_status). */
  advertised: string[];
  onEvent: (e: ArtemisEvent) => void;
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  signal?: AbortSignal;
  markTarget?: ArtemisContext["markTarget"];
  sleep?: (ms: number) => Promise<void>;
};

export type RunResult = { outcome: ArtemisOutcome; summary: string; steps: number };

let seq = 0;

export async function runArtemis(o: RunOptions): Promise<RunResult> {
  const mode: ArtemisMode = o.mode; // frozen: nothing below may reassign it
  const emit = (e: ArtemisEventInput) => o.onEvent({ ...(e as object), id: `ae_${Date.now()}_${++seq}`, ts: Date.now() } as ArtemisEvent);
  const caps = negotiateCapabilities(o.advertised);
  emit({ kind: "session", mode, goal: o.goal, capabilities: [...caps.actions] });
  emit({ kind: "stage", stage: "starting" });

  const ctx: ArtemisContext = {
    goal: o.goal,
    mode,
    llm: o.llm,
    actuator: new AndroidAgentActuator(o.transport, caps, o.sleep),
    notes: new NoteStore(),
    memory: new StepMemory(),
    incidents: [],
    emit,
    confirm: o.confirm,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.markTarget ? { markTarget: o.markTarget } : {}),
    step: 0,
    obs: null,
    elements: [],
  };

  let res: { outcome: ArtemisOutcome; summary: string };
  try {
    validateCapabilities(caps.actions, mode);
    res = mode === "flash" ? await runFlash(ctx) : await runPro(ctx);
  } catch (e) {
    if (e instanceof ArtemisCancelled || o.signal?.aborted || (e as Error)?.name === "AbortError")
      res = { outcome: "stopped", summary: "Stopped by you. The task was not completed." };
    else if (e instanceof ActuatorContractError) {
      emit({ kind: "incident", incident: { kind: "capability_missing", detail: e.message, step: ctx.step } });
      res = { outcome: "needs_user", summary: e.message };
    } else res = { outcome: "stuck", summary: `Engine error: ${(e as Error)?.message ?? String(e)}` };
  }
  emit({ kind: "stage", stage: "finished" });
  emit({ kind: "terminal", outcome: res.outcome, summary: res.summary });
  return { ...res, steps: ctx.memory.steps.length };
}
