// Memory tools run in the browser (localStorage), not on the local agent.
import {
  addMemory,
  forgetByText,
  listMemories,
  searchMemories,
  type MemoryCategory,
} from "@/lib/memory-store";

export const MEMORY_TOOL_NAMES = ["remember_fact", "forget_fact", "recall_memories"] as const;

export function isMemoryTool(name: string) {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

export function executeMemoryTool(name: string, args: Record<string, any>): string {
  try {
    if (name === "remember_fact") {
      const res = addMemory(String(args['text'] ?? ""), (args['category'] as MemoryCategory) || "fact");
      if (!res.ok) return JSON.stringify({ saved: false, reason: res.reason });
      return JSON.stringify({
        saved: true,
        permanent: true,
        memory: res.memory,
        note: res.reason ?? "Saved to permanent memory (available in every chat).",
      });
    }
    if (name === "forget_fact") {
      const removed = forgetByText(String(args['query'] ?? ""));
      return JSON.stringify({
        forgotten: removed.length,
        removed: removed.map((m) => m.text),
      });
    }
    if (name === "recall_memories") {
      const q = String(args['query'] ?? "").trim();
      const items = q ? searchMemories(q) : listMemories();
      return JSON.stringify({
        count: items.length,
        memories: items.slice(0, 40).map((m) => ({ text: m.text, category: m.category })),
      });
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
  return `ERROR: unknown memory tool ${name}`;
}
