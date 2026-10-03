import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bot,
  Brain,
  Cpu,
  MessageSquare,
  Monitor,
  Terminal,

  Palette,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Mic,
  X,
} from "lucide-react";
import {
  ActionRow,
  Group,
  HudButton,
  SelectRow,
  SliderRow,
  StatusRow,
  TextRow,
  ToggleRow,
} from "@/components/settings/controls";
import {
  AGENT_URLS,
  checkAgentStatus,
} from "@/lib/jarvis-agent";
import {
  OLLAMA_DEFAULT_URLS,
  listOllamaModels,
  resolveOllamaBase,
  type OllamaModel,
} from "@/lib/ai/ollama";
import { listSpeechVoices } from "@/hooks/useVoice";
import { useSettings } from "@/hooks/useSettings";
import {
  resetAllSettings,
  resetSection,
  updateSection,
  type SettingsSection,
} from "@/lib/settings-store";
import { listChats } from "@/lib/chat-store";
import { runGitWorkflow, runProjectCommand, workspacePath } from "@/lib/coding-actions";
import { listMemories } from "@/lib/memory-store";
import { listEspProjects } from "@/lib/esp-projects";
import { NEXUS_VERSION } from "@/lib/nexus-version";
import { cn } from "@/lib/utils";

type ProviderInfo = {
  id: string;
  name: string;
  state: string;
  configured: boolean;
  role: string;
  priority: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  models: Array<{ id: string; label: string; capabilities: string[]; usable: boolean }>;
};

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof Settings2; blurb: string }> = [
  { id: "general", label: "General", icon: Settings2, blurb: "Startup and core behaviour" },
  { id: "ai", label: "AI & Models", icon: Bot, blurb: "Routing, providers, failover" },
  { id: "voice", label: "Voice", icon: Mic, blurb: "Speech input and output" },
  { id: "computer", label: "Computer", icon: Monitor, blurb: "Local agent and automation" },
  { id: "coding", label: "Coding", icon: Terminal, blurb: "Workspace, patches, git" },

  { id: "memory", label: "Memory", icon: Brain, blurb: "Cross-chat permanent memory" },
  { id: "devices", label: "Devices", icon: Cpu, blurb: "ESP / IoT and NEXUS Hub" },
  { id: "chat", label: "Chat", icon: MessageSquare, blurb: "Conversation behaviour" },
  { id: "appearance", label: "Appearance", icon: Palette, blurb: "HUD, glow, density" },
  { id: "security", label: "Security", icon: ShieldCheck, blurb: "Tool permissions" },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal, blurb: "Diagnostics and reset" },
];

const SECTION_KEY = "nexus.settings.section.v1";

export function SettingsPanel({
  open,
  onClose,
  agentOnline,
  activeProvider,
  activeModel,
}: {
  open: boolean;
  onClose: () => void;
  agentOnline: boolean;
  activeProvider?: string | undefined;
  activeModel?: string | undefined;
}) {
  const settings = useSettings();
  const [section, setSection] = useState<SettingsSection>("general");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [espCount, setEspCount] = useState<number | null>(null);
  const [espError, setEspError] = useState<string | null>(null);
  const [agentLive, setAgentLive] = useState(agentOnline);
  const [confirmReset, setConfirmReset] = useState<null | "section" | "all">(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [createBranch, setCreateBranch] = useState(false);
  const [codingBusy, setCodingBusy] = useState<string | null>(null);
  const [codingResult, setCodingResult] = useState<{ ok: boolean; summary: string } | null>(null);
  // Local Ollama: discovered from this browser (the server can't reach the PC).
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaBase, setOllamaBase] = useState<string | null>(null);
  const [ollamaScanning, setOllamaScanning] = useState(false);

  const ollamaUrl = settings.ai.ollamaBaseUrl;
  const scanOllama = async () => {
    setOllamaScanning(true);
    try {
      const base = await resolveOllamaBase(ollamaUrl);
      setOllamaBase(base);
      setOllamaModels(base ? await listOllamaModels(ollamaUrl) : []);
    } finally {
      setOllamaScanning(false);
    }
  };

  async function runCoding(label: string, fn: () => Promise<{ ok: boolean; summary: string }>) {
    if (codingBusy) return;
    setCodingBusy(label);
    setCodingResult(null);
    try {
      setCodingResult(await fn());
    } catch (e) {
      setCodingResult({ ok: false, summary: e instanceof Error ? e.message : String(e) });
    } finally {
      setCodingBusy(null);
    }
  }

  // Remember the selected section across opens/reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(SECTION_KEY) as SettingsSection | null;
    if (stored && SECTIONS.some((s) => s.id === stored)) setSection(stored);
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(SECTION_KEY, section);
  }, [section]);

  useEffect(() => setAgentLive(agentOnline), [agentOnline]);

  // Escape closes the control center.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Load live data only while the panel is open (no extra background polling).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/ai-status")
      .then((r) => r.json())
      .then((d) => alive && setProviders(d.providers ?? []))
      .catch(() => {});
    void scanOllama();
    setVoices(listSpeechVoices());
    const onVoices = () => setVoices(listSpeechVoices());
    if (typeof window !== "undefined" && "speechSynthesis" in window)
      window.speechSynthesis.addEventListener("voiceschanged", onVoices);
    checkAgentStatus().then((v) => alive && setAgentLive(v));
    listEspProjects()
      .then((p) => alive && (setEspCount(p.length), setEspError(null)))
      .catch((e) => alive && (setEspCount(null), setEspError(e instanceof Error ? e.message : "unreachable")));
    return () => {
      alive = false;
      if (typeof window !== "undefined" && "speechSynthesis" in window)
        window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
    };
  }, [open]);

  const chatCount = useMemo(() => (open ? listChats().length : 0), [open]);
  const memoryCount = useMemo(() => (open ? listMemories().length : 0), [open]);

  // Ollama is a first-class provider in this list, but its models come from
  // `ollama list` on the user's machine instead of the server-side registry.
  const ollamaProvider: ProviderInfo = {
    id: "ollama",
    name: "Ollama (local)",
    state: ollamaBase ? "HEALTHY" : "OFFLINE",
    configured: Boolean(ollamaBase),
    role: "local",
    priority: 0,
    successRate: null,
    avgLatencyMs: null,
    models: ollamaModels.map((m) => ({
      id: m.id,
      label: m.detail ? `${m.label} — ${m.detail}` : m.label,
      capabilities: ["tools", "coding", "reasoning"],
      usable: true,
    })),
  };
  const allProviders = [...providers, ollamaProvider];
  const pinnedProvider = allProviders.find((p) => p.id === settings.ai.providerId);
  const currentSection = SECTIONS.find((s) => s.id === section)!;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="NEXUS system control">
      <button
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm animate-in fade-in"
      />

      <div className="panel relative flex h-full w-full max-w-4xl flex-col rounded-none border-y-0 border-r-0 shadow-2xl animate-in slide-in-from-right duration-300">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="font-display text-base tracking-[0.2em] text-primary text-glow">NEXUS</h2>
            <p className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground">
              SYSTEM CONTROL
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded border border-border p-1.5 text-muted-foreground transition hover:border-primary hover:text-primary"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Left navigation */}
          <nav
            aria-label="Settings sections"
            className="w-52 shrink-0 overflow-y-auto border-r border-border/60 p-2"
          >
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = s.id === section;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition",
                    active
                      ? "border border-primary/60 bg-primary/10 text-primary glow-ring"
                      : "border border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-display text-[11px] tracking-widest">
                      {s.label.toUpperCase()}
                    </span>
                    <span className="block truncate font-mono text-[9px] opacity-70">{s.blurb}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Section body */}
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm tracking-[0.2em] text-foreground">
                {currentSection.label.toUpperCase()}
              </h3>
              <HudButton onClick={() => setConfirmReset("section")}>RESET SECTION</HudButton>
            </div>

            <div className="space-y-3 pb-6">
              {section === "general" && (
                <Group title="STARTUP & BEHAVIOUR" hint="Applies to the whole NEXUS interface.">
                  <SelectRow
                    label="Startup conversation"
                    description="Which chat opens when NEXUS boots."
                    value={settings.general.startupChat}
                    options={[
                      { value: "last", label: "Resume last chat" },
                      { value: "new", label: "Always start a new chat" },
                    ]}
                    onChange={(v) => updateSection("general", { startupChat: v })}
                  />
                  <ToggleRow
                    label="Enter sends message"
                    description="Off: Enter inserts a newline, Ctrl/Cmd+Enter sends."
                    checked={settings.general.sendOnEnter}
                    onChange={(v) => updateSection("general", { sendOnEnter: v })}
                  />
                  <ToggleRow
                    label="Confirm chat deletion"
                    description="Ask before deleting a conversation from the sidebar."
                    checked={settings.general.confirmChatDelete}
                    onChange={(v) => updateSection("general", { confirmChatDelete: v })}
                  />
                </Group>
              )}

              {section === "ai" && (
                <>
                  <Group title="AI ROUTING" hint="NEXUS classifies each task and picks the best provider/model.">
                    <ToggleRow
                      label="Automatic model selection"
                      description="Task classification (coding, vision, tool use…) drives provider and model choice."
                      checked={settings.ai.autoRouting}
                      onChange={(v) => updateSection("ai", { autoRouting: v })}
                    />
                    <SelectRow
                      label="Pinned provider"
                      description="Used first when automatic selection is off."
                      value={settings.ai.providerId}
                      disabled={settings.ai.autoRouting}
                      options={[
                        { value: "", label: "— none —" },
                        ...allProviders.map((p) => ({
                          value: p.id as typeof settings.ai.providerId,
                          label: `${p.name}${p.configured ? "" : " (no key)"}`,
                        })),
                      ]}
                      onChange={(v) => updateSection("ai", { providerId: v, modelId: "" })}
                    />
                    <SelectRow
                      label="Pinned model"
                      description="Falls back to automatic choice if the model can't serve the request."
                      value={settings.ai.modelId}
                      disabled={settings.ai.autoRouting || !pinnedProvider}
                      options={[
                        { value: "", label: "— best available —" },
                        ...(pinnedProvider?.models ?? []).map((m) => ({
                          value: m.id,
                          label: m.label,
                        })),
                      ]}
                      onChange={(v) => updateSection("ai", { modelId: v })}
                    />
                  </Group>

                  <Group title="FAILOVER">
                    <ToggleRow
                      label="Provider failover"
                      description="Try the next healthy provider when one fails, rate-limits or times out."
                      checked={settings.ai.failover}
                      onChange={(v) => updateSection("ai", { failover: v })}
                    />
                    <SliderRow
                      label="Max attempts"
                      description="Hard cap on provider/model attempts for a single request."
                      value={settings.ai.maxAttempts}
                      min={10}
                      max={40}
                      step={1}
                      onChange={(v) => updateSection("ai", { maxAttempts: v })}
                      disabled={!settings.ai.failover}
                    />
                  </Group>

                  <Group title="ACTIVE ROUTE">
                    <StatusRow label="Current provider" value={activeProvider ?? "—"} />
                    <StatusRow label="Current model" value={activeModel ?? "—"} />
                  </Group>

                  <Group
                    title="OLLAMA (LOCAL PC)"
                    hint="Runs on your own machine, so NEXUS calls it straight from this browser. No API key. Pin it above to make it primary."
                  >
                    <StatusRow
                      label="Ollama"
                      value={
                        ollamaScanning
                          ? "scanning…"
                          : ollamaBase
                            ? `online · ${ollamaBase}`
                            : `offline (${(ollamaUrl || OLLAMA_DEFAULT_URLS[0]) ?? ""})`
                      }
                      ok={Boolean(ollamaBase)}
                    />
                    <StatusRow
                      label="Installed models"
                      value={
                        ollamaModels.length
                          ? ollamaModels.map((m) => m.id).join(", ")
                          : ollamaBase
                            ? "none — run: ollama pull <model>"
                            : "—"
                      }
                      ok={ollamaModels.length > 0}
                    />
                    <TextRow
                      label="Ollama address"
                      description="Leave empty for http://127.0.0.1:11434 on this machine."
                      value={settings.ai.ollamaBaseUrl}
                      placeholder="http://127.0.0.1:11434"
                      onChange={(v) => updateSection("ai", { ollamaBaseUrl: v })}
                    />
                    <ActionRow
                      label="Refresh model list"
                      description="Re-reads the models installed on your PC and updates the pinned-model options."
                    >
                      <HudButton onClick={() => void scanOllama()}>
                        {ollamaScanning ? "SCANNING…" : "REFRESH"}
                      </HudButton>
                    </ActionRow>
                  </Group>

                  <Group title="PROVIDER HEALTH" hint="Live router telemetry. API keys are stored server-side only.">
                    {providers.length === 0 && (
                      <StatusRow label="Status" value="loading…" tone="neutral" />
                    )}
                    {providers.map((p) => (
                      <StatusRow
                        key={p.id}
                        label={`${p.name} · ${p.role} · P${p.priority}`}
                        value={`${p.state}${p.successRate !== null ? ` · ${p.successRate}%` : ""}${
                          p.avgLatencyMs ? ` · ${p.avgLatencyMs}ms` : ""
                        }`}
                        ok={["HEALTHY", "UNKNOWN", "DEGRADED"].includes(p.state)}
                      />
                    ))}
                    <ActionRow
                      label="Advanced Provider Health"
                      description="Per-key state, cooldowns and success rates for every provider."
                    >
                      <Link
                        to="/provider-health"
                        onClick={onClose}
                        className="rounded border border-primary/50 px-3 py-1 font-display text-[11px] tracking-wider text-primary transition hover:bg-primary/10"
                      >
                        OPEN
                      </Link>
                    </ActionRow>
                  </Group>
                </>
              )}

              {section === "voice" && (
                <>
                  <Group title="INPUT">
                    <ToggleRow
                      label="Voice input"
                      description="Enables the microphone control in the composer."
                      checked={settings.voice.inputEnabled}
                      onChange={(v) => updateSection("voice", { inputEnabled: v })}
                    />
                    <ToggleRow
                      label="Require wake word"
                      description="Only act on speech that starts with the wake word. Push-to-talk always bypasses it."
                      checked={settings.voice.requireWakeWord}
                      onChange={(v) => updateSection("voice", { requireWakeWord: v })}
                      disabled={!settings.voice.inputEnabled}
                    />
                    <TextRow
                      label="Wake word"
                      value={settings.voice.wakeWord}
                      placeholder="nexus"
                      onChange={(v) => updateSection("voice", { wakeWord: v })}
                      disabled={!settings.voice.inputEnabled || !settings.voice.requireWakeWord}
                    />
                    <TextRow
                      label="Recognition language"
                      description="BCP-47 tag used by the browser speech recogniser."
                      value={settings.voice.lang}
                      placeholder="en-US"
                      onChange={(v) => updateSection("voice", { lang: v })}
                      disabled={!settings.voice.inputEnabled}
                    />
                  </Group>

                  <Group title="OUTPUT">
                    <ToggleRow
                      label="Spoken replies"
                      description="NEXUS reads its final answer aloud."
                      checked={settings.voice.outputEnabled}
                      onChange={(v) => updateSection("voice", { outputEnabled: v })}
                    />
                    <SelectRow
                      label="Speech voice"
                      description={
                        voices.length ? "Voices provided by this browser/OS." : "No voices reported yet."
                      }
                      value={settings.voice.voiceURI}
                      options={[
                        { value: "", label: "Automatic (NEXUS pick)" },
                        ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` })),
                      ]}
                      onChange={(v) => updateSection("voice", { voiceURI: v })}
                      disabled={!settings.voice.outputEnabled}
                    />
                    <SliderRow
                      label="Speech rate"
                      value={settings.voice.rate}
                      min={0.5}
                      max={2}
                      step={0.01}
                      suffix="×"
                      onChange={(v) => updateSection("voice", { rate: v })}
                      disabled={!settings.voice.outputEnabled}
                    />
                    <SliderRow
                      label="Speech pitch"
                      value={settings.voice.pitch}
                      min={0.5}
                      max={2}
                      step={0.01}
                      onChange={(v) => updateSection("voice", { pitch: v })}
                      disabled={!settings.voice.outputEnabled}
                    />
                  </Group>
                </>
              )}

              {section === "computer" && (
                <>
                  <Group title="LOCAL AGENT">
                    <StatusRow label="Local agent" value={agentLive ? "LINKED" : "OFFLINE"} ok={agentLive} />
                    <StatusRow label="Address" value={AGENT_URLS[0] ?? "—"} tone="neutral" />
                    <StatusRow
                      label="Computer tools"
                      value={settings.computer.agentEnabled ? "ENABLED" : "BLOCKED"}
                      ok={settings.computer.agentEnabled}
                    />
                    <ActionRow label="Re-check connection">
                      <HudButton onClick={() => checkAgentStatus().then(setAgentLive)}>PING</HudButton>
                    </ActionRow>
                  </Group>

                  <Group title="AUTOMATION" hint="Blocked tool calls return an error to the model instead of running.">
                    <ToggleRow
                      label="Computer control"
                      description="Master switch for shell, file, desktop and browser tools."
                      checked={settings.computer.agentEnabled}
                      onChange={(v) => updateSection("computer", { agentEnabled: v })}
                    />
                    <SliderRow
                      label="Health-check interval"
                      description="How often NEXUS pings the local agent."
                      value={settings.computer.pollSeconds}
                      min={2}
                      max={60}
                      step={1}
                      suffix="s"
                      onChange={(v) => updateSection("computer", { pollSeconds: v })}
                    />
                    <TextRow
                      label="Agent access token"
                      description="Shared secret. Set NEXUS_AGENT_TOKEN to the same value before starting the local agent so nothing else on your machine can command it. Empty = agent accepts any local caller."
                      value={settings.computer.agentToken}
                      placeholder="paste your NEXUS_AGENT_TOKEN"
                      onChange={(v) => updateSection("computer", { agentToken: v })}
                    />
                    <TextRow
                      label="App search folders"
                      description="Extra folders launch_app searches for app shortcuts, comma-separated. Your Desktop and its Others folder are always searched first."
                      value={settings.computer.appSearchDirs.join(", ")}
                      placeholder="D:\Apps, C:\Tools"
                      onChange={(v) =>
                        updateSection("computer", {
                          appSearchDirs: v.split(",").map((d) => d.trim()).filter(Boolean),
                        })
                      }
                    />
                  </Group>


                  <Group title="CONFIRMATIONS">
                    <ToggleRow
                      label="Confirm shell commands"
                      description="Prompt before run_command / open_path / open_url."
                      checked={settings.computer.confirmCommands}
                      onChange={(v) => updateSection("computer", { confirmCommands: v })}
                    />
                    <ToggleRow
                      label="Confirm file writes"
                      checked={settings.computer.confirmFileWrites}
                      onChange={(v) => updateSection("computer", { confirmFileWrites: v })}
                    />
                    <ToggleRow
                      label="Confirm desktop actions"
                      description="Clicks, typing and hotkeys. Reads and screenshots stay silent."
                      checked={settings.computer.confirmDesktopControl}
                      onChange={(v) => updateSection("computer", { confirmDesktopControl: v })}
                    />
                  </Group>
                </>
              )}

              {section === "coding" && (
                <>
                  <Group
                    title="WORKSPACE"
                    hint="NEXUS refuses any file, command or git action outside this folder."
                  >
                    <ToggleRow
                      label="Coding toolkit"
                      description="Patch editing, code search, project trees, background builds and git."
                      checked={settings.coding.enabled}
                      onChange={(v) => updateSection("coding", { enabled: v })}
                    />
                    <TextRow
                      label="Workspace root"
                      description="Absolute path, e.g. C:\Users\you\projects or /home/you/projects. Empty = no containment (not recommended)."
                      value={settings.coding.workspaceRoot}
                      placeholder="C:\Users\you\projects"

                      onChange={(v) => updateSection("coding", { workspaceRoot: v })}
                    />
                    <TextRow
                      label="Active project"
                      description="Optional subfolder NEXUS should work in by default."
                      value={settings.coding.activeProject}
                      placeholder="nexus-assistantv1"
                      onChange={(v) => updateSection("coding", { activeProject: v })}
                    />
                  </Group>

                  <Group title="SAFETY MODE">
                    <SelectRow
                      label="Execution mode"
                      description="Autonomous: NEXUS works freely inside the workspace. Confirm: you approve every write and command."
                      value={settings.coding.mode}
                      options={[
                        { value: "autonomous", label: "Free inside workspace" },
                        { value: "confirm", label: "Confirm every action" },
                      ]}
                      onChange={(v) =>
                        updateSection("coding", { mode: v as "autonomous" | "confirm" })
                      }
                    />
                    <ToggleRow
                      label="Automatic backups"
                      description="Timestamped copy in ~/.nexus/backups before every write or patch, so edits can be undone."
                      checked={settings.coding.backupsEnabled}
                      onChange={(v) => updateSection("coding", { backupsEnabled: v })}
                    />
                    <SliderRow
                      label="Command timeout"
                      description="Default wait for builds, installs and test suites."
                      value={settings.coding.commandTimeoutSec}
                      min={30}
                      max={900}
                      step={30}
                      suffix="s"
                      onChange={(v) => updateSection("coding", { commandTimeoutSec: v })}
                    />
                  </Group>

                  <Group title="GIT">
                    <ToggleRow
                      label="Git actions"
                      description="status, diff, branch and commit inside the workspace."
                      checked={settings.coding.gitEnabled}
                      onChange={(v) => updateSection("coding", { gitEnabled: v })}
                    />
                    <ToggleRow
                      label="Allow push"
                      description="Off: NEXUS can commit locally but never pushes to a remote."
                      checked={settings.coding.allowPush}
                      onChange={(v) => updateSection("coding", { allowPush: v })}
                    />
                  </Group>

                  <Group
                    title="GIT WORKFLOW"
                    hint={`Runs against ${workspacePath() || "your workspace root (not set)"}.`}
                  >
                    <TextRow
                      label="Commit message"
                      description="Optional — required before committing."
                      value={commitMessage}
                      placeholder="feat: agent logs panel"
                      onChange={setCommitMessage}
                    />
                    <TextRow
                      label="Branch"
                      description="Optional — switch to (or create) this branch before committing."
                      value={branchName}
                      placeholder="feature/agent-logs"
                      onChange={setBranchName}
                    />
                    <ToggleRow
                      label="Create branch if missing"
                      description="Uses git checkout -b when the branch doesn't exist yet."
                      checked={createBranch}
                      onChange={setCreateBranch}
                    />
                    <ActionRow
                      label="Commit"
                      description="Branch (optional) → status → commit. Results stream into the chat."
                    >
                      <HudButton
                        onClick={() =>
                          runCoding("commit", () =>
                            runGitWorkflow({
                              message: commitMessage,
                              branch: branchName,
                              createBranch,
                            }),
                          )
                        }
                      >
                        {codingBusy === "commit" ? "COMMITTING…" : "COMMIT"}
                      </HudButton>
                    </ActionRow>
                    <ActionRow
                      label="Commit & push"
                      description={
                        settings.coding.allowPush
                          ? "Asks for confirmation before pushing to the remote."
                          : "Enable “Allow push” above to push."
                      }
                    >
                      <HudButton
                        variant="danger"
                        onClick={() => {
                          if (!settings.coding.allowPush) {
                            setCodingResult({
                              ok: false,
                              summary: "Push is disabled in settings.",
                            });
                            return;
                          }
                          const target = branchName.trim() || "the current branch";
                          if (
                            !window.confirm(
                              `Commit and push to ${target} in ${workspacePath() || "the workspace"}?`,
                            )
                          )
                            return;
                          runCoding("push", () =>
                            runGitWorkflow({
                              message: commitMessage,
                              branch: branchName,
                              createBranch,
                              push: true,
                            }),
                          );
                        }}
                      >
                        {codingBusy === "push" ? "PUSHING…" : "COMMIT & PUSH"}
                      </HudButton>
                    </ActionRow>
                  </Group>

                  <Group title="RUN" hint="Output streams live into the chat as a tool card.">
                    <ActionRow label="Run tests" description="npm test in the active project.">
                      <HudButton
                        onClick={() =>
                          runCoding("tests", () => runProjectCommand("npm test", "run tests"))
                        }
                      >
                        {codingBusy === "tests" ? "RUNNING…" : "RUN TESTS"}
                      </HudButton>
                    </ActionRow>
                    <ActionRow label="Run build" description="npm run build in the active project.">
                      <HudButton
                        onClick={() =>
                          runCoding("build", () => runProjectCommand("npm run build", "run build"))
                        }
                      >
                        {codingBusy === "build" ? "BUILDING…" : "RUN BUILD"}
                      </HudButton>
                    </ActionRow>
                    <StatusRow
                      label="Last action"
                      value={
                        codingBusy
                          ? `${codingBusy} running…`
                          : (codingResult?.summary ?? "No action run yet")
                      }
                      {...(codingResult ? { ok: codingResult.ok } : {})}
                    />
                  </Group>

                  <Group title="RUN BUDGET" hint="How long a single autonomous coding run may work before pausing.">
                    <SliderRow
                      label="Max tool steps"
                      value={settings.coding.maxSteps}
                      min={20}
                      max={400}
                      step={10}
                      onChange={(v) => updateSection("coding", { maxSteps: v })}
                    />
                    <SliderRow
                      label="Max run time"
                      value={settings.coding.maxRunMinutes}
                      min={5}
                      max={120}
                      step={5}
                      suffix="min"
                      onChange={(v) => updateSection("coding", { maxRunMinutes: v })}
                    />
                  </Group>
                </>
              )}



              {section === "memory" && (
                <Group title="NEXUS MEMORY" hint="Permanent facts shared by every chat. Credentials are always refused.">
                  <ToggleRow
                    label="Memory enabled"
                    description="Off: no memories are injected and memory tools are blocked."
                    checked={settings.memory.enabled}
                    onChange={(v) => updateSection("memory", { enabled: v })}
                  />
                  <ToggleRow
                    label="Let NEXUS save memories"
                    description="Off: remember_fact is refused; you can still add memories manually."
                    checked={settings.memory.autoRemember}
                    onChange={(v) => updateSection("memory", { autoRemember: v })}
                    disabled={!settings.memory.enabled}
                  />
                  <SliderRow
                    label="Max memories injected"
                    description="Relevance-ranked memories added to each prompt."
                    value={settings.memory.maxInjected}
                    min={1}
                    max={20}
                    step={1}
                    onChange={(v) => updateSection("memory", { maxInjected: v })}
                    disabled={!settings.memory.enabled}
                  />
                  <StatusRow label="Stored memories" value={String(memoryCount)} tone="neutral" />
                  <StatusRow label="Credential guard" value="ALWAYS ON" ok />
                  <ActionRow
                    label="Manage memories"
                    description="Full memory management lives in the sidebar panel."
                  >
                    <HudButton onClick={onClose}>OPEN SIDEBAR PANEL</HudButton>
                  </ActionRow>
                </Group>
              )}

              {section === "devices" && (
                <Group title="ESP / IoT" hint="Projects are stored by the local agent, not in the browser.">
                  <ToggleRow
                    label="Device control"
                    description="Off: all ESP tools are blocked before execution."
                    checked={settings.devices.enabled}
                    onChange={(v) => updateSection("devices", { enabled: v })}
                  />
                  <ToggleRow
                    label="Confirm device actions"
                    description="Prompt before device_command and project deletion."
                    checked={settings.devices.confirmDeviceActions}
                    onChange={(v) => updateSection("devices", { confirmDeviceActions: v })}
                    disabled={!settings.devices.enabled}
                  />
                  <StatusRow
                    label="Registered projects"
                    value={espCount === null ? (espError ? "agent offline" : "…") : String(espCount)}
                    ok={espCount !== null}
                  />
                  <ActionRow label="NEXUS Hub" description="Register and control ESP projects.">
                    <Link
                      to="/devices"
                      onClick={onClose}
                      className="rounded border border-primary/50 px-3 py-1 font-display text-[11px] tracking-wider text-primary transition hover:bg-primary/10"
                    >
                      OPEN HUB
                    </Link>
                  </ActionRow>
                </Group>
              )}

              {section === "chat" && (
                <Group title="CONVERSATIONS" hint="History is stored in this browser only.">
                  <ToggleRow
                    label="Persist chat history"
                    description="Off: this session's messages are not written to storage."
                    checked={settings.chat.persistHistory}
                    onChange={(v) => updateSection("chat", { persistHistory: v })}
                  />
                  <ToggleRow
                    label="Automatic chat titles"
                    description="Derive the title from the first message you send."
                    checked={settings.chat.autoTitle}
                    onChange={(v) => updateSection("chat", { autoTitle: v })}
                  />
                  <ToggleRow
                    label="Show tool execution cards"
                    checked={settings.chat.showToolCards}
                    onChange={(v) => updateSection("chat", { showToolCards: v })}
                  />
                  <ToggleRow
                    label="Expand tool cards by default"
                    checked={settings.chat.expandToolCards}
                    onChange={(v) => updateSection("chat", { expandToolCards: v })}
                    disabled={!settings.chat.showToolCards}
                  />
                  <StatusRow label="Saved conversations" value={String(chatCount)} tone="neutral" />
                </Group>
              )}

              {section === "appearance" && (
                <Group title="HUD" hint="Changes apply instantly across NEXUS.">
                  <ToggleRow
                    label="HUD grid background"
                    checked={settings.appearance.hudGrid}
                    onChange={(v) => updateSection("appearance", { hudGrid: v })}
                  />
                  <SliderRow
                    label="Glow intensity"
                    value={settings.appearance.glow}
                    min={0}
                    max={150}
                    step={5}
                    suffix="%"
                    onChange={(v) => updateSection("appearance", { glow: v })}
                  />
                  <SelectRow
                    label="Animations"
                    description="Reduced keeps essential feedback and drops ambient motion."
                    value={settings.appearance.animations}
                    options={[
                      { value: "full", label: "Full" },
                      { value: "reduced", label: "Reduced" },
                      { value: "off", label: "Off" },
                    ]}
                    onChange={(v) => updateSection("appearance", { animations: v })}
                  />
                  <SelectRow
                    label="Interface density"
                    value={settings.appearance.density}
                    options={[
                      { value: "comfortable", label: "Comfortable" },
                      { value: "compact", label: "Compact" },
                    ]}
                    onChange={(v) => updateSection("appearance", { density: v })}
                  />
                </Group>
              )}

              {section === "security" && (
                <>
                  <Group
                    title="TOOL PERMISSIONS"
                    hint="Enforced in NEXUS before a tool runs — a blocked call never reaches your machine."
                  >
                    <ToggleRow
                      label="Read files"
                      description="read_file, list_dir, search_files"
                      checked={settings.security.permissions.readFiles}
                      onChange={(v) =>
                        updateSection("security", {
                          permissions: { ...settings.security.permissions, readFiles: v },
                        })
                      }
                    />
                    <ToggleRow
                      label="Write files"
                      description="write_file"
                      checked={settings.security.permissions.writeFiles}
                      onChange={(v) =>
                        updateSection("security", {
                          permissions: { ...settings.security.permissions, writeFiles: v },
                        })
                      }
                    />
                    <ToggleRow
                      label="Run commands"
                      description="run_command, open_path, open_url"
                      checked={settings.security.permissions.runCommands}
                      onChange={(v) =>
                        updateSection("security", {
                          permissions: { ...settings.security.permissions, runCommands: v },
                        })
                      }
                    />
                    <ToggleRow
                      label="Desktop control"
                      description="Screen reads, clicks, typing, hotkeys"
                      checked={settings.security.permissions.desktopControl}
                      onChange={(v) =>
                        updateSection("security", {
                          permissions: { ...settings.security.permissions, desktopControl: v },
                        })
                      }
                    />
                    <ToggleRow
                      label="Browser control"
                      description="Cowork Chrome automation"
                      checked={settings.security.permissions.browserControl}
                      onChange={(v) =>
                        updateSection("security", {
                          permissions: { ...settings.security.permissions, browserControl: v },
                        })
                      }
                    />
                    <ToggleRow
                      label="ESP / device control"
                      checked={settings.security.permissions.espControl}
                      onChange={(v) =>
                        updateSection("security", {
                          permissions: { ...settings.security.permissions, espControl: v },
                        })
                      }
                    />
                  </Group>

                  <Group title="CONFIRMATIONS">
                    <ToggleRow
                      label="Confirm destructive commands"
                      description="Pattern match on rm -rf, format, del /f, shutdown, DROP TABLE and similar."
                      checked={settings.security.confirmDestructive}
                      onChange={(v) => updateSection("security", { confirmDestructive: v })}
                    />
                  </Group>

                  <Group title="SENSITIVE DATA">
                    <StatusRow label="Credentials in memory store" value="REFUSED" ok />
                    <StatusRow label="API keys in browser settings" value="NEVER STORED" ok />
                    <StatusRow label="Provider keys" value="SERVER-SIDE SECRETS ONLY" ok />
                  </Group>

                  <p className="flex gap-2 px-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--jarvis-warn)]" />
                    Permissions are enforced in the NEXUS client that issues the tool call. The local
                    agent itself has no separate authentication, so anything else on this machine that
                    can reach it is unaffected by these switches.
                  </p>
                </>
              )}

              {section === "advanced" && (
                <>
                  <Group title="DIAGNOSTICS">
                    <StatusRow label="NEXUS version" value={NEXUS_VERSION} tone="neutral" />
                    <StatusRow label="Local agent" value={agentLive ? "LINKED" : "OFFLINE"} ok={agentLive} />
                    <StatusRow label="Active provider" value={activeProvider ?? "—"} tone="neutral" />
                    <StatusRow label="Active model" value={activeModel ?? "—"} tone="neutral" />
                    <StatusRow
                      label="Configured providers"
                      value={`${providers.filter((p) => p.configured).length}/${providers.length}`}
                      tone="neutral"
                    />
                    <StatusRow label="Conversations" value={String(chatCount)} tone="neutral" />
                    <StatusRow label="Memories" value={String(memoryCount)} tone="neutral" />
                    <StatusRow
                      label="ESP projects"
                      value={espCount === null ? "unavailable" : String(espCount)}
                      tone="neutral"
                    />
                  </Group>

                  <Group title="DEVELOPER">
                    <ToggleRow
                      label="Debug logging"
                      description="Verbose tool/router logging in the browser console."
                      checked={settings.advanced.debugLogging}
                      onChange={(v) => updateSection("advanced", { debugLogging: v })}
                    />
                  </Group>

                  <Group title="RESET" hint="Preferences only — chats, memories and ESP projects are never touched.">
                    <ActionRow
                      label="Reset all settings"
                      description="Restores every section to NEXUS defaults."
                    >
                      <HudButton variant="danger" onClick={() => setConfirmReset("all")}>
                        RESET ALL
                      </HudButton>
                    </ActionRow>
                  </Group>
                </>
              )}
            </div>
          </div>
        </div>

        {confirmReset && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/85 p-6">
            <div className="panel w-full max-w-md rounded-lg p-5">
              <h4 className="font-display text-sm tracking-widest text-primary">
                {confirmReset === "all" ? "RESET ALL SETTINGS" : `RESET ${currentSection.label.toUpperCase()}`}
              </h4>
              <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {confirmReset === "all"
                  ? "Every NEXUS preference returns to its default value."
                  : `Only the ${currentSection.label} preferences return to their defaults.`}{" "}
                Your conversations, permanent memories, ESP projects and credentials are not affected.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <HudButton onClick={() => setConfirmReset(null)}>CANCEL</HudButton>
                <HudButton
                  variant="danger"
                  onClick={() => {
                    if (confirmReset === "all") resetAllSettings();
                    else resetSection(section);
                    setConfirmReset(null);
                  }}
                >
                  CONFIRM
                </HudButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
