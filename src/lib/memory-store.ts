// NEXUS Memory — persistent cross-chat memory.
// Storage: browser localStorage (separate from per-chat history in chat-store.ts).
// Chat history = temporary conversation context. Memory = long-term facts shared by ALL chats.

export type MemoryCategory =
  | "preference"
  | "project"
  | "device"
  | "fact"
  | "instruction";

export type Memory = {
  id: string;
  text: string;
  category: MemoryCategory;
  tags: string[];
  created_at: number;
  updated_at: number;
};

const KEY = "jarvis.memories.v1";

const listeners = new Set<() => void>();

export function subscribeMemories(fn: () => void) {
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

function newId() {
  if (hasWindow() && window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Reject anything that looks like a credential — never persisted. */
const SECRET_PATTERNS: RegExp[] = [
  /\bpassw(or)?d\b/i,
  /\bpass(code|phrase)\b/i,
  /\bapi[_ -]?key\b/i,
  /\bsecret\b/i,
  /\baccess[_ -]?token\b/i,
  /\bauth(orization)?[_ -]?token\b/i,
  /\bbearer\s+[A-Za-z0-9._-]{12,}/i,
  /\bpin\s*(is|=|:)\s*\d{3,}/i,
  /\bcredit\s*card\b|\bcvv\b/i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bsb_(secret|publishable)_[A-Za-z0-9]{10,}\b/,
  /\bAKIA[0-9A-Z]{12,}\b/,
  /\bgh[pous]_[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

export function looksSensitive(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function readMemories(): Memory[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Memory[]) : [];
  } catch {
    return [];
  }
}

function writeMemories(items: Memory[]) {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* quota — ignore */
  }
  emit();
}

export function listMemories(): Memory[] {
  return readMemories().sort((a, b) => b.updated_at - a.updated_at);
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "my", "me", "i", "you", "your", "to", "for", "of",
  "on", "in", "with", "and", "or", "that", "this", "it", "at", "as", "be", "do", "does",
  "jarvis", "nexus", "please", "sir", "remember", "forget", "about", "have", "has", "use", "uses",
]);

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s._-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function deriveTags(text: string): string[] {
  return Array.from(new Set(tokenize(text))).slice(0, 12);
}

export function addMemory(
  text: string,
  category: MemoryCategory = "fact",
): { ok: boolean; memory?: Memory; reason?: string } {
  const clean = (text || "").trim().replace(/\s+/g, " ").slice(0, 500);
  if (clean.length < 3) return { ok: false, reason: "Memory text too short." };
  if (looksSensitive(clean))
    return {
      ok: false,
      reason: "Refused: looks like a credential/secret. Passwords, keys and tokens are never stored.",
    };

  const items = readMemories();
  // De-duplicate near-identical memories instead of piling up.
  const norm = clean.toLowerCase();
  const existing = items.find((m) => m.text.toLowerCase() === norm);
  if (existing) {
    existing.updated_at = Date.now();
    existing.category = category;
    writeMemories(items);
    return { ok: true, memory: existing, reason: "Already remembered — refreshed." };
  }

  const now = Date.now();
  const memory: Memory = {
    id: newId(),
    text: clean,
    category,
    tags: deriveTags(clean),
    created_at: now,
    updated_at: now,
  };
  writeMemories([memory, ...items]);
  return { ok: true, memory };
}

export function updateMemory(id: string, text: string, category?: MemoryCategory) {
  const clean = (text || "").trim().slice(0, 500);
  if (!clean || looksSensitive(clean)) return false;
  const items = readMemories();
  const m = items.find((x) => x.id === id);
  if (!m) return false;
  m.text = clean;
  m.tags = deriveTags(clean);
  if (category) m.category = category;
  m.updated_at = Date.now();
  writeMemories(items);
  return true;
}

export function deleteMemory(id: string) {
  writeMemories(readMemories().filter((m) => m.id !== id));
}

/** Delete by fuzzy text match — used by the "forget that..." tool. */
export function forgetByText(query: string): Memory[] {
  const q = tokenize(query);
  if (!q.length) return [];
  const items = readMemories();
  const removed = items.filter((m) => {
    const hay = m.text.toLowerCase();
    const hits = q.filter((t) => hay.includes(t)).length;
    return hits >= Math.max(1, Math.ceil(q.length * 0.6));
  });
  if (removed.length) writeMemories(items.filter((m) => !removed.includes(m)));
  return removed;
}

export function searchMemories(query: string): Memory[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return listMemories();
  return listMemories().filter(
    (m) => m.text.toLowerCase().includes(q) || m.category.includes(q) || m.tags.some((t) => t.includes(q)),
  );
}

/**
 * Retrieve only the memories relevant to the current turn — keeps prompts small.
 * Persistent instructions and preferences are always included (they are directives),
 * everything else must earn its place via keyword overlap.
 */
export function relevantMemories(text: string, limit = 8): Memory[] {
  const items = listMemories();
  if (!items.length) return [];
  const q = tokenize(text);
  const scored = items.map((m) => {
    let score = 0;
    for (const t of q) {
      if (m.tags.includes(t)) score += 2;
      else if (m.text.toLowerCase().includes(t)) score += 1;
    }
    if (m.category === "instruction" || m.category === "preference") score += 3;
    return { m, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.updated_at - a.m.updated_at)
    .slice(0, limit)
    .map((s) => s.m);
}
