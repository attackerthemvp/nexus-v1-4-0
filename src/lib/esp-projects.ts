// Generic ESP / IoT project registry.
// The local NEXUS agent is the single source of truth: it stores the project
// definitions on disk (esp_projects.json) and performs every LAN HTTP request.
// The browser never talks to an ESP directly.
import { fetchAgent } from "@/lib/jarvis-agent";

export type EspParamSpec = {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  required?: boolean;
  min?: number;
  max?: number;
  enum?: (string | number)[];
  default?: unknown;
};

export type EspAction = {
  id: string;
  name: string;
  description?: string;
  method: string;
  endpoint: string;
  parameters?: Record<string, EspParamSpec>;
  body?: unknown;
  headers?: Record<string, string>;
  expects?: string;
  confirm?: boolean;
  timeout?: number;
  retries?: number;
  unit?: string;
};

export type EspDevice = {
  id: string;
  name: string;
  description?: string;
  commands: EspAction[];
  sensors: EspAction[];
};

export type EspProject = {
  id: string;
  name: string;
  description?: string;
  host: string;
  protocol: "http" | "https";
  port?: number;
  transport?: string;
  timeout?: number;
  retries?: number;
  auth?: {
    type: "none" | "basic" | "bearer" | "header";
    username?: string;
    password?: string;
    token?: string;
    header_name?: string;
    header_value?: string;
  };
  devices: EspDevice[];
  created_at?: number;
  updated_at?: number;
};

export type EspExecResult = {
  ok: boolean;
  project?: string;
  device?: string;
  command?: string;
  request?: { method: string; url: string; body?: unknown };
  status?: number;
  duration_ms?: number;
  response?: unknown;
  error?: string;
  attempts?: number;
};

async function agentJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetchAgent(path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!r.ok) throw new Error(parsed?.detail || parsed?.error || text || `HTTP ${r.status}`);
  return parsed as T;
}

export async function listEspProjects(): Promise<EspProject[]> {
  const data = await agentJson<{ projects: EspProject[] }>("/esp/projects");
  return data.projects ?? [];
}

export async function saveEspProject(project: Partial<EspProject>): Promise<EspProject> {
  const data = await agentJson<{ project: EspProject }>("/esp/projects", {
    method: "POST",
    body: JSON.stringify(project),
  });
  return data.project;
}

export async function deleteEspProject(id: string): Promise<void> {
  await agentJson(`/esp/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function espProjectStatus(id: string) {
  return agentJson<{ online: boolean; latency_ms?: number; error?: string }>(
    `/esp/projects/${encodeURIComponent(id)}/status`,
  );
}

export async function runEspCommand(
  project_id: string,
  device_id: string,
  command_id: string,
  parameters: Record<string, unknown> = {},
): Promise<EspExecResult> {
  return agentJson<EspExecResult>("/esp/execute", {
    method: "POST",
    body: JSON.stringify({ project_id, device_id, command_id, parameters }),
  });
}
