// Calls the local helper agent running on the user's machine.
import { getSettings } from "@/lib/settings-store";

export const AGENT_URLS = ["http://127.0.0.1:7337", "http://localhost:7337"];

/** Adds the shared-secret header when the user configured one. */
function withAgentAuth(init: RequestInit): RequestInit {
  const token = getSettings().computer.agentToken.trim();
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set("X-Nexus-Token", token);
  return { ...init, headers };
}

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export async function checkAgentStatus(): Promise<boolean> {
  for (const agentUrl of AGENT_URLS) {
    try {
      const r = await fetch(`${agentUrl}/health`, { method: "GET", cache: "no-store" });
      if (r.ok) return true;
    } catch {
      // Try the next localhost variant before declaring the agent offline.
    }
  }

  return false;
}

export async function fetchAgent(path: string, init: RequestInit = {}) {
  let lastError: unknown;
  const authed = withAgentAuth(init);

  for (const agentUrl of AGENT_URLS) {
    try {
      return await fetch(`${agentUrl}${path}`, authed);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError;
}

/** Reads /health, which reports the agent version and every registered tool. */
export async function fetchAgentInfo(): Promise<{
  agent_version?: string;
  tools?: string[];
  android?: string[];
} | null> {
  try {
    const r = await fetchAgent("/health", { method: "GET", cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as { agent_version?: string; tools?: string[]; android?: string[] };
  } catch {
    return null;
  }
}

/**
 * A 404 from the agent almost always means the *running* process is an older
 * build than the checkout on disk, so tell the user to restart it instead of
 * surfacing a bare status code.
 */
async function staleAgentMessage(name: string): Promise<string> {
  const info = await fetchAgentInfo();
  const version = info?.agent_version ?? "unknown (pre-versioning build)";
  const known = info?.tools?.includes(name);
  const base = `ERROR: The local NEXUS agent has no /tool/${name} route. Running agent version: ${version}.`;
  if (known) {
    return `${base} The route exists but rejected this path — check the tool name spelling.`;
  }
  return `${base} This is a stale local agent: the tool exists in local-agent/nexus_agent.py on disk but not in the process that is running. Stop the agent (Ctrl+C in its terminal), pull the latest project files (nexus_agent.py, android_manager.py AND esp_manager.py must sit in the same folder), then run "python nexus_agent.py" again. Verify with phone_agent_status (NEXUS Android Agent).`;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<string> {
  // A hung local command must surface as an error, never as an infinite wait.
  const budget =
    timeoutMs ??
    (typeof args["timeout_sec"] === "number"
      ? (args["timeout_sec"] as number) * 1000 + 30_000
      : 300_000);
  // launch_app: pass the user's extra shortcut folders from Settings → Computer.
  if (name === "launch_app" && !Array.isArray(args["search_dirs"])) {
    const dirs = getSettings().computer.appSearchDirs.filter((d) => d.trim());
    if (dirs.length) args = { ...args, search_dirs: dirs };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const r = await fetchAgent(`/tool/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (r.status === 404) return await staleAgentMessage(name);
    if (!r.ok) return `ERROR (${r.status}): ${text}`;
    return text;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return `ERROR: ${name} exceeded ${Math.round(budget / 1000)}s and was cancelled. Run it in the background with run_command_bg, or narrow the work.`;
    }
    return `ERROR: Local NEXUS agent unreachable at ${AGENT_URLS.join(" or ")}. Make sure it's running. (${
      e instanceof Error ? e.message : String(e)
    })`;
  } finally {
    clearTimeout(timer);
  }
}


