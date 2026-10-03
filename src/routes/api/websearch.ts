// Native web access for NEXUS — no local browser required.
// Search uses DuckDuckGo's lite endpoint; fetch returns readable page text.
import { createFileRoute } from "@tanstack/react-router";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function cleanDuckUrl(href: string) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return href;
  }
}

type SearchHit = { title: string; url: string; snippet: string };

async function ddgSearch(query: string, limit: number): Promise<SearchHit[]> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": UA, Accept: "text/html" } },
  );
  if (!res.ok) throw new Error(`search provider returned ${res.status}`);
  const html = await res.text();

  const hits: SearchHit[] = [];
  const blockRx =
    /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRx.exec(html)) && hits.length < limit) {
    const snippet =
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(m[3] ?? "")?.[1] ??
      /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(m[3] ?? "")?.[1] ??
      "";
    hits.push({
      title: htmlToText(m[2] ?? ""),
      url: cleanDuckUrl(m[1] ?? ""),
      snippet: htmlToText(snippet),
    });
  }
  return hits;
}

/** Fallback so a single blocked provider never kills internet access. */
async function bingSearch(query: string, limit: number): Promise<SearchHit[]> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${limit}`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`fallback search returned ${res.status}`);
  const xml = await res.text();
  const hits: SearchHit[] = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  const pick = (block: string, tag: string) =>
    htmlToText(
      new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i").exec(block)?.[1] ??
        "",
    );
  while ((m = itemRx.exec(xml)) && hits.length < limit) {
    const block = m[1] ?? "";
    hits.push({
      title: pick(block, "title"),
      url: pick(block, "link"),
      snippet: pick(block, "description"),
    });
  }
  return hits;
}


export const Route = createFileRoute("/api/websearch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            action?: "search" | "fetch";
            query?: string;
            url?: string;
            limit?: number;
            max_chars?: number;
          };

          if (body.action === "fetch") {
            const url = String(body.url ?? "").trim();
            if (!/^https?:\/\//i.test(url))
              return Response.json({ error: "url must start with http(s)://" }, { status: 400 });
            const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
            const raw = await res.text();
            const isHtml = (res.headers.get("content-type") ?? "").includes("html");
            const text = isHtml ? htmlToText(raw) : raw;
            const max = Math.min(Math.max(body.max_chars ?? 12000, 500), 40000);
            const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1];
            return Response.json({
              url,
              status: res.status,
              title: title ? htmlToText(title) : undefined,
              truncated: text.length > max,
              text: text.slice(0, max),
            });
          }

          const query = String(body.query ?? "").trim();
          if (!query) return Response.json({ error: "query is required" }, { status: 400 });
          const limit = Math.min(Math.max(body.limit ?? 6, 1), 15);
          let results: SearchHit[] = [];
          let source = "duckduckgo";
          try {
            results = await ddgSearch(query, limit);
          } catch {
            results = [];
          }
          if (!results.length) {
            source = "bing";
            results = await bingSearch(query, limit);
          }
          return Response.json({ query, source, count: results.length, results });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
