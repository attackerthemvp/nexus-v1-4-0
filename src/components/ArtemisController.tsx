// NEXUS addition: Artemis–NEXUS Hybrid Android Controller. Renders ONLY the
// typed events emitted by the Artemis engine — no simulated progress.
import { useMemo } from "react";
import { Square, ShieldAlert, Check, X, Smartphone, Zap, Brain } from "lucide-react";
import type { ArtemisEvent, ConfirmRequest } from "@/lib/artemis/types";

export function ArtemisController({
  events,
  pending,
  onConfirm,
  onStop,
  running,
}: {
  events: ArtemisEvent[];
  pending: ConfirmRequest | null;
  onConfirm: (approved: boolean) => void;
  onStop: () => void;
  running: boolean;
}) {
  const session = events.find((e) => e.kind === "session") as Extract<ArtemisEvent, { kind: "session" }> | undefined;
  const stage = [...events].reverse().find((e) => e.kind === "stage") as Extract<ArtemisEvent, { kind: "stage" }> | undefined;
  const shot = [...events].reverse().find((e) => e.kind === "observation" && e.screenshotB64) as Extract<ArtemisEvent, { kind: "observation" }> | undefined;
  const plan = [...events].reverse().find((e) => e.kind === "plan") as Extract<ArtemisEvent, { kind: "plan" }> | undefined;
  const terminal = events.find((e) => e.kind === "terminal") as Extract<ArtemisEvent, { kind: "terminal" }> | undefined;
  const timeline = useMemo(() => events.filter((e) => !["stage", "observation", "session", "plan"].includes(e.kind)).slice(-80), [events]);

  return (
    <div className="panel rounded-md border border-primary/50 p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Smartphone size={16} className="text-primary" />
        <span className="font-display tracking-wider text-sm text-primary text-glow">ARTEMIS · ANDROID CONTROLLER</span>
        {session && (
          <span className="rounded border border-accent px-2 py-0.5 text-xs font-mono text-accent flex items-center gap-1">
            {session.mode === "flash" ? <Zap size={12} /> : <Brain size={12} />} {session.mode.toUpperCase()}
          </span>
        )}
        <span className="text-xs font-mono text-muted-foreground">
          {terminal ? `FINISHED: ${terminal.outcome.toUpperCase()}` : stage ? `${stage.stage}${stage.agent ? ` · ${stage.agent}` : ""}${stage.step != null ? ` · step ${stage.step}` : ""}` : "starting"}
        </span>
        {running && (
          <button onClick={onStop} className="ml-auto h-9 px-4 rounded-md border border-destructive text-destructive font-display text-sm tracking-wider hover:bg-destructive/10">
            <Square size={12} className="inline mr-2" />STOP
          </button>
        )}
      </div>
      {session && <div className="text-sm font-mono text-foreground">Goal: {session.goal}</div>}

      {pending && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 space-y-2">
          <div className="flex items-center gap-2 text-destructive font-display text-sm"><ShieldAlert size={16} /> CONFIRMATION NEEDED</div>
          <div className="text-sm text-foreground">{pending.reason}</div>
          <div className="text-xs font-mono text-muted-foreground break-all">{pending.action} {JSON.stringify(pending.args)}</div>
          <div className="flex gap-2">
            <button onClick={() => onConfirm(true)} className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-display"><Check size={14} className="inline mr-1" />CONFIRM</button>
            <button onClick={() => onConfirm(false)} className="h-9 px-4 rounded-md border border-destructive text-destructive text-sm font-display"><X size={14} className="inline mr-1" />ABORT</button>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[200px_1fr]">
        <div>
          {shot?.screenshotB64 ? (
            <img src={`data:${shot.screenshotMime ?? "image/jpeg"};base64,${shot.screenshotB64}`} alt={`Phone screen at step ${shot.step}`} className="w-full rounded border border-border" />
          ) : (
            <div className="aspect-[9/16] rounded border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground p-2 text-center">No screen preview yet</div>
          )}
          {plan && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] font-mono text-muted-foreground">{plan.content}</pre>}
        </div>
        <ol className="max-h-96 overflow-y-auto space-y-1 text-xs font-mono">
          {timeline.map((e) => (
            <li key={e.id} className={lineClass(e)}>{describe(e)}</li>
          ))}
        </ol>
      </div>
      {terminal && <div className={`text-sm font-mono ${terminal.outcome === "done" ? "text-primary" : "text-destructive"}`}>{terminal.summary}</div>}
    </div>
  );
}

function lineClass(e: ArtemisEvent) {
  if (e.kind === "incident" || (e.kind === "action_result" && !e.result.ok)) return "text-destructive";
  if (e.kind === "thought") return "text-muted-foreground";
  if (e.kind === "action") return "text-accent";
  return "text-foreground";
}

function describe(e: ArtemisEvent): string {
  switch (e.kind) {
    case "thought": return `[${e.agent} #${e.step}] ${e.text.slice(0, 400)}`;
    case "action": return `▶ #${e.step} ${e.action}${e.burst ? " (burst)" : ""} ${JSON.stringify(e.args).slice(0, 200)}`;
    case "action_result": return `${e.result.ok ? "✓" : "✗"} ${e.action}: ${e.result.code} ${e.result.message.slice(0, 200)}`;
    case "validator": return `validator (${e.method}): ${e.verdict} — ${e.detail}`;
    case "incident": return `⚠ ${e.incident.kind}: ${e.incident.detail}`;
    case "checker": return `checker ${e.entry}${e.milestone ? ` «${e.milestone}»` : ""}: ${e.verdicts.map((v) => `${v.status} (${v.item_text})`).join("; ")}`;
    case "retry": return `↻ retry ${e.what} (attempt ${e.attempt})`;
    case "replan": return `plan change ${e.approved ? "approved" : "rejected"}: ${e.feedback}`;
    case "wait": return `⏳ waiting ${e.ms} ms`;
    case "confirm_request": return `? confirmation requested: ${e.request.reason}`;
    case "confirm_result": return e.approved ? "✓ you confirmed" : "✗ you aborted";
    case "llm": return `model: ${e.agent} via ${e.provider} / ${e.model}`;
    case "terminal": return `■ ${e.outcome}: ${e.summary}`;
    default: return e.kind;
  }
}
