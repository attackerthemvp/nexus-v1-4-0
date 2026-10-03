// Persistent multi-chat store for NEXUS.
// Storage: browser localStorage (the app has no backend database).
// Every chat keeps its own durable message history so contexts never mix.

import { getSettings } from "@/lib/settings-store";
export type ToolCallRecord = { name: string; args: any; result: string; id?: string };

export type ChatMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  display?: { tools?: ToolCallRecord[] };
  /** Execution-controller bookkeeping: sent to the model, never shown in chat. */
  internal?: boolean;
  ts?: number;
};

export type Chat = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: ChatMessage[];
};

export type ChatSummary = Omit<Chat, "messages">;

const KEY = "jarvis.chats.v1";
const ACTIVE_KEY = "jarvis.active-chat.v1";
const LEGACY_KEYS = ["jarvis.messages", "jarvis-messages", "jarvis.chat.messages"];

export const GREETING: ChatMessage = {
  role: "assistant",
  content:
    "**Online.** All systems nominal, sir. Local agent link initializing — say the word and I'll get to work.",
};

const listeners = new Set<() => void>();

export function subscribeChats(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit() {
  listeners.forEach((l) => l());
}

function hasWindow() {
  return typeof window !== "undefined";
}

export function newId() {
  if (hasWindow() && window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readAll(): Chat[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Chat[];
    }
  } catch {
    /* corrupted storage — fall through to migration */
  }
  const migrated = migrateLegacy();
  if (migrated.length) writeAll(migrated);
  return migrated;
}

function writeAll(chats: Chat[]) {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(chats));
  } catch {
    /* quota — ignore */
  }
  emit();
}

// Preserve any single pre-existing conversation as the first chat.
function migrateLegacy(): Chat[] {
  if (!hasWindow()) return [];
  for (const k of LEGACY_KEYS) {
    try {
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      const msgs = JSON.parse(raw);
      if (!Array.isArray(msgs) || msgs.length === 0) continue;
      const firstUser = msgs.find((m: any) => m?.role === "user");
      const now = Date.now();
      return [
        {
          id: newId(),
          title: generateTitle(typeof firstUser?.content === "string" ? firstUser.content : "") || "Previous Session",
          created_at: now,
          updated_at: now,
          messages: msgs as ChatMessage[],
        },
      ];
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function listChats(): ChatSummary[] {
  return readAll()
    .map(({ messages: _m, ...rest }) => rest)
    .sort((a, b) => b.updated_at - a.updated_at);
}

export function getChat(id: string): Chat | null {
  return readAll().find((c) => c.id === id) ?? null;
}

export function createChat(title = "New Chat"): Chat {
  const now = Date.now();
  const chat: Chat = { id: newId(), title, created_at: now, updated_at: now, messages: [GREETING] };
  writeAll([chat, ...readAll()]);
  return chat;
}

/** Reuse an existing empty chat instead of creating duplicates. */
export function createOrReuseEmptyChat(): Chat {
  const empty = readAll()
    .filter((c) => !c.messages.some((m) => m.role === "user"))
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  if (empty) return empty;
  return createChat();
}

export function saveMessages(id: string, messages: ChatMessage[]) {
  // Settings → Chat → "Persist chat history": when off, the session stays in
  // memory and nothing new is written to localStorage.
  if (!getSettings().chat.persistHistory) return;
  const chats = readAll();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const chat = chats[idx];
  if (!chat) return;
  chat.messages = messages;
  chat.updated_at = Date.now();
  if (chat.title === "New Chat" && getSettings().chat.autoTitle) {
    const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string");
    if (firstUser) chat.title = generateTitle(firstUser.content as string) || chat.title;
  }
  chats[idx] = chat;
  writeAll(chats);
}


export function renameChat(id: string, title: string) {
  const chats = readAll();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  chat.title = title.trim().slice(0, 80) || chat.title;
  chat.updated_at = Date.now();
  writeAll(chats);
}

export function deleteChat(id: string) {
  writeAll(readAll().filter((c) => c.id !== id));
}

export function getActiveChatId(): string | null {
  if (!hasWindow()) return null;
  return window.localStorage.getItem(ACTIVE_KEY);
}

export function setActiveChatId(id: string) {
  if (!hasWindow()) return;
  window.localStorage.setItem(ACTIVE_KEY, id);
}

/** Pick the chat to open on startup, honouring Settings → General. */
export function resolveStartupChatId(): string {
  const chats = listChats();
  if (getSettings().general.startupChat === "new") return createOrReuseEmptyChat().id;
  const active = getActiveChatId();
  if (active && chats.some((c) => c.id === active)) return active;
  const first = chats[0];
  if (first) return first.id;
  return createChat().id;
}


const STOP = new Set([
  "jarvis", "nexus", "hey", "hi", "hello", "please", "can", "you", "the", "a", "an", "my", "me", "i",
  "to", "for", "of", "on", "in", "with", "and", "is", "are", "do", "does", "how", "what",
  "help", "want", "need", "would", "could", "should", "let", "us", "it", "that", "this",
  "sir", "ok", "okay", "now", "just", "get", "got", "have", "be",
]);

/** Deterministic local title generation — no extra AI calls. */
export function generateTitle(first: string): string {
  const clean = (first || "").replace(/[`*_#>|]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const words = clean.split(" ");
  const kept: string[] = [];
  for (const w of words) {
    const bare = w.replace(/^[^\w-]+|[^\w-]+$/g, "");
    if (!bare) continue;
    if (STOP.has(bare.toLowerCase()) && kept.length < 6) continue;
    kept.push(bare);
    if (kept.length >= 6) break;
  }
  const source = kept.length ? kept : words.slice(0, 6);
  const title = source
    .map((w) => (/[A-Z0-9]{2,}/.test(w) || /\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return title.slice(0, 60);
}

/** Search chats by title AND message content. */
export function searchChats(query: string): ChatSummary[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return listChats();
  return readAll()
    .filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => typeof m.content === "string" && m.content.toLowerCase().includes(q));
    })
    .map(({ messages: _m, ...rest }) => rest)
    .sort((a, b) => b.updated_at - a.updated_at);
}
