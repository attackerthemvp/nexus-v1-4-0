import type { ChatMessage, ToolCallRecord } from "./chat-store";
import { isRepeatSafeToolCall } from "./tool-policy";

export const DEFAULT_MAX_AGENT_STEPS = 50;
export const DEFAULT_MAX_RUN_MS = 15 * 60_000;
export const DEFAULT_MAX_IDENTICAL_CALLS = 3;
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_EMPTY_REPLIES = 3;
export const DEFAULT_MAX_CONTINUE_NUDGES = 2;


const CONTROL_TOOLS = new Set(["finish_task", "request_user_input"]);
const NON_OPERATIONAL_TOOLS = new Set(["remember_fact", "forget_fact", "recall_memories"]);

type ModelPayload = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments?: string };
      }>;
    };
  }>;
  _nexus?: { providerName: string; modelLabel: string };
};

export type ToolExecution = {
  content: string;
  attachment?: ChatMessage;
};

export type AgentRunStatus = "completed" | "blocked" | "exhausted" | "aborted";

export type AgentRunResult = {
  status: AgentRunStatus;
  history: ChatMessage[];
  finalText: string;
  steps: number;
};

export type AgentRunOptions = {
  initialHistory: ChatMessage[];
  callModel: (history: ChatMessage[]) => Promise<ModelPayload>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecution>;
  onUpdate?: (history: ChatMessage[], view?: ChatMessage[]) => void;
  onStatus?: (status: string) => void;
  onModelMeta?: (meta: { providerName: string; modelLabel: string }) => void;
  maxSteps?: number;
  maxRunMs?: number;
  maxIdenticalCalls?: number;
  /** Hard ceiling for a single tool call so a hung agent can never freeze the run. */
  toolTimeoutMs?: number;
  /** Consecutive empty model replies tolerated before the run stops with an explanation. */
  maxEmptyReplies?: number;
  /**
   * How many times the controller nudges a narrating model before accepting its
   * prose as the final answer. Prevents the user having to drive the loop.
   */
  maxContinueNudges?: number;
  /** Lets the UI cancel a run (Stop button). */
  signal?: AbortSignal;
  now?: () => number;
  /** Override for which calls may repeat freely (defaults to tool-policy's list). */
  isRepeatSafe?: (name: string, args: Record<string, unknown>) => boolean;
  /**
   * Last-line check on a finish_task report. Return a correction string to
   * reject a report that contradicts the recorded tool outcomes, or null to
   * accept it. Applied at most once per run.
   */
  checkCompletion?: (report: string) => string | null;
};


type ParsedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Malformed model JSON must NEVER become `{}` — an empty argument object silently
 * turns "open WhatsApp" into an argument-less command. It becomes an explicit
 * validation failure the model can correct instead.
 */
function parseArgs(raw?: string): ParsedArgs {
  if (raw == null || raw.trim() === "") return { ok: true, args: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: `INVALID_TOOL_ARGUMENTS: the arguments were not valid JSON (${
        e instanceof Error ? e.message : String(e)
      }). Nothing was executed. Re-send this tool call with a valid JSON object. Raw arguments: ${raw.slice(0, 300)}`,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      error: `INVALID_TOOL_ARGUMENTS: the arguments must be a JSON object, received ${
        Array.isArray(value) ? "an array" : typeof value
      }. Nothing was executed. Re-send this tool call with a valid JSON object.`,
    };
  return { ok: true, args: value as Record<string, unknown> };
}

function controlText(args: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function interruption(reason: string) {
  return `**Task paused safely:** ${reason}\n\nYour progress and tool results were saved in this chat. Send **continue** to resume from this point.`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} did not respond within ${Math.round(ms / 1000)}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}


export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const maxRunMs = options.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const maxIdenticalCalls = options.maxIdenticalCalls ?? DEFAULT_MAX_IDENTICAL_CALLS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxEmptyReplies = options.maxEmptyReplies ?? DEFAULT_MAX_EMPTY_REPLIES;
  const maxContinueNudges = options.maxContinueNudges ?? DEFAULT_MAX_CONTINUE_NUDGES;
  let continueNudges = 0;
  let completionCorrections = 0;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const callCounts = new Map<string, number>();
  let repeatStreak: { signature: string; count: number; lastResult: string | undefined; sameResults: number } = {
    signature: "",
    count: 0,
    lastResult: undefined,
    sameResults: 0,
  };
  let history = [...options.initialHistory];
  let usedOperationalTool = false;
  let emptyReplies = 0;

  const stop = (status: AgentRunStatus, finalText: string, steps: number): AgentRunResult => {
    history = [...history, { role: "assistant", content: finalText, ts: now() }];
    options.onUpdate?.(history);
    return { status, history, finalText, steps };
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (options.signal?.aborted) {
      return stop(
        "aborted",
        "**Run stopped.** I halted the task at your request. Everything done so far is saved in this chat — send **continue** to resume.",
        step - 1,
      );
    }
    if (now() - startedAt >= maxRunMs) {
      return stop(
        "exhausted",
        interruption(`the ${Math.round(maxRunMs / 60_000)}-minute safety limit was reached`),
        step - 1,
      );
    }

    options.onStatus?.(`Processing step ${step}…`);
    const data = await options.callModel(history);
    if (data._nexus) options.onModelMeta?.(data._nexus);
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("No response from model");
    const toolCalls = message.tool_calls ?? [];

    if (!toolCalls.length) {
      const text = message.content?.trim() || "";
      if (!usedOperationalTool && text) {
        return stop("completed", text, step);
      }

      if (!text) {
        // A silent model reply is the classic "frozen agent". Retry a few times,
        // then stop with a real explanation instead of hanging or saying nothing.
        emptyReplies++;
        if (emptyReplies >= maxEmptyReplies) {
          return stop(
            usedOperationalTool ? "exhausted" : "completed",
            interruption(
              `the model returned ${emptyReplies} empty responses in a row (usually an overloaded provider or an oversized conversation)`,
            ),
            step,
          );
        }
        history = [
          ...history,
          {
            role: "user",
            content:
              "[NEXUS execution controller] Your last response was empty. Reply with a tool call that advances the task, or call finish_task / request_user_input.",
            internal: true,
            ts: now(),
          },
        ];
        options.onUpdate?.(history);
        continue;
      }

      emptyReplies = 0;
      // Once an operational run begins, prose is a checkpoint, not an implicit
      // completion. This prevents future-tense narration from ending the run.
      // The nudge is internal (never shown in chat) and limited: after
      // maxContinueNudges the prose IS the answer, so the user never has to
      // drive the loop by hand.
      if (continueNudges >= maxContinueNudges) {
        return stop("completed", text, step);
      }
      continueNudges++;
      history = [
        ...history,
        { role: "assistant", content: text, ts: now() },
        {
          role: "user",
          content:
            "[NEXUS execution controller] Continue the current task now. Do not narrate a future step and stop. Use tools until verified, then call finish_task. Call request_user_input only for a genuine blocker.",
          internal: true,
          ts: now(),
        },
      ];
      options.onUpdate?.(history);
      continue;
    }

    emptyReplies = 0;


    history = [
      ...history,
      { role: "assistant", content: message.content || "", tool_calls: toolCalls, ts: now() },
    ];
    const records: ToolCallRecord[] = [];

    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      const parsed = parseArgs(toolCall.function.arguments);

      // Malformed arguments abort THIS call: nothing is dispatched and the model
      // is told exactly what to fix.
      if (!parsed.ok) {
        records.push({ name, args: {}, result: parsed.error });
        history = [
          ...history,
          { role: "tool", tool_call_id: toolCall.id, content: parsed.error, ts: now() },
        ];
        continue;
      }
      const args = parsed.args;

      if (name === "finish_task") {
        const finalText = controlText(
          args,
          ["report", "summary"],
          "Task completed. No final report was provided.",
        );
        // A report is only a report: reject one blatant false success (bounded to
        // a single correction so this can never become its own loop).
        const problem = completionCorrections < 1 ? options.checkCompletion?.(finalText) : null;
        if (problem) {
          completionCorrections++;
          records.push({ name, args, result: problem });
          history = [
            ...history,
            { role: "tool", tool_call_id: toolCall.id, content: problem, ts: now() },
          ];
          continue;
        }
        history = [
          ...history,
          { role: "tool", tool_call_id: toolCall.id, content: "Completion recorded.", ts: now() },
          { role: "assistant", content: finalText, ts: now() },
        ];
        options.onUpdate?.(history);
        return { status: "completed", history, finalText, steps: step };
      }

      if (name === "request_user_input") {
        const finalText = controlText(
          args,
          ["question", "reason"],
          "I need additional information before I can continue.",
        );
        history = [
          ...history,
          { role: "tool", tool_call_id: toolCall.id, content: "User input requested.", ts: now() },
          { role: "assistant", content: finalText, ts: now() },
        ];
        options.onUpdate?.(history);
        return { status: "blocked", history, finalText, steps: step };
      }

      if (options.signal?.aborted) {
        return stop(
          "aborted",
          "**Run stopped.** I halted the task at your request. Everything done so far is saved in this chat — send **continue** to resume.",
          step,
        );
      }

      if (!NON_OPERATIONAL_TOOLS.has(name)) usedOperationalTool = true;
      options.onStatus?.(`Step ${step}: running ${name}`);

      const signature = `${name}:${JSON.stringify(args)}`;
      const repeatSafe = (options.isRepeatSafe ?? isRepeatSafeToolCall)(name, args);
      let blocked = false;
      if (repeatSafe) {
        // Harmless repeats (home, status/state checks) are allowed. Only a
        // back-to-back streak of the same call returning the same result is a
        // genuine stuck loop.
        if (repeatStreak.signature === signature) repeatStreak.count++;
        else repeatStreak = { signature, count: 1, lastResult: undefined, sameResults: 0 };
        blocked = repeatStreak.sameResults >= maxIdenticalCalls;
      } else {
        const count = (callCounts.get(signature) ?? 0) + 1;
        callCounts.set(signature, count);
        blocked = count > maxIdenticalCalls;
      }
      let execution: ToolExecution;
      if (blocked) {
        execution = {
          content: repeatSafe
            ? `ERROR: ${name} was repeated ${repeatStreak.sameResults + 1} times in a row with an unchanged result. The state is not changing — stop re-checking, use a different action, or report the blocker.`
            : `ERROR: Repeated identical tool call blocked after ${maxIdenticalCalls} executions. Diagnose the loop and use a different action or report a blocker.`,
        };
      } else {
        // A tool must never hang the run: cap it and surface a readable error the
        // model can react to.
        const budget =
          typeof args["timeout_sec"] === "number"
            ? Math.max(toolTimeoutMs, (args["timeout_sec"] as number) * 1000 + 30_000)
            : toolTimeoutMs;
        try {
          execution = await withTimeout(options.executeTool(name, args), budget, name);
        } catch (e) {
          execution = {
            content: `ERROR: ${name} failed — ${e instanceof Error ? e.message : String(e)}. Investigate and try a different approach.`,
          };
        }
      }

      if (repeatSafe && !blocked) {
        // State-aware: a repeat only counts against the guard when the world
        // did not change (identical result to the previous identical call).
        if (repeatStreak.lastResult === execution.content) repeatStreak.sameResults++;
        else repeatStreak.sameResults = 0;
        repeatStreak.lastResult = execution.content;
      } else if (!repeatSafe) {
        repeatStreak = { signature: "", count: 0, lastResult: undefined, sameResults: 0 };
      }

      records.push({ name, args, result: execution.content });
      history = [
        ...history,
        { role: "tool", tool_call_id: toolCall.id, content: execution.content, ts: now() },
      ];
      if (execution.attachment) history = [...history, execution.attachment];
    }

    options.onUpdate?.(history, [
      ...history,
      { role: "assistant", content: "", display: { tools: records }, ts: now() },
    ]);
  }

  const finalText = interruption(`the ${maxSteps}-step safety budget was reached`);
  history = [...history, { role: "assistant", content: finalText, ts: now() }];
  options.onUpdate?.(history);
  return { status: "exhausted", history, finalText, steps: maxSteps };
}