// Native internet access — runs through the NEXUS server, not the local machine.
export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;

export function isWebTool(name: string) {
  return (WEB_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeWebTool(
  name: string,
  args: Record<string, any>,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const payload =
      name === "web_search"
        ? { action: "search", query: String(args["query"] ?? ""), limit: args["limit"] }
        : { action: "fetch", url: String(args["url"] ?? ""), max_chars: args["max_chars"] };

    const r = await fetch("/api/websearch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) return `ERROR (${r.status}): ${text.slice(0, 800)}`;
    return text;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError")
      return `ERROR: ${name} timed out after 45s. Try a narrower query or a different URL.`;
    return `ERROR: ${name} failed — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
  }
}
