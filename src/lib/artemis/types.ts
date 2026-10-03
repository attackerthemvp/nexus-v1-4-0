// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/graph/state.py — Copyright 2026 Google LLC. Apache License, Version 2.0.
// Modified for NEXUS: TypeScript state + typed live events for the controller UI.

export type ArtemisMode = "flash" | "pro";
export type ArtemisOutcome = "done" | "stuck" | "needs_user" | "stopped";

export type ArtemisStage =
  | "starting"
  | "observing"
  | "planning"
  | "operating"
  | "validating"
  | "executing"
  | "checking"
  | "summarizing"
  | "waiting"
  | "awaiting_confirmation"
  | "finished";

export type Observation = {
  screenshotB64?: string;
  screenshotMime?: string;
  xml?: string;
  width: number;
  height: number;
  foregroundPackage?: string;
  ts: number;
  skewMs?: number;
};

export type ActionResult = { ok: boolean; code: string; message: string; data?: unknown };

export type Incident = {
  kind:
    | "target_missing"
    | "coordinate_healed"
    | "pixel_blocked"
    | "dispatch_failed"
    | "dispatch_retried"
    | "plan_rejected"
    | "check_failed"
    | "unsupported_action"
    | "capability_missing";
  detail: string;
  step: number;
};

export type ConfirmRequest = { id: string; action: string; args: Record<string, unknown>; reason: string };

export type ArtemisEvent = { id: string; ts: number } & (
  | { kind: "session"; mode: ArtemisMode; goal: string; capabilities: string[] }
  | { kind: "stage"; stage: ArtemisStage; agent?: string; step?: number }
  | { kind: "observation"; step: number; screenshotB64?: string; screenshotMime?: string; elements: number; foreground?: string; summary?: string }
  | { kind: "thought"; agent: string; step: number; text: string }
  | { kind: "plan"; content: string; reason: "initial" | "update" | "reopen" }
  | { kind: "action"; step: number; action: string; args: Record<string, unknown>; burst?: boolean }
  | { kind: "action_result"; step: number; action: string; result: ActionResult }
  | { kind: "validator"; step: number; method: "xml" | "pixel" | "skipped"; verdict: "pass" | "healed" | "blocked"; detail: string }
  | { kind: "incident"; incident: Incident }
  | { kind: "checker"; entry: "checkpoint" | "final"; milestone?: string; verdicts: CheckVerdict[] }
  | { kind: "retry"; step: number; what: string; attempt: number }
  | { kind: "replan"; step: number; approved: boolean; feedback: string }
  | { kind: "wait"; step: number; ms: number }
  | { kind: "confirm_request"; request: ConfirmRequest }
  | { kind: "confirm_result"; requestId: string; approved: boolean }
  | { kind: "llm"; agent: string; provider: string; model: string }
  | { kind: "terminal"; outcome: ArtemisOutcome; summary: string }
);

export type ArtemisEventInput = ArtemisEvent extends infer E ? (E extends ArtemisEvent ? Omit<E, "id" | "ts"> : never) : never;

export type CheckVerdict = {
  item_text: string;
  kind: "verify" | "assert";
  status: "passed" | "failed" | "inconclusive";
  evidence: string;
  suggestion?: string;
};

export type StepRecord = {
  step: number;
  agent: string;
  thought: string;
  action: string;
  args: Record<string, unknown>;
  result: string;
  summary?: string;
  ts: number;
};

export class ArtemisCancelled extends Error {
  constructor() {
    super("Artemis run cancelled by the user.");
  }
}
