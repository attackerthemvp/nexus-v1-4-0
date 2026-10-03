import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  addMemory,
  deleteMemory,
  listMemories,
  subscribeMemories,
  updateMemory,
  type Memory,
  type MemoryCategory,
} from "@/lib/memory-store";

const CATEGORIES: MemoryCategory[] = ["preference", "project", "device", "fact", "instruction"];

export function MemoryPanel() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setMemories(listMemories());
    sync();
    return subscribeMemories(sync);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter(
      (m) => m.text.toLowerCase().includes(q) || m.category.includes(q) || m.tags.some((t) => t.includes(q)),
    );
  }, [memories, query]);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-1 pb-2 font-display text-[10px] tracking-widest text-muted-foreground transition hover:text-primary"
      >
        <Brain size={12} className="text-accent" />
        NEXUS MEMORY
        <span className="ml-auto font-mono text-[10px] text-accent">{memories.length}</span>
      </button>

      {open && (
        <div className="space-y-2">
          <div className="flex gap-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory…"
              className="min-w-0 flex-1 rounded bg-input/60 px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:border-accent focus:outline-none border border-border"
            />
            <button
              onClick={() => {
                setAdding((a) => !a);
                setError("");
              }}
              title="Add memory"
              className="rounded border border-border px-2 text-muted-foreground transition hover:border-accent hover:text-accent"
            >
              <Plus size={12} />
            </button>
          </div>

          {adding && (
            <div className="space-y-1">
              <textarea
                autoFocus
                rows={2}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="e.g. I prefer dark mode terminals"
                className="w-full resize-none rounded border border-border bg-input/60 px-2 py-1 font-mono text-[11px] text-foreground focus:border-accent focus:outline-none"
              />
              <button
                onClick={() => {
                  const res = addMemory(newText, "fact");
                  if (!res.ok) {
                    setError(res.reason ?? "Could not save.");
                    return;
                  }
                  setNewText("");
                  setAdding(false);
                  setError("");
                }}
                className="w-full rounded border border-accent/60 bg-accent/10 py-1 font-display text-[10px] tracking-widest text-accent transition hover:bg-accent/20"
              >
                SAVE TO MEMORY
              </button>
            </div>
          )}
          {error && <p className="px-1 font-mono text-[10px] text-destructive">{error}</p>}

          <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {filtered.length === 0 && (
              <p className="px-1 font-mono text-[11px] text-muted-foreground">
                {memories.length ? "No matching memories." : "Nothing remembered yet."}
              </p>
            )}
            {filtered.map((m) => (
              <div
                key={m.id}
                className="group rounded-md border border-border/70 bg-muted/10 px-2 py-1.5 text-[11px]"
              >
                {editing === m.id ? (
                  <div className="space-y-1">
                    <textarea
                      autoFocus
                      rows={3}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="w-full resize-none rounded bg-input/60 px-1 py-0.5 font-mono text-[11px] text-foreground focus:outline-none"
                    />
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          updateMemory(m.id, draft);
                          setEditing(null);
                        }}
                        className="text-primary hover:text-accent"
                        title="Save"
                      >
                        <Check size={12} />
                      </button>
                      <button onClick={() => setEditing(null)} className="text-muted-foreground" title="Cancel">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-1">
                      <p className="min-w-0 flex-1 font-mono text-foreground/90">{m.text}</p>
                      <button
                        onClick={() => {
                          setDraft(m.text);
                          setEditing(m.id);
                        }}
                        title="Edit memory"
                        className="opacity-0 transition group-hover:opacity-100 hover:text-accent"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => deleteMemory(m.id)}
                        title="Delete memory"
                        className="opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <span className="mt-1 inline-block rounded border border-accent/40 px-1 font-display text-[9px] tracking-widest text-accent/80">
                      {m.category.toUpperCase()}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setQuery(c)}
                  className="rounded border border-border px-1 font-display text-[9px] tracking-widest text-muted-foreground transition hover:border-accent hover:text-accent"
                >
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
