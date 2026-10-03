import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Cpu, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import {
  deleteEspProject,
  espProjectStatus,
  listEspProjects,
  runEspCommand,
  saveEspProject,
  type EspAction,
  type EspExecResult,
  type EspProject,
} from "@/lib/esp-projects";

export const Route = createFileRoute("/devices")({
  head: () => ({
    meta: [
      { title: "NEXUS Hub — ESP / Device Control" },
      {
        name: "description",
        content:
          "Register, edit and test ESP8266/ESP32 projects that NEXUS can control over your local network.",
      },
      { property: "og:title", content: "NEXUS Hub — ESP / Devices" },
      { property: "og:description", content: "Generic ESP/IoT project registry for NEXUS." },
    ],
  }),
  component: DevicesPage,
});

const TEMPLATE = `{
  "name": "Smart Aquarium",
  "description": "ESP32 aquarium controller",
  "host": "192.168.1.42",
  "protocol": "http",
  "devices": [
    {
      "id": "pump",
      "name": "Water Pump",
      "commands": [
        { "id": "on", "name": "Turn On", "method": "POST", "endpoint": "/pump/on" },
        { "id": "off", "name": "Turn Off", "method": "POST", "endpoint": "/pump/off" }
      ]
    }
  ]
}`;

function DevicesPage() {
  const [projects, setProjects] = useState<EspProject[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const list = await listEspProjects();
      setProjects(list);
      setError("");
      for (const p of list) {
        espProjectStatus(p.id)
          .then((s) =>
            setStatus((prev) => ({ ...prev, [p.id]: s.online ? `ONLINE ${s.latency_ms}ms` : "OFFLINE" })),
          )
          .catch(() => setStatus((prev) => ({ ...prev, [p.id]: "UNKNOWN" })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function saveJson(raw: string) {
    try {
      await saveEspProject(JSON.parse(raw));
      setEditor(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const open = useMemo(() => projects.find((p) => p.id === openId) ?? null, [projects, openId]);

  return (
    <div className="min-h-screen">
      <header className="panel flex items-center justify-between px-6 py-3 rounded-none border-x-0 border-t-0">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-primary hover:text-accent">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="font-display text-xl text-glow text-primary">NEXUS HUB</h1>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="panel px-3 py-2 text-xs font-mono text-primary hover:bg-primary/10">
            <RefreshCw size={14} className="inline mr-1" /> REFRESH
          </button>
          <button
            onClick={() => setEditor(TEMPLATE)}
            className="rounded-md bg-primary px-3 py-2 text-xs font-display tracking-wider text-primary-foreground hover:bg-accent"
          >
            <Plus size={14} className="inline mr-1" /> NEW PROJECT
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-6 space-y-4">
        {error && (
          <div className="panel border-destructive/60 p-3 text-sm text-destructive font-mono">{error}</div>
        )}
        {loading && <p className="text-sm text-muted-foreground font-mono">Loading from local agent…</p>}
        {!loading && projects.length === 0 && (
          <div className="panel p-6 text-sm text-muted-foreground">
            No ESP projects registered yet. Create one here, or just tell NEXUS in chat:{" "}
            <span className="text-primary font-mono">
              "I made a project called Smart Aquarium at 192.168.1.42. POST /pump/on turns the pump on…"
            </span>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((p) => {
            const commands = p.devices.reduce((n, d) => n + d.commands.length, 0);
            const sensors = p.devices.reduce((n, d) => n + d.sensors.length, 0);
            return (
              <div key={p.id} className="panel p-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="font-display text-lg text-primary text-glow">{p.name}</h2>
                    <p className="text-xs text-muted-foreground">{p.description || "—"}</p>
                  </div>
                  <span
                    className={`text-[10px] font-mono tracking-wider ${
                      status[p.id]?.startsWith("ONLINE") ? "text-primary" : "text-destructive"
                    }`}
                  >
                    {status[p.id] ?? "…"}
                  </span>
                </div>
                <p className="font-mono text-xs text-foreground/80">
                  {p.protocol}://{p.host}
                  {p.port ? `:${p.port}` : ""}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {p.devices.length} device(s) · {commands} command(s) · {sensors} sensor(s) · auth:{" "}
                  {p.auth?.type ?? "none"}
                </p>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setOpenId(openId === p.id ? null : p.id)}
                    className="panel px-3 py-1.5 text-xs font-mono text-primary hover:bg-primary/10"
                  >
                    {openId === p.id ? "HIDE" : "OPEN"}
                  </button>
                  <button
                    onClick={() => setEditor(JSON.stringify(p, null, 2))}
                    className="panel px-3 py-1.5 text-xs font-mono text-primary hover:bg-primary/10"
                  >
                    EDIT
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete project "${p.name}"?`)) return;
                      await deleteEspProject(p.id).catch((e) => setError(String(e)));
                      refresh();
                    }}
                    className="panel px-3 py-1.5 text-xs font-mono text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 size={12} className="inline" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {open && (
          <div className="panel p-4 space-y-4">
            <h2 className="font-display text-primary text-glow flex items-center gap-2">
              <Cpu size={16} /> {open.name}
            </h2>
            {open.devices.map((d) => (
              <div key={d.id} className="space-y-2">
                <h3 className="font-mono text-sm text-foreground">
                  {d.name} <span className="text-muted-foreground">({d.id})</span>
                </h3>
                <div className="grid gap-2">
                  {[...d.commands, ...d.sensors].map((a) => (
                    <ActionRow key={a.id} project={open.id} device={d.id} action={a} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {editor !== null && (
          <div className="panel p-4 space-y-3">
            <h2 className="font-display text-primary">PROJECT DEFINITION (JSON)</h2>
            <textarea
              value={editor}
              onChange={(e) => setEditor(e.target.value)}
              rows={18}
              spellCheck={false}
              className="w-full rounded-md bg-input/60 border border-border px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:border-primary"
            />
            <div className="flex gap-2">
              <button
                onClick={() => saveJson(editor)}
                className="rounded-md bg-primary px-4 py-2 text-xs font-display tracking-wider text-primary-foreground hover:bg-accent"
              >
                SAVE
              </button>
              <button
                onClick={() => setEditor(null)}
                className="panel px-4 py-2 text-xs font-mono text-muted-foreground hover:bg-muted/20"
              >
                CANCEL
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionRow({ project, device, action }: { project: string; device: string; action: EspAction }) {
  const params = action.parameters ?? {};
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<EspExecResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    if (action.confirm && !confirm(`Run "${action.name}"? This is marked as destructive.`)) return;
    setBusy(true);
    try {
      setResult(await runEspCommand(project, device, action.id, values));
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-border/70 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="font-mono text-xs">
          <span className="text-primary">{action.method}</span>{" "}
          <span className="text-foreground">{action.endpoint}</span>{" "}
          <span className="text-muted-foreground">— {action.name}</span>
        </div>
        <button
          onClick={test}
          disabled={busy}
          className="rounded-md bg-primary/20 border border-primary/50 px-3 py-1 text-xs font-mono text-primary hover:bg-primary/30 disabled:opacity-40"
        >
          <Zap size={12} className="inline mr-1" />
          {busy ? "SENDING…" : "TEST"}
        </button>
      </div>
      {Object.keys(params).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(params).map(([name, spec]) => (
            <input
              key={name}
              placeholder={`${name} (${spec.type}${spec.min !== undefined ? ` ${spec.min}-${spec.max}` : ""})`}
              value={values[name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              className="rounded bg-input/60 border border-border px-2 py-1 font-mono text-xs"
            />
          ))}
        </div>
      )}
      {result && (
        <pre
          className={`whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[11px] ${
            result.ok ? "text-primary" : "text-destructive"
          }`}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
