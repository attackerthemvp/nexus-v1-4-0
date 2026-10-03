import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArcReactor } from "@/components/ArcReactor";
import { ChatSidebar } from "@/components/ChatSidebar";
import { checkAgentStatus, executeTool } from "@/lib/jarvis-agent";
import { callOllamaChat } from "@/lib/ai/ollama";
import {
  ANDROID_REPEAT_SAFE_COMMANDS,
  resolveAndroidApp,
  validatePhoneCommand,
} from "@/lib/android-apps";
import {
  checkAndroidCompletion,
  checkAndroidRetry,
  getAndroidSnapshot,
  noteAndroidDispatch,
  noteAndroidStateCheck,
  recordAndroidStatus,
  resetAndroidSession,
} from "@/lib/android-session";
import { ArtemisController } from "@/components/ArtemisController";
import { runArtemis } from "@/lib/artemis/engine";
import { createClientLLM } from "@/lib/artemis/client-llm";
import { markTarget } from "@/lib/artemis/mark-target";
import { getArtemisMode, setArtemisMode, useArtemisMode } from "@/lib/artemis/mode-store";
import { routeRequest } from "@/lib/artemis/request-router";
import type { ArtemisEvent, ConfirmRequest } from "@/lib/artemis/types";
import { Zap, Brain } from "lucide-react";
import { executeMemoryTool, isMemoryTool } from "@/lib/memory-tools";
import { executeWebTool, isWebTool } from "@/lib/web-tools";
import { relevantMemories } from "@/lib/memory-store";
import { runAgent, type ToolExecution } from "@/lib/agent-runner";
import { pruneHistory } from "@/lib/history-prune";

/** Bounded per-request budget so a stalled provider can't freeze the run. */
const MODEL_TIMEOUT_MS = 120_000;

import { useVoice } from "@/hooks/useVoice";
import {
  GREETING,
  createOrReuseEmptyChat,
  getChat,
  listChats,
  saveMessages,
  setActiveChatId,
  type ChatMessage as Msg,
  type ToolCallRecord,
} from "@/lib/chat-store";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { AgentLogsPanel } from "@/components/AgentLogsPanel";
import { logAgent } from "@/lib/agent-log";
import { TOOL_CARD_EVENT, type ToolCardEvent } from "@/lib/coding-actions";
import { useSettings } from "@/hooks/useSettings";
import { updateSection } from "@/lib/settings-store";
import { checkToolPolicy, isLocalAgentTool } from "@/lib/tool-policy";
import {
  Send,
  Power,
  Terminal,
  Cpu,
  Wifi,
  WifiOff,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Settings2,
  ScrollText,
  Square,

} from "lucide-react";

export function JarvisChat({
  chatId,
  onNavigateChat,
}: {
  chatId: string;
  onNavigateChat: (id: string) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentOnline, setAgentOnline] = useState(false);
  const agentOnlineRef = useRef(false);
  const [thinking, setThinking] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Lets the user stop a long autonomous run instead of waiting on a stalled one.
  const abortRef = useRef<AbortController | null>(null);
  // ---- Artemis (Android control) state: driven only by engine events ----
  const artemisMode = useArtemisMode();
  const [artemisEvents, setArtemisEvents] = useState<ArtemisEvent[]>([]);
  const [artemisRunning, setArtemisRunning] = useState(false);
  const [artemisPending, setArtemisPending] = useState<ConfirmRequest | null>(null);
  const confirmResolver = useRef<((ok: boolean) => void) | null>(null);
  const artemisAbortRef = useRef<AbortController | null>(null);

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
    artemisAbortRef.current?.abort();
    confirmResolver.current?.(false);
    setThinking("Stopping…");
  }, []);

  const answerConfirm = useCallback((ok: boolean) => {
    const r = confirmResolver.current;
    confirmResolver.current = null;
    setArtemisPending(null);
    r?.(ok);
  }, []);

  /** phone_task(goal, mode): hands the goal and the manually selected mode to Artemis. */
  const runPhoneTask = useCallback(async (goal: string, parent?: AbortSignal): Promise<string> => {
    const mode = getArtemisMode(); // read once; frozen for the run
    const status = await executeTool("phone_agent_status", {});
    if (status.startsWith("ERROR")) return `needs_user: the phone agent is not reachable (${status.slice(0, 200)}).`;
    const snap = recordAndroidStatus(status);
    if (!snap.online) return "needs_user: no NEXUS Android Agent is online.";
    const ctrl = new AbortController();
    artemisAbortRef.current = ctrl;
    parent?.addEventListener("abort", () => ctrl.abort(), { once: true });
    setArtemisEvents([]);
    setArtemisRunning(true);
    try {
      const res = await runArtemis({
        goal,
        mode,
        llm: createClientLLM({ signal: ctrl.signal, ai: settingsRef.current.ai }),
        transport: (command, args, timeoutSec) =>
          executeTool("phone_agent_command", { command, args, ...(timeoutSec ? { timeout_sec: timeoutSec } : {}) }),
        advertised: [...snap.capabilities],
        onEvent: (e) => {
          setArtemisEvents((prev) => [...prev, e]);
          if (e.kind === "action") logAgent({ kind: "tool", label: `artemis:${e.action}`, args: e.args, ok: true });
        },
        confirm: (req) =>
          new Promise<boolean>((resolve) => {
            if (ctrl.signal.aborted) return resolve(false);
            confirmResolver.current = resolve;
            setArtemisPending(req);
          }),
        signal: ctrl.signal,
        markTarget,
      });
      return `${res.outcome}: ${res.summary}`;
    } finally {
      artemisAbortRef.current = null;
      setArtemisRunning(false);
      setArtemisPending(null);
    }
  }, []);


  // Central NEXUS settings — every preference below is read from here.
  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Which provider/model answered last, plus router health for the HUD.
  const [aiMeta, setAiMeta] = useState<{ providerName: string; modelLabel: string } | null>(null);
  const [providerHealth, setProviderHealth] = useState<
    Array<{ id: string; name: string; state: string }>
  >([]);
  const aiHealthy = providerHealth.length
    ? providerHealth.some((p) => ["HEALTHY", "UNKNOWN", "DEGRADED"].includes(p.state))
    : true;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/ai-status");
        const d = await r.json();
        if (alive) setProviderHealth(d.providers ?? []);
      } catch {
        /* HUD-only */
      }
    };
    tick();
    const i = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);


  // Source of truth for the pipeline — never read chat state from a closure.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const messagesRef = useRef<Msg[]>(messages);
  messagesRef.current = messages;

  // Load the active chat's persisted history whenever the chat changes.
  useEffect(() => {
    setActiveChatId(chatId);
    const chat = getChat(chatId);
    const loaded = chat?.messages?.length ? chat.messages : [GREETING];
    messagesRef.current = loaded;
    setMessages(loaded);
    setThinking("");
  }, [chatId]);

  const agentEnabled = settings.computer.agentEnabled;
  const pollSeconds = settings.computer.pollSeconds;
  useEffect(() => {
    if (!agentEnabled) {
      agentOnlineRef.current = false;
      setAgentOnline(false);
      return;
    }
    const tick = async () => {
      const online = await checkAgentStatus();
      agentOnlineRef.current = online;
      setAgentOnline(online);
    };
    tick();
    const i = setInterval(tick, Math.max(2, pollSeconds) * 1000);
    return () => clearInterval(i);
  }, [agentEnabled, pollSeconds]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function callModel(history: Msg[], memories: string[]): Promise<any> {
    const apiMsgs = pruneHistory(history)
      .filter((m) => m.role !== "system")
      .map((m) => {
        const base: any = { role: m.role, content: m.content };
        if (m.tool_calls) base.tool_calls = m.tool_calls;
        if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
        return base;
      });

    // A hung provider must never freeze the run: bounded request + retries.
    const attempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (abortRef.current?.signal.aborted) throw new Error("Run stopped by user.");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: apiMsgs,
            memories,
            ai: settingsRef.current.ai,
            coding: settingsRef.current.coding,
            // The server re-checks permissions against these before offering
            // any tool to the model.
            settings: settingsRef.current,
          }),
        });

        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: "Unknown" }));
          throw new Error(err.error || `HTTP ${r.status}`);
        }
        const data = await r.json();
        // Ollama lives on the user's PC: the server prepared the prompt/tools and
        // the browser performs the completion locally.
        if (data?._nexus_local?.provider === "ollama") {
          const ai = settingsRef.current.ai;
          const opts: Parameters<typeof callOllamaChat>[0] = {
            messages: data._nexus_local.messages,
            tools: data._nexus_local.tools ?? [],
          };
          if (ai.modelId) opts.modelId = ai.modelId;
          if (ai.ollamaBaseUrl) opts.baseUrl = ai.ollamaBaseUrl;
          if (abortRef.current?.signal) opts.signal = abortRef.current.signal;
          return await callOllamaChat(opts);
        }
        return data;
      } catch (e) {
        lastError = e;
        const aborted = e instanceof Error && e.name === "AbortError";
        logAgent({
          kind: "error",
          label: `model attempt ${attempt}/${attempts}`,
          ok: false,
          detail: aborted ? `timed out after ${MODEL_TIMEOUT_MS / 1000}s` : String(e),
        });
        if (attempt < attempts) {
          setThinking(`Model did not respond — retrying (${attempt + 1}/${attempts})…`);
          await new Promise((res) => setTimeout(res, 1500 * attempt));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The AI provider did not respond.");
  }


  // Commit history to the chat it belongs to; only render if it's still active.
  const commit = useCallback((cid: string, history: Msg[], view?: Msg[]) => {
    saveMessages(cid, history);
    if (chatIdRef.current === cid) {
      const next = view ?? history;
      messagesRef.current = next;
      setMessages(next);
    }
  }, []);

  // Coding-panel actions stream their tool cards into the active chat.
  useEffect(() => {
    const onCard = (ev: Event) => {
      const detail = (ev as CustomEvent<ToolCardEvent>).detail;
      if (!detail?.record) return;
      const { id, record } = detail;
      const cid = chatIdRef.current;
      const hist = messagesRef.current;
      const idx = hist.findIndex((m) => m.display?.tools?.some((t) => t.id === id));
      const next: Msg[] =
        idx >= 0
          ? hist.map((m, i) =>
              i === idx
                ? {
                    ...m,
                    display: {
                      ...m.display,
                      tools: (m.display?.tools ?? []).map((t) => (t.id === id ? record : t)),
                    },
                  }
                : m,
            )
          : [
              ...hist,
              {
                role: "assistant",
                content: "",
                display: { tools: [record] },
                ts: Date.now(),
              } as Msg,
            ];
      commit(cid, next);
    };
    window.addEventListener(TOOL_CARD_EVENT, onCard as EventListener);
    return () => window.removeEventListener(TOOL_CARD_EVENT, onCard as EventListener);
  }, [commit]);

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || busy) return;
      if (!override) setInput("");
      voiceRef.current?.stopSpeaking();
      setBusy(true);

      const cid = chatIdRef.current;
      let history: Msg[] = [
        ...messagesRef.current,
        { role: "user", content: text, ts: Date.now() } as Msg,
      ];
      commit(cid, history);

      // Permanent memory: only the memories relevant to this turn (keeps tokens low).
      const mem = settingsRef.current.memory;
      const memories = mem.enabled
        ? relevantMemories(text, mem.maxInjected).map((m) => `[${m.category}] ${m.text}`)
        : [];

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // Android retry budgets and the last outcome are per-run state.
      resetAndroidSession();

      // ---- Android request router: NORMAL / ANDROID / AMBIGUOUS ----
      const say = (content: string) => {
        history = [...history, { role: "assistant", content, ts: Date.now() } as Msg];
        commit(cid, history);
      };
      let handled = false;
      try {
        const recent = messagesRef.current
          .slice(-6)
          .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 300) : "[media]"}`)
          .join("\n");
        const route = await routeRequest(text, recent, async (system, user) => {
          const r = await createClientLLM({ signal: ctrl.signal, ai: settingsRef.current.ai }).call(
            "android-router",
            [{ role: "system", content: system }, { role: "user", content: user }],
            [],
          );
          return r.text;
        });
        logAgent({ kind: "status", label: "android-router", detail: `${route.decision} (${route.via})` });
        if (route.decision === "AMBIGUOUS") {
          say("Should I do this **on your phone** (Android control), or just answer / handle it here? Reply \"on my phone\" to let me control it.");
          handled = true;
        }
        if (route.decision === "ANDROID") {
          setThinking(`Artemis (${getArtemisMode().toUpperCase()}) is controlling your phone…`);
          const out = await runPhoneTask(text, ctrl.signal);
          const [outcome, ...rest] = out.split(": ");
          const label = outcome === "done" ? "Done" : outcome === "stopped" ? "Stopped" : outcome === "needs_user" ? "Needs you" : "Stuck";
          say(`**Phone task — ${label}.** ${rest.join(": ")}`);
          if (chatIdRef.current === cid) voiceRef.current?.speak(`${label}. ${rest.join(": ")}`);
          handled = true;
        }
      } catch (e) {
        if (!ctrl.signal.aborted) say(`**System error:** ${e instanceof Error ? e.message : String(e)}`);
        else say("**Phone task — Stopped.** Stopped by you. The task was not completed.");
        handled = true;
      }
      if (handled) {
        abortRef.current = null;
        if (chatIdRef.current === cid) setThinking("");
        setBusy(false);
        return;
      }

      try {
        const result = await runAgent({
          initialHistory: history,
          maxSteps: Math.max(8, settingsRef.current.coding.maxSteps),
          maxRunMs: Math.max(1, settingsRef.current.coding.maxRunMinutes) * 60_000,
          signal: ctrl.signal,
          toolTimeoutMs: Math.max(120, settingsRef.current.coding.commandTimeoutSec + 60) * 1000,
          callModel: (currentHistory) => callModel(currentHistory, memories),
          // A finish_task report cannot outrank a failed Android command.
          checkCompletion: checkAndroidCompletion,

          executeTool: async (fname, args): Promise<ToolExecution> => {
            if (fname === "phone_task") {
              const goal = typeof args["goal"] === "string" ? args["goal"] : text;
              const out = await runPhoneTask(goal, ctrl.signal);
              return { content: out };
            }
            // Coding defaults: long builds/tests must not die at the 120s default.
            const cfg = settingsRef.current.coding;
            if (
              (fname === "run_command" || fname === "run_command_bg") &&
              args["timeout_sec"] == null
            )
              args = { ...args, timeout_sec: cfg.commandTimeoutSec };

            // Android app-name → package lookup runs locally (single mapping, no agent needed).
            if (fname === "android_app_lookup") {
              const name = typeof args["name"] === "string" ? args["name"] : "";
              const installed = Array.isArray(args["installed_packages"])
                ? (args["installed_packages"] as unknown[]).filter((p): p is string => typeof p === "string")
                : undefined;
              const r = resolveAndroidApp(name, installed);
              logAgent({ kind: "tool", label: fname, args, ok: true, detail: JSON.stringify(r).slice(0, 600) });
              return {
                content: JSON.stringify({
                  ...r,
                  hint: !r.candidates.length
                    ? "Unknown app. Ask the user for the package id — never guess or use a placeholder package."
                    : r.resolved
                      ? `Resolved. Act now: phone_agent_command {"command":"open_app","args":{"package":"${r.resolved}"}} — do NOT ask the user to choose between candidates. Verify once with foreground_app / wait_for_app, then finish_task.`
                      : installed
                        ? "None of the known variants appears in list_apps, but list_apps on this device is incomplete — try the first candidate anyway before telling the user it is missing."
                        : `Multiple OEM variants. Try ${r.candidates[0]} first; if open_app errors, try the next candidate. Do not ask the user to pick.`,
                }),
              };
            }
            // --- Android command boundary: capability + argument validation, then
            // a state-aware retry gate. Nothing reaches the phone unvalidated.
            let phoneNote: string | undefined;
            let phoneCommand: string | undefined;
            let phoneRepeatSafe = false;
            if (fname === "phone_agent_command") {
              const snapshot = getAndroidSnapshot();
              const verdict = validatePhoneCommand(args["command"], args["args"], snapshot);
              if (!verdict.ok) {
                logAgent({ kind: "error", label: fname, args, ok: false, detail: verdict.error });
                return { content: `ERROR: ${verdict.error}` };
              }
              phoneCommand = verdict.command;
              phoneRepeatSafe = ANDROID_REPEAT_SAFE_COMMANDS.has(verdict.command);
              args = { ...args, command: verdict.command, args: verdict.args };
              if (verdict.note) phoneNote = verdict.note;
              const retry = checkAndroidRetry(verdict.command, verdict.args, phoneRepeatSafe);
              if (!retry.allow) {
                logAgent({ kind: "error", label: fname, args, ok: false, detail: retry.error });
                return { content: `ERROR: ${retry.error}` };
              }
            }
            // Security / Computer / Devices / Memory / Coding settings are enforced here.
            const decision = checkToolPolicy(fname, args, settingsRef.current);
            if (settingsRef.current.advanced.debugLogging)
              console.log("[NEXUS] tool", fname, args, decision);
            if (!decision.allow) return { content: `ERROR: ${decision.reason}` };

            if (decision.confirm) {
              const ok = window.confirm(
                `${decision.confirm.title}\n\n${decision.confirm.detail}\n\nAllow this action?`,
              );
              if (!ok) return { content: "ERROR: The user denied this action." };
            }
            // Native internet tools run on the NEXUS server, so they work even
            // when the local agent is offline — never block them on the link.
            if (!isWebTool(fname) && !isMemoryTool(fname) && isLocalAgentTool(fname) && !agentOnlineRef.current) {
              const msg =
                "ERROR: The local NEXUS agent is OFFLINE, so machine tools are unavailable. Do not retry local tools. Use web_search / web_fetch for internet information, answer from knowledge, or tell the user to start the local agent.";
              logAgent({ kind: "error", label: fname, args, ok: false, detail: msg });
              return { content: msg };
            }
            const startedAt = Date.now();
            const result = isWebTool(fname)
              ? await executeWebTool(fname, args)
              : isMemoryTool(fname)
                ? executeMemoryTool(fname, args)
                : await executeTool(fname, args);

            logAgent({
              kind: result.startsWith("ERROR") ? "error" : "tool",
              label: fname,
              args,
              ok: !result.startsWith("ERROR"),
              durationMs: Date.now() - startedAt,
              detail: result.slice(0, 600),
            });
            // The phone's own status answer is the runtime capability contract.
            if (fname === "phone_agent_status" && !result.startsWith("ERROR")) recordAndroidStatus(result);
            if (fname === "phone_info" || fname === "phone_ping") noteAndroidStateCheck();
            if (phoneCommand)
              noteAndroidDispatch(
                phoneCommand,
                (args["args"] as Record<string, unknown>) ?? {},
                !result.startsWith("ERROR"),
                result.slice(0, 200),
                phoneRepeatSafe,
              );
            let content = phoneNote ? `[schema note] ${phoneNote}\n${result}` : result;
            let attachment: Msg | undefined;
            try {
              const parsed = JSON.parse(result);
              if (parsed && typeof parsed === "object" && parsed.screenshot_b64) {
                const screenshotMime = parsed.screenshot_mime || "image/jpeg";
                const screenshotB64 = parsed.screenshot_b64;
                const { screenshot_b64: _drop, ...rest } = parsed;
                content = JSON.stringify({ ...rest, screenshot: "[attached as image to next message]" });
                attachment = {
                  role: "user",
                  content: [
                    { type: "text", text: `Screen capture from ${fname}. Identify targets visually and click by x/y coordinates from the screen size in the previous tool result.` },
                    { type: "image_url", image_url: { url: `data:${screenshotMime};base64,${screenshotB64}` } },
                  ] as any,
                  ts: Date.now(),
                };
              }
            } catch {
              // Non-JSON tool results are valid plain text.
            }
            return attachment ? { content, attachment } : { content };
          },
          onStatus: (status) => {
            logAgent({ kind: "status", label: "agent", detail: status });
            if (chatIdRef.current === cid) setThinking(status);
          },
          onModelMeta: (meta) => setAiMeta(meta),
          onUpdate: (nextHistory, view) => {
            history = nextHistory;
            commit(cid, nextHistory, view);
          },
        });
        if (result.finalText && chatIdRef.current === cid) voiceRef.current?.speak(result.finalText);
      } catch (e) {
        logAgent({
          kind: "error",
          label: "run failed",
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
        const errMsg: Msg = {
          role: "assistant",
          content: `**System error:** ${e instanceof Error ? e.message : String(e)}`,
          ts: Date.now(),
        };
        commit(cid, [...history, errMsg]);
      } finally {
        abortRef.current = null;
        if (chatIdRef.current === cid) {
          setThinking("");
        }
        setBusy(false);
      }

    },
    [busy, input, commit],
  );

  // Voice must always hit the CURRENT send + CURRENT active chat.
  const sendRef = useRef(send);
  sendRef.current = send;
  const voice = useVoice(
    useCallback((spoken: string) => {
      sendRef.current(spoken);
    }, []),
    {
      outputEnabled: settings.voice.outputEnabled,
      requireWakeWord: settings.voice.requireWakeWord,
      wakeWord: settings.voice.wakeWord,
      voiceURI: settings.voice.voiceURI,
      rate: settings.voice.rate,
      pitch: settings.voice.pitch,
      lang: settings.voice.lang,
    },
  );
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  function handleNewChat() {
    const chat = createOrReuseEmptyChat();
    onNavigateChat(chat.id);
  }

  function handleDeletedActive() {
    const remaining = listChats();
    const next = remaining[0]?.id ?? createOrReuseEmptyChat().id;
    onNavigateChat(next);
  }

  return (
    <div className="flex h-screen">
      <ChatSidebar
        activeId={chatId}
        onNewChat={handleNewChat}
        onSelect={(id) => onNavigateChat(id)}
        onDeleted={handleDeletedActive}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top HUD */}
        <header className="panel flex items-center justify-between px-6 py-3 rounded-none border-x-0 border-t-0">
          <div className="flex items-center gap-4">
            <ArcReactor active={busy} size={48} />
            <div>
              <h1 className="font-display text-xl text-glow text-primary">NEXUS</h1>
              <p className="text-xs text-muted-foreground tracking-widest">
                NEURAL EXECUTIVE EXCHANGE UTILITY SYSTEM
              </p>
            </div>
          </div>
          <div className="flex items-center gap-6 text-xs font-mono">
            <Stat
              icon={<Cpu size={14} />}
              label="AI"
              value={aiMeta ? aiMeta.modelLabel.toUpperCase() : "ONLINE"}
              ok={aiHealthy}
              title={
                providerHealth.length
                  ? providerHealth.map((p) => `${p.name}: ${p.state}`).join("\n")
                  : undefined
              }
            />

            <Stat
              icon={agentOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
              label="LOCAL AGENT"
              value={agentOnline ? "LINKED" : "OFFLINE"}
              ok={agentOnline}
            />
            <button
              onClick={() => setLogsOpen(true)}
              title="Agent activity logs (tool calls, polling, errors)"
              aria-label="Open agent logs"
              className="rounded-md border border-border p-2 text-muted-foreground transition hover:border-primary hover:text-primary"
            >
              <ScrollText size={14} />
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              title="NEXUS system control (settings)"
              aria-label="Open NEXUS settings"
              className="rounded-md border border-border p-2 text-muted-foreground transition hover:border-primary hover:text-primary"
            >
              <Settings2 size={14} />
            </button>
            <Stat icon={<Power size={14} />} label="STATUS" value={busy ? "WORKING" : "READY"} ok />
            <Stat
              icon={voice.listening ? <Mic size={14} /> : <MicOff size={14} />}
              label="VOICE"
              value={!voice.supported ? "N/A" : voice.listening ? (voice.awake ? "AWAKE" : "WAKE WORD") : "OFF"}
              ok={voice.listening}
            />
          </div>
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {messages.map((m, i) => (
              <MessageBubble
                key={i}
                msg={m}
                showTools={settings.chat.showToolCards}
                expandTools={settings.chat.expandToolCards}
              />
            ))}
            {artemisEvents.length > 0 && (
              <ArtemisController
                events={artemisEvents}
                pending={artemisPending}
                onConfirm={answerConfirm}
                onStop={stopRun}
                running={artemisRunning}
              />
            )}
            {thinking && (
              <div className="flex items-center gap-2 text-primary text-sm">
                <span className="animate-blink">●</span>
                <span className="text-glow">{thinking}</span>
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <footer className="panel rounded-none border-x-0 border-b-0 px-6 py-4">
          <div className="mx-auto max-w-4xl flex gap-3 items-end">
            <div className="flex-1 relative">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  const enter = e.key === "Enter";
                  if (!enter || e.shiftKey) return;
                  if (settings.general.sendOnEnter || e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={agentOnline ? "Issue a command, sir..." : "Local agent offline — chat will work, but I can't act on your machine yet."}
                rows={2}
                className="w-full resize-none rounded-md bg-input/60 border border-border px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-primary focus:shadow-[0_0_0_3px_var(--jarvis-glow-soft)] transition"
              />
            </div>
            <div role="radiogroup" aria-label="Artemis phone mode" className="flex h-12 rounded-md border border-border overflow-hidden" title="Artemis phone-control mode. Only you change this.">
              {(["flash", "pro"] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={artemisMode === m}
                  disabled={artemisRunning}
                  onClick={() => setArtemisMode(m)}
                  className={`px-3 text-xs font-display tracking-wider flex items-center gap-1 transition disabled:opacity-60 ${
                    artemisMode === m ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-primary"
                  }`}
                >
                  {m === "flash" ? <Zap size={14} /> : <Brain size={14} />}
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              onClick={voice.toggle}
              disabled={!voice.supported || !settings.voice.inputEnabled}
              title={voice.supported ? "Toggle voice input. When listening, speak your command and I'll execute it." : "Speech recognition not supported in this browser"}
              className={`h-12 w-12 rounded-md border font-display transition flex items-center justify-center ${
                voice.listening
                  ? "bg-primary/20 border-primary text-primary glow-ring animate-pulse"
                  : "border-border text-muted-foreground hover:text-primary hover:border-primary"
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {voice.listening ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            <button
              onClick={() => {
                if (voice.speakReplies) voice.stopSpeaking();
                updateSection("voice", { outputEnabled: !voice.speakReplies });
              }}
              title={voice.speakReplies ? "Spoken replies on" : "Spoken replies off"}
              className={`h-12 w-12 rounded-md border transition flex items-center justify-center ${
                voice.speakReplies
                  ? `bg-accent/15 border-accent text-accent ${voice.speaking ? "animate-pulse" : ""}`
                  : "border-border text-muted-foreground hover:text-accent hover:border-accent"
              }`}
            >
              {voice.speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            {busy ? (
              <button
                onClick={stopRun}
                title="Stop the current run"
                className="h-12 px-5 rounded-md border border-destructive text-destructive font-display tracking-wider text-sm hover:bg-destructive/10 transition"
              >
                <Square size={14} className="inline mr-2" />
                STOP
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={!input.trim()}
                className="h-12 px-5 rounded-md bg-primary text-primary-foreground font-display tracking-wider text-sm hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed glow-ring transition"
              >
                <Send size={16} className="inline mr-2" />
                SEND
              </button>
            )}

          </div>
          {voice.listening && (
            <div className="mx-auto max-w-4xl mt-2 text-xs font-mono text-muted-foreground">
              <span className="text-primary text-glow">Listening for your command, sir…</span>
              {voice.heard && <span className="ml-2 italic text-accent">{voice.heard}</span>}
            </div>
          )}
        </footer>
      </div>

      <AgentLogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        agentOnline={agentOnline}
        activeProvider={aiMeta?.providerName}
        activeModel={aiMeta?.modelLabel}
      />
    </div>
  );
}

function Stat({ icon, label, value, ok, title }: { icon: React.ReactNode; label: string; value: string; ok?: boolean; title?: string | undefined }) {
  return (
    <div className="flex items-center gap-2" title={title}>

      <span className={ok ? "text-primary" : "text-destructive"}>{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className={`tracking-wider ${ok ? "text-primary text-glow" : "text-destructive"}`}>
        {value}
      </span>
    </div>
  );
}

function MessageBubble({
  msg,
  showTools = true,
  expandTools = true,
}: {
  msg: Msg;
  showTools?: boolean;
  expandTools?: boolean;
}) {
  if (msg.role === "tool") return null; // shown via display.tools instead
  if (msg.internal) return null; // execution-controller nudges stay internal
  if (msg.role === "assistant" && msg.display?.tools) {
    if (!showTools) return null;
    return (
      <div className="space-y-2">
        {msg.display.tools.map((t, idx) => (
          <ToolCard key={idx} record={t} open={expandTools} />
        ))}
      </div>
    );
  }

  const isUser = msg.role === "user";
  const text = typeof msg.content === "string" ? msg.content : "*[attachment]*";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 ${
          isUser
            ? "bg-primary/15 border border-primary/40 text-foreground"
            : "panel text-foreground"
        }`}
      >
        <div className="text-[10px] font-display tracking-widest mb-1 text-primary/70">
          {isUser ? "USER" : "NEXUS"}
        </div>
        <div className="prose prose-sm prose-invert max-w-none [&_*]:text-foreground [&_code]:text-accent [&_a]:text-primary">
          <ReactMarkdown>{text || "*…*"}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function ToolCard({ record, open = true }: { record: ToolCallRecord; open?: boolean }) {
  const failed = record.result.startsWith("ERROR");
  // Code patches carry a unified diff — render it as a real diff, not raw JSON.
  let diff: string | null = null;
  let rest = record.result;
  if (!failed) {
    try {
      const parsed = JSON.parse(record.result);
      if (parsed && typeof parsed === "object" && typeof parsed.diff === "string") {
        diff = parsed.diff;
        const { diff: _d, ...others } = parsed;
        rest = JSON.stringify(others, null, 2);
      }
    } catch {
      // Plain-text results stay as-is.
    }
  }
  return (
    <details className="panel rounded-md text-xs font-mono group" open={open}>
      <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 list-none">
        <Terminal size={14} className={failed ? "text-destructive" : "text-accent"} />
        <span className="text-accent text-glow">{record.name}</span>
        <span className="text-muted-foreground truncate flex-1">
          {JSON.stringify(record.args)}
        </span>
        <span className={failed ? "text-destructive" : "text-primary"}>
          {failed ? "✕" : "✓"}
        </span>
      </summary>
      {diff && (
        <pre className="mx-3 mb-2 rounded border border-border bg-input/40 p-2 max-h-72 overflow-auto whitespace-pre">
          {diff.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("+") && !line.startsWith("+++")
                  ? "text-primary"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "text-destructive"
                    : line.startsWith("@@")
                      ? "text-accent"
                      : "text-muted-foreground"
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      )}
      <pre className="px-3 pb-3 pt-0 whitespace-pre-wrap break-words text-muted-foreground max-h-64 overflow-auto">
{rest}
      </pre>
    </details>
  );
}

