// NEXUS centralized settings store.
// Storage: browser localStorage (same persistence layer as chats & memory).
// NEVER stores secrets — API keys live only in server-side environment secrets.

export type ProviderIdSetting =
  | ""
  | "gemini"
  | "lovable"
  | "openrouter"
  | "cerebras"
  | "kilo"
  | "grok"
  | "groq"
  | "ollama";

export type NexusSettings = {
  general: {
    /** Which conversation NEXUS opens on startup. */
    startupChat: "last" | "new";
    /** Enter sends the message (Shift+Enter always inserts a newline). */
    sendOnEnter: boolean;
    /** Ask before deleting a conversation from the sidebar. */
    confirmChatDelete: boolean;
  };
  ai: {
    /** Let the router classify the task and pick provider/model automatically. */
    autoRouting: boolean;
    /** Pinned provider when auto routing is off. */
    providerId: ProviderIdSetting;
    /** Pinned model id (must belong to the pinned provider). */
    modelId: string;
    /** Allow falling back to other providers when the first choice fails. */
    failover: boolean;
    /** Hard cap on provider/model attempts per request. */
    maxAttempts: number;
    /** Optional custom Ollama host (empty = 127.0.0.1:11434 on this machine). */
    ollamaBaseUrl: string;
  };
  voice: {
    inputEnabled: boolean;
    outputEnabled: boolean;
    requireWakeWord: boolean;
    wakeWord: string;
    /** SpeechSynthesis voiceURI; empty = automatic NEXUS voice pick. */
    voiceURI: string;
    rate: number;
    pitch: number;
    lang: string;
  };
  computer: {
    /** Master switch for local-agent (computer control) tools. */
    agentEnabled: boolean;
    /** Health-check interval for the local agent, in seconds. */
    pollSeconds: number;
    /** Shared secret matching NEXUS_AGENT_TOKEN on the local agent (optional). */
    agentToken: string;
    confirmCommands: boolean;
    confirmFileWrites: boolean;
    confirmDesktopControl: boolean;
    /** Extra folders launch_app searches for app shortcuts (in addition to Desktop and Desktop\Others). */
    appSearchDirs: string[];
  };
  memory: {
    enabled: boolean;
    /** Allow NEXUS to save new memories itself via remember_fact. */
    autoRemember: boolean;
    /** Max relevant memories injected into a prompt. */
    maxInjected: number;
  };
  devices: {
    /** Master switch for ESP/IoT tools. */
    enabled: boolean;
    confirmDeviceActions: boolean;
  };
  chat: {
    persistHistory: boolean;
    showToolCards: boolean;
    expandToolCards: boolean;
    /** Derive a chat title from the first user message. */
    autoTitle: boolean;
  };
  appearance: {
    hudGrid: boolean;
    /** 0–150 % glow strength. */
    glow: number;
    animations: "full" | "reduced" | "off";
    density: "compact" | "comfortable";
  };
  security: {
    permissions: {
      readFiles: boolean;
      writeFiles: boolean;
      runCommands: boolean;
      desktopControl: boolean;
      browserControl: boolean;
      espControl: boolean;
    };
    /** Ask before commands that look destructive (rm, format, del /f …). */
    confirmDestructive: boolean;
  };
  coding: {
    /** Master switch for the autonomous coding toolkit. */
    enabled: boolean;
    /** Absolute folder NEXUS may work in. Everything outside is refused. */
    workspaceRoot: string;
    /** Optional project subfolder inside the workspace. */
    activeProject: string;
    /** autonomous = free inside the workspace; confirm = ask for every write/command. */
    mode: "autonomous" | "confirm";
    /** Default timeout for builds/tests, in seconds (1–900). */
    commandTimeoutSec: number;
    /** Keep a timestamped backup before every write/patch. */
    backupsEnabled: boolean;
    gitEnabled: boolean;
    allowPush: boolean;
    /** Tool-step budget for a single autonomous coding run. */
    maxSteps: number;
    /** Wall-clock budget for a single run, in minutes. */
    maxRunMinutes: number;
  };
  advanced: {
    /** Verbose agent/tool logging in the browser console. */
    debugLogging: boolean;
  };

};

export type SettingsSection = keyof NexusSettings;

export const DEFAULT_SETTINGS: NexusSettings = {
  general: { startupChat: "last", sendOnEnter: true, confirmChatDelete: true },
  ai: {
    autoRouting: true,
    providerId: "",
    modelId: "",
    failover: true,
    maxAttempts: 40,
    ollamaBaseUrl: "",
  },
  voice: {
    inputEnabled: true,
    outputEnabled: true,
    requireWakeWord: false,
    wakeWord: "nexus",
    voiceURI: "",
    rate: 1.02,
    pitch: 0.95,
    lang: "en-US",
  },
  computer: {
    agentEnabled: true,
    pollSeconds: 5,
    agentToken: "",
    confirmCommands: false,
    confirmFileWrites: false,
    confirmDesktopControl: false,
    appSearchDirs: [],
  },
  memory: { enabled: true, autoRemember: true, maxInjected: 8 },
  devices: { enabled: true, confirmDeviceActions: true },
  chat: { persistHistory: true, showToolCards: true, expandToolCards: true, autoTitle: true },
  appearance: { hudGrid: true, glow: 100, animations: "full", density: "comfortable" },
  security: {
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      desktopControl: true,
      browserControl: true,
      espControl: true,
    },
    confirmDestructive: true,
  },
  coding: {
    enabled: true,
    workspaceRoot: "",
    activeProject: "",
    mode: "autonomous",
    commandTimeoutSec: 300,
    backupsEnabled: true,
    gitEnabled: true,
    allowPush: false,
    maxSteps: 120,
    maxRunMinutes: 30,
  },
  advanced: { debugLogging: false },

};

const KEY = "nexus.settings.v1";

const listeners = new Set<() => void>();
let cache: NexusSettings | null = null;

function hasWindow() {
  return typeof window !== "undefined";
}

/** Merge an untrusted partial settings object onto the defaults. Pure — safe on the server. */
export function mergeSettings(raw: unknown): NexusSettings {
  return mergeDefaults(raw);
}

function mergeDefaults(raw: unknown): NexusSettings {
  const base = structuredCloneSafe(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Record<string, any>;
  for (const section of Object.keys(base) as SettingsSection[]) {
    const stored = input[section];
    if (!stored || typeof stored !== "object") continue;
    const target = base[section] as Record<string, any>;
    for (const key of Object.keys(target)) {
      const value = stored[key];
      if (value === undefined || value === null) continue;
      // Legacy default (6) from before the cap was raised — upgrade to 40.
      if (section === "ai" && key === "maxAttempts" && value === 6) continue;
      if (key === "permissions" && typeof value === "object") {
        target[key] = { ...target[key], ...value };
        continue;
      }
      if (typeof value === typeof target[key]) target[key] = value;
    }
  }
  return base;
}

function structuredCloneSafe(value: NexusSettings): NexusSettings {
  return JSON.parse(JSON.stringify(value)) as NexusSettings;
}

export function getSettings(): NexusSettings {
  if (cache) return cache;
  if (!hasWindow()) return structuredCloneSafe(DEFAULT_SETTINGS);
  let parsed: unknown = null;
  try {
    const raw = window.localStorage.getItem(KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = mergeDefaults(parsed);
  return cache;
}

function persist(next: NexusSettings) {
  cache = next;
  if (hasWindow()) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota — settings stay in memory for this session */
    }
    applyAppearance(next.appearance);
  }
  listeners.forEach((l) => l());
}

export function subscribeSettings(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Patch a single settings section; unspecified keys keep their current value. */
export function updateSection<S extends SettingsSection>(
  section: S,
  patch: Partial<NexusSettings[S]>,
) {
  const current = getSettings();
  const next: NexusSettings = {
    ...current,
    [section]: { ...current[section], ...patch },
  };
  persist(next);
}

/** Reset one section back to its defaults. Never touches chats, memory or devices. */
export function resetSection(section: SettingsSection) {
  const current = getSettings();
  const next: NexusSettings = {
    ...current,
    [section]: structuredCloneSafe(DEFAULT_SETTINGS)[section],
  };
  persist(next);
}

/** Reset every preference. Chats, memory, ESP projects and credentials are untouched. */
export function resetAllSettings() {
  persist(structuredCloneSafe(DEFAULT_SETTINGS));
}

/** Apply the visual preferences to the document immediately. */
export function applyAppearance(a: NexusSettings["appearance"]) {
  if (!hasWindow()) return;
  const root = document.documentElement;
  root.dataset["nexusHud"] = a.hudGrid ? "on" : "off";
  root.dataset["nexusAnim"] = a.animations;
  root.dataset["nexusDensity"] = a.density;
  root.style.setProperty("--nexus-glow", String(Math.max(0, Math.min(150, a.glow)) / 100));
}

/** Call once on mount so stored appearance survives a reload. */
export function initSettings() {
  applyAppearance(getSettings().appearance);
}
