// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/agents/explorer/screen_index.py, geometry.py, graph/perception.py
// Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python -> TypeScript; dependency-free XML parsing so it
// runs in the browser and in tests. Parses the HierarchyDumper-compatible XML
// the NEXUS Android Agent app emits (uiautomator field names/meaning).

export type Bounds = [number, number, number, number]; // l, t, r, b in device pixels
export type UiNode = {
  index: number;
  text: string;
  resourceId: string;
  className: string;
  packageName: string;
  contentDesc: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  checked: boolean;
  selected: boolean;
  editable: boolean;
  bounds: Bounds;
};
export type IndexedElement = UiNode & { id: number; center: [number, number] /* 0-1000 */ };

const ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const NODE_RE = /<node\b([^>]*?)\/?>/g;

function decode(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

export function parseBounds(v: string): Bounds | null {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

export function parseHierarchy(xml: string): UiNode[] {
  const out: UiNode[] = [];
  for (let m = NODE_RE.exec(xml); m; m = NODE_RE.exec(xml)) {
    const a: Record<string, string> = {};
    for (let am = ATTR_RE.exec(m[1]!); am; am = ATTR_RE.exec(m[1]!)) a[am[1]!] = decode(am[2]!);
    ATTR_RE.lastIndex = 0;
    const bounds = parseBounds(a["bounds"] ?? "");
    if (!bounds) continue;
    const cls = a["class"] ?? "";
    out.push({
      index: out.length,
      text: a["text"] ?? "",
      resourceId: a["resource-id"] ?? "",
      className: cls,
      packageName: a["package"] ?? "",
      contentDesc: a["content-desc"] ?? "",
      clickable: a["clickable"] === "true",
      longClickable: a["long-clickable"] === "true",
      scrollable: a["scrollable"] === "true",
      focusable: a["focusable"] === "true",
      focused: a["focused"] === "true",
      enabled: a["enabled"] !== "false",
      checked: a["checked"] === "true",
      selected: a["selected"] === "true",
      editable: a["editable"] === "true" || /EditText/.test(cls),
      bounds,
    });
  }
  NODE_RE.lastIndex = 0;
  return out;
}

export function area(b: Bounds) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

export function iou(a: Bounds, b: Bounds) {
  const inter: Bounds = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const i = area(inter);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

export function toNormalized(px: [number, number], width: number, height: number): [number, number] {
  return [Math.round((px[0] / Math.max(1, width)) * 1000), Math.round((px[1] / Math.max(1, height)) * 1000)];
}
export function toPixels(norm: [number, number], width: number, height: number): [number, number] {
  return [Math.round((norm[0] / 1000) * width), Math.round((norm[1] / 1000) * height)];
}

function isMeaningful(n: UiNode) {
  return n.clickable || n.longClickable || n.scrollable || n.editable || n.focusable || !!n.text.trim() || !!n.contentDesc.trim();
}

/** Visible, meaningful, de-duplicated, indexed element list (perception contract). */
export function indexElements(nodes: UiNode[], width: number, height: number): IndexedElement[] {
  const w = width || Math.max(1, ...nodes.map((n) => n.bounds[2]));
  const h = height || Math.max(1, ...nodes.map((n) => n.bounds[3]));
  const out: IndexedElement[] = [];
  for (const n of nodes) {
    const [l, t, r, b] = n.bounds;
    const clipped: Bounds = [Math.max(0, l), Math.max(0, t), Math.min(w, r), Math.min(h, b)];
    if (area(clipped) < 16 || !isMeaningful(n)) continue;
    // Drop near-duplicate wrappers (same box, no extra label).
    if (out.some((o) => iou(o.bounds, clipped) > 0.95 && (o.text || o.contentDesc) === (n.text || n.contentDesc))) continue;
    const cx = (clipped[0] + clipped[2]) / 2;
    const cy = (clipped[1] + clipped[3]) / 2;
    out.push({ ...n, bounds: clipped, id: out.length, center: toNormalized([cx, cy], w, h) });
  }
  return out;
}

export function describeElement(e: IndexedElement): string {
  const label = (e.text || e.contentDesc).replace(/\s+/g, " ").slice(0, 80);
  const cls = e.className.split(".").pop() ?? "";
  const flags = [e.clickable && "clickable", e.editable && "editable", e.scrollable && "scrollable", e.checked && "checked", e.selected && "selected", !e.enabled && "disabled"].filter(Boolean).join(",");
  const rid = e.resourceId ? ` id=${e.resourceId.split("/").pop()}` : "";
  return `[${e.id}] ${cls}${label ? ` "${label}"` : ""}${rid}${flags ? ` (${flags})` : ""} center=[${e.center[0]}, ${e.center[1]}]`;
}

export function renderElementList(els: IndexedElement[], max = 120): string {
  if (!els.length) return "(no UI elements reported)";
  return els.slice(0, max).map(describeElement).join("\n");
}

/** Deepest meaningful element containing a normalized point. */
export function elementAt(els: IndexedElement[], norm: [number, number], width: number, height: number): IndexedElement | null {
  const [x, y] = toPixels(norm, width, height);
  const hits = els.filter((e) => x >= e.bounds[0] && x <= e.bounds[2] && y >= e.bounds[1] && y <= e.bounds[3]);
  hits.sort((a, b) => area(a.bounds) - area(b.bounds));
  return hits[0] ?? null;
}

/** Identity used by the XML precondition: stable fields, not position. */
export function sameIdentity(a: UiNode, b: UiNode): boolean {
  if (a.resourceId && b.resourceId && a.resourceId !== b.resourceId) return false;
  const la = (a.text || a.contentDesc).trim();
  const lb = (b.text || b.contentDesc).trim();
  if (la || lb) return la === lb && a.className === b.className;
  return a.className === b.className && !!a.resourceId && a.resourceId === b.resourceId;
}
