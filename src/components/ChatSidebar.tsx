import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Pencil, Plus, Trash2, Cpu, Search } from "lucide-react";
import { MemoryPanel } from "@/components/MemoryPanel";
import {
  deleteChat,
  listChats,
  renameChat,
  searchChats,
  subscribeChats,
  type ChatSummary,
} from "@/lib/chat-store";
import { getSettings } from "@/lib/settings-store";

export function ChatSidebar({
  activeId,
  onNewChat,
  onSelect,
  onDeleted,
}: {
  activeId: string;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const sync = () => {
      setChats(listChats());
      setTick((t) => t + 1);
    };
    sync();
    return subscribeChats(sync);
  }, []);

  const visible = useMemo(
    () => (query.trim() ? searchChats(query) : chats),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, chats, tick],
  );


  return (
    <aside className="panel flex h-screen w-64 shrink-0 flex-col rounded-none border-y-0 border-l-0 px-3 py-4">
      <div className="px-1 pb-3">
        <h2 className="font-display text-lg tracking-widest text-primary text-glow">NEXUS</h2>
      </div>

      <button
        onClick={onNewChat}
        className="mb-4 flex items-center justify-center gap-2 rounded-md border border-primary/50 bg-primary/10 px-3 py-2 font-display text-sm tracking-wider text-primary transition hover:bg-primary/20 glow-ring"
      >
        <Plus size={16} /> NEW CHAT
      </button>

      <div className="relative mb-3">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats & messages…"
          className="w-full rounded-md border border-border bg-input/60 py-1.5 pl-7 pr-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
        />
      </div>

      <div className="px-1 pb-2 text-[10px] font-display tracking-widest text-muted-foreground">
        {query.trim() ? "SEARCH RESULTS" : "RECENT CHATS"}
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto pr-1">
        {visible.length === 0 && (
          <p className="px-2 text-xs font-mono text-muted-foreground">
            {query.trim() ? "No matching chats." : "No conversations yet."}
          </p>
        )}
        {visible.map((c) => {

          const active = c.id === activeId;
          return (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-md px-2 py-2 text-sm transition ${
                active
                  ? "border border-primary/50 bg-primary/15 text-primary text-glow"
                  : "border border-transparent text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground"
              }`}
            >
              <MessageSquare size={14} className="shrink-0 opacity-70" />
              {editing === c.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    renameChat(c.id, draft);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      renameChat(c.id, draft);
                      setEditing(null);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="w-full min-w-0 rounded bg-input/60 px-1 py-0.5 font-mono text-xs text-foreground focus:outline-none"
                />
              ) : (
                <>
                  <button
                    onClick={() => onSelect(c.id)}
                    className="min-w-0 flex-1 truncate text-left font-mono text-xs"
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <button
                    onClick={() => {
                      setDraft(c.title);
                      setEditing(c.id);
                    }}
                    title="Rename chat"
                    className="opacity-0 transition group-hover:opacity-100 hover:text-accent"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => {
                      if (
                        getSettings().general.confirmChatDelete &&
                        !window.confirm(`Delete "${c.title}"?`)
                      )
                        return;
                      deleteChat(c.id);
                      if (c.id === activeId) onDeleted(c.id);
                    }}
                    title="Delete chat"
                    className="opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <MemoryPanel />


      <Link
        to="/devices"
        className="mt-3 flex items-center gap-2 rounded-md border border-border px-3 py-2 font-display text-xs tracking-wider text-muted-foreground transition hover:border-primary hover:text-primary"
      >
        <Cpu size={14} /> NEXUS HUB
      </Link>
    </aside>
  );
}
