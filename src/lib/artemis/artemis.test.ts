import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { negotiateCapabilities, normalizeResult } from "./actuator";
import { runArtemis } from "./engine";
import type { ArtemisLLM, LlmReply } from "./llm";
import { parseRouterReply, routeDeterministic } from "./request-router";
import type { ArtemisEvent } from "./types";

const FULL = ["snapshot", "click", "click_sequence", "input_text", "swipe", "press_key", "open_app", "long_press", "get_ui_hierarchy"];
const XML = `<hierarchy><node class="android.widget.Button" text="Send" bounds="[0,0][100,100]" clickable="true"/></hierarchy>`;

function scripted(replies: Array<Partial<LlmReply>>): ArtemisLLM & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    async call(agent) {
      calls.push(agent);
      if (agent === "flash-summarizer") return { text: "summary", toolCalls: [], provider: "mock", model: "m" };
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return { text: r.text ?? "", toolCalls: r.toolCalls ?? [], provider: "mock", model: "m" };
    },
  };
}
const tc = (name: string, args: Record<string, unknown>) => ({ id: `t${Math.random()}`, name, args, raw: JSON.stringify(args) });
const transport = async (cmd: string) =>
  cmd === "snapshot" || cmd === "get_ui_hierarchy" ? JSON.stringify({ ok: true, code: "OK", width: 1000, height: 1000, xml: XML }) : JSON.stringify({ ok: true, code: "OK", message: "ok" });

describe("android request router", () => {
  it("classifies obvious cases deterministically", () => {
    expect(routeDeterministic("Open WhatsApp and message Mom hi")).toBe("ANDROID");
    expect(routeDeterministic("What is the capital of France?")).toBe("NORMAL");
    expect(routeDeterministic("open vscode on my pc")).toBe("NORMAL");
    expect(parseRouterReply("ambiguous")).toBe("AMBIGUOUS");
  });
  it("keeps desktop references on the PC", () => {
    expect(routeDeterministic("In this exact Chrome tab you have to open Spotify.")).toBe("NORMAL");
    expect(routeDeterministic("In this exact Chrome tab open Spotify", "android")).toBe("NORMAL");
    expect(routeDeterministic("click play in this window")).toBe("NORMAL");
    expect(routeDeterministic("what's on my screen")).toBe("NORMAL");
    expect(routeDeterministic("open spotify")).not.toBe("ANDROID");
    expect(routeDeterministic("open chrome")).not.toBe("ANDROID");
  });
  it("uses device continuity", () => {
    expect(routeDeterministic("now open spotify", "pc")).toBe("NORMAL");
    expect(routeDeterministic("Now do that on my phone", "pc")).toBe("ANDROID");
    expect(routeDeterministic("open spotify", "android")).toBe("ANDROID");
  });
});

describe("capability negotiation", () => {
  it("maps aliases and marks degraded parity", () => {
    const c = negotiateCapabilities(["tap", "home", "back", "open_app", "screenshot", "dump_ui"]);
    expect(c.actions.has("click")).toBe(true);
    expect(c.parity["press_key"]).toBe("degraded");
    expect(c.parity["manage_app"]).toBe("degraded");
    expect(c.actions.has("click_sequence")).toBe(false);
  });
  it("normalizes result envelopes", () => {
    expect(normalizeResult("ERROR (504): phone did not answer").code).toBe("TIMEOUT");
    expect(normalizeResult('{"ok":false,"code":"TARGET_NOT_FOUND","message":"x"}').ok).toBe(false);
  });
});

describe("artemis flash lifecycle", () => {
  it("runs to done via report_task_status and emits a real timeline", async () => {
    const events: ArtemisEvent[] = [];
    const llm = scripted([{ toolCalls: [tc("click_sequence", { sequence: [[500, 500]], target_descriptions: ["icon"] })] }, { toolCalls: [tc("report_task_status", { status: "completed", explanation: "ok" })] }]);
    const res = await runArtemis({ goal: "g", mode: "flash", llm, transport, advertised: FULL, onEvent: (e) => events.push(e), confirm: async () => true, sleep: async () => {} });
    expect(res.outcome).toBe("done");
    expect(events.some((e) => e.kind === "action")).toBe(true);
    expect(events.at(-1)?.kind).toBe("terminal");
    expect((events[0] as Extract<ArtemisEvent, { kind: "session" }>).mode).toBe("flash");
  });

  it("pauses for confirmation on risky steps and stops on abort", async () => {
    const llm = scripted([{ toolCalls: [tc("click", { target: [50, 50], target_description: "Send button" })] }]);
    let asked = false;
    const res = await runArtemis({ goal: "g", mode: "flash", llm, transport, advertised: FULL, onEvent: () => {}, confirm: async () => ((asked = true), false), sleep: async () => {} });
    expect(asked).toBe(true);
    expect(res.outcome).toBe("needs_user");
  });

  it("reports stopped, never success, when cancelled", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await runArtemis({ goal: "g", mode: "flash", llm: scripted([{}]), transport, advertised: FULL, onEvent: () => {}, confirm: async () => true, signal: ctrl.signal });
    expect(res.outcome).toBe("stopped");
  });

  it("needs_user when Flash's required click_sequence is missing (never switches to Pro)", async () => {
    const events: ArtemisEvent[] = [];
    const res = await runArtemis({ goal: "g", mode: "flash", llm: scripted([{}]), transport, advertised: ["snapshot", "click"], onEvent: (e) => events.push(e), confirm: async () => true });
    expect(res.outcome).toBe("needs_user");
    expect(events.every((e) => e.kind !== "session" || e.mode === "flash")).toBe(true);
  });
});

describe("zero-ADB audit", () => {
  const ROOTS = ["src"];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) && !p.includes("routeTree.gen")) files.push(p);
    }
  };
  ROOTS.forEach(walk);
  it("has no reachable ADB tools, clients or fallback language", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/name:\s*"(device_(tap|type_text|keyevent|screenshot|connect|status|info)|launch_app|android_capabilities|run_adb_command)"/.test(src)) bad.push(`${f}: ADB tool declared`);
      if (/fall ?back to ADB|ADB is LEGACY|adb shell|force_adb/i.test(src)) bad.push(`${f}: ADB fallback language`);
    }
    expect(bad).toEqual([]);
  });
});
