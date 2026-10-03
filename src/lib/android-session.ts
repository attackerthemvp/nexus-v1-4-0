// Per-run Android execution state: the capability snapshot read from the
// connected phone, the last execution outcome, and a small bounded retry
// policy. Deliberately tiny — it exists so NEXUS can answer "can this phone do
// X?" and "did X actually happen?" without a workflow engine.
//
// The app/package mapping and the capability/argument contract live in
// android-apps.ts; nothing is duplicated here.
import {
  UNKNOWN_ANDROID_SNAPSHOT,
  parseAndroidStatus,
  type AndroidCapabilitySnapshot,
} from "@/lib/android-apps";

/** How many times one state-changing Android command may be dispatched. */
export const MAX_ANDROID_ACTION_ATTEMPTS = 2;
/** How many times one verification check may be repeated after an inconclusive read. */
export const MAX_ANDROID_VERIFY_ATTEMPTS = 2;

export type AndroidOutcome = {
  command: string;
  ok: boolean;
  detail: string;
};

type AttemptState = { attempts: number; lastFailure?: string; stateCheckedSinceFailure: boolean };

let snapshot: AndroidCapabilitySnapshot = UNKNOWN_ANDROID_SNAPSHOT;
let lastOutcome: AndroidOutcome | null = null;
const attempts = new Map<string, AttemptState>();

export function resetAndroidSession() {
  snapshot = UNKNOWN_ANDROID_SNAPSHOT;
  lastOutcome = null;
  attempts.clear();
}

export function getAndroidSnapshot(): AndroidCapabilitySnapshot {
  return snapshot;
}

/** Feed a phone_agent_status() tool result in; it becomes the runtime contract. */
export function recordAndroidStatus(raw: string): AndroidCapabilitySnapshot {
  snapshot = parseAndroidStatus(raw);
  return snapshot;
}

export function getLastAndroidOutcome(): AndroidOutcome | null {
  return lastOutcome;
}

export function recordAndroidOutcome(outcome: AndroidOutcome) {
  lastOutcome = outcome;
}

function signature(command: string, args: Record<string, unknown>) {
  return `${command}:${JSON.stringify(args)}`;
}

/**
 * State-aware retry gate for state-changing Android commands: a repeat is only
 * allowed after something was actually checked, and never more than
 * MAX_ANDROID_ACTION_ATTEMPTS times.
 */
export function checkAndroidRetry(
  command: string,
  args: Record<string, unknown>,
  repeatSafe: boolean,
): { allow: true } | { allow: false; error: string } {
  if (repeatSafe) return { allow: true };
  const sig = signature(command, args);
  const state = attempts.get(sig);
  if (!state) return { allow: true };
  if (state.attempts >= MAX_ANDROID_ACTION_ATTEMPTS)
    return {
      allow: false,
      error: `ANDROID_RETRY_EXHAUSTED: "${command}" already ran ${state.attempts} times with the same arguments${
        state.lastFailure ? ` and failed the same way (${state.lastFailure})` : ""
      }. Change approach or report the blocker — do not repeat it.`,
    };
  if (state.lastFailure && !state.stateCheckedSinceFailure)
    return {
      allow: false,
      error: `ANDROID_BLIND_RETRY: "${command}" failed (${state.lastFailure}) and nothing has been checked since. Inspect the state first (phone_agent_status / foreground_app / screen_read) or choose a different action.`,
    };
  return { allow: true };
}

/** Record a dispatch and its result so the retry gate stays state-aware. */
export function noteAndroidDispatch(
  command: string,
  args: Record<string, unknown>,
  ok: boolean,
  detail: string,
  repeatSafe: boolean,
) {
  const sig = signature(command, args);
  const state = attempts.get(sig) ?? { attempts: 0, stateCheckedSinceFailure: false };
  state.attempts += 1;
  if (ok) {
    delete state.lastFailure;
    state.stateCheckedSinceFailure = true;
  } else {
    state.lastFailure = detail.slice(0, 160);
    state.stateCheckedSinceFailure = false;
  }
  attempts.set(sig, state);
  recordAndroidOutcome({ command, ok, detail: detail.slice(0, 400) });
  if (repeatSafe) noteAndroidStateCheck();
}

/** Any read-only observation clears the "blind retry" flag. */
export function noteAndroidStateCheck() {
  for (const state of attempts.values()) state.stateCheckedSinceFailure = true;
}

/**
 * Guard against a report that claims an Android action succeeded when the last
 * Android execution actually failed. Returns a correction, or null when the
 * report is acceptable.
 */
export function checkAndroidCompletion(report: string): string | null {
  const outcome = lastOutcome;
  if (!outcome || outcome.ok) return null;
  if (!/succe|opened|launched|switched|done|completed|is now/i.test(report)) return null;
  return `FALSE_COMPLETION: the last Android command (${outcome.command}) failed — ${outcome.detail}. Do not report success. Either recover with a different action, verify the real state, or call finish_task again with an honest failure report.`;
}
