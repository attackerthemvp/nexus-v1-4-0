// Coding panel actions: git workflow + tests/build runs.
// Results are streamed into the active chat as tool cards and into the agent log.

import { executeTool } from "@/lib/jarvis-agent";
import { logAgent } from "@/lib/agent-log";
import { getSettings } from "@/lib/settings-store";
import type { ToolCallRecord } from "@/lib/chat-store";

export const TOOL_CARD_EVENT = "nexus:tool-card";

export type ToolCardEvent = { id: string; record: ToolCallRecord };

function newCardId() {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Push (or replace) a tool card in the active chat transcript. */
export function pushToolCard(record: ToolCallRecord, id = newCardId()): string {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ToolCardEvent>(TOOL_CARD_EVENT, { detail: { id, record: { ...record, id } } }),
    );
  }
  return id;
}

/** Resolve the folder git/build actions should run in. */
export function workspacePath(): string {
  const { workspaceRoot, activeProject } = getSettings().coding;
  if (!workspaceRoot) return "";
  if (!activeProject) return workspaceRoot;
  const sep = workspaceRoot.includes("\\") ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/, "")}${sep}${activeProject}`;
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const started = Date.now();
  const result = await executeTool(name, args);
  logAgent({
    kind: result.startsWith("ERROR") ? "error" : "tool",
    label: name,
    args,
    ok: !result.startsWith("ERROR"),
    durationMs: Date.now() - started,
    detail: result.slice(0, 600),
  });
  return result;
}

/** Single tool call rendered as its own chat card. */
async function runToolCarded(name: string, args: Record<string, unknown>): Promise<string> {
  const id = pushToolCard({ name, args, result: "Running…" });
  const result = await runTool(name, args);
  pushToolCard({ name, args, result }, id);
  return result;
}

export type GitWorkflowOptions = {
  message: string;
  branch?: string;
  createBranch?: boolean;
  push?: boolean;
};

export type GitWorkflowResult = { ok: boolean; summary: string };

/** branch (optional) → status → commit → push (optional, confirmed by the caller). */
export async function runGitWorkflow(opts: GitWorkflowOptions): Promise<GitWorkflowResult> {
  const repo = workspacePath();
  const coding = getSettings().coding;
  if (!coding.enabled) return { ok: false, summary: "Coding toolkit is disabled." };
  if (!coding.gitEnabled) return { ok: false, summary: "Git actions are disabled in settings." };
  if (!repo) return { ok: false, summary: "Set a workspace root first." };
  if (!opts.message.trim()) return { ok: false, summary: "A commit message is required." };

  logAgent({ kind: "status", label: "git workflow", detail: `repo ${repo}` });

  if (opts.branch?.trim()) {
    const out = await runToolCarded("git_branch", {
      repo,
      branch: opts.branch.trim(),
      create: !!opts.createBranch,
    });
    if (out.startsWith("ERROR")) return { ok: false, summary: `Branch failed: ${out}` };
  }

  await runToolCarded("git_status", { repo });

  const commit = await runToolCarded("git_commit", { repo, message: opts.message.trim() });
  if (commit.startsWith("ERROR")) return { ok: false, summary: `Commit failed: ${commit}` };

  if (opts.push) {
    if (!coding.allowPush) return { ok: false, summary: "Committed. Push is disabled in settings." };
    const push = await runToolCarded("git_push", {
      repo,
      ...(opts.branch?.trim() ? { branch: opts.branch.trim() } : {}),
    });
    if (push.startsWith("ERROR")) return { ok: false, summary: `Committed, push failed: ${push}` };
    return { ok: true, summary: "Committed and pushed." };
  }

  return { ok: true, summary: "Committed locally." };
}

/** Start a build/test command in the background and stream its output into one chat card. */
export async function runProjectCommand(
  command: string,
  label = command,
): Promise<{ ok: boolean; summary: string }> {
  const cwd = workspacePath();
  const coding = getSettings().coding;
  if (!coding.enabled) return { ok: false, summary: "Coding toolkit is disabled." };
  if (!cwd) return { ok: false, summary: "Set a workspace root first." };

  const args = { command, cwd, timeout_sec: coding.commandTimeoutSec };
  const cardId = pushToolCard({ name: label, args, result: "Starting…" });
  logAgent({ kind: "status", label: "run", detail: `${command} (${cwd})` });

  const started = await runTool("run_command_bg", { command, cwd });
  let jobId = "";
  try {
    jobId = JSON.parse(started)?.job_id ?? "";
  } catch {
    /* non-JSON means the agent errored */
  }
  if (!jobId) {
    pushToolCard({ name: label, args, result: started || "ERROR: could not start command" }, cardId);
    return { ok: false, summary: "Could not start the command." };
  }

  const deadline = Date.now() + Math.max(30, coding.commandTimeoutSec) * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const statusRaw = await executeTool("command_status", { job_id: jobId });
    let running = false;
    let exitCode: number | null = null;
    let output = statusRaw;
    try {
      const parsed = JSON.parse(statusRaw);
      running = !!parsed.running;
      exitCode = parsed.exit_code ?? null;
      output = parsed.output ?? "";
    } catch {
      running = false;
    }
    last = output;
    logAgent({
      kind: "poll",
      label: "command_status",
      detail: `${jobId} ${running ? "running" : `exit ${exitCode}`}`,
      ok: running || exitCode === 0,
    });
    pushToolCard(
      {
        name: label,
        args,
        result: running
          ? `RUNNING (${jobId})\n\n${output}`
          : exitCode === 0
            ? `DONE exit 0\n\n${output}`
            : `ERROR exit ${exitCode}\n\n${output}`,
      },
      cardId,
    );
    if (!running) {
      return exitCode === 0
        ? { ok: true, summary: `${label} passed.` }
        : { ok: false, summary: `${label} failed (exit ${exitCode}).` };
    }
  }

  await executeTool("command_status", { job_id: jobId, stop: true });
  pushToolCard({ name: label, args, result: `ERROR: timed out\n\n${last}` }, cardId);
  return { ok: false, summary: `${label} timed out.` };
}
