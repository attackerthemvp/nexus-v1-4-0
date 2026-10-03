// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/agents/validator/precondition_xml.py, precondition_pixel.py, pixel_safety_net.md
// Copyright 2026 Google LLC. Apache License, Version 2.0.
// Modified for NEXUS: Python -> TypeScript. XML-first precondition with pixel
// fallback; Python imaging replaced by an optional browser canvas marker.

import pixelSafetyNet from "./assets/pixel_safety_net.md?raw";
import { elementAt, indexElements, parseHierarchy, sameIdentity, type IndexedElement } from "./hierarchy";
import { extractJson, imagePart } from "./llm";
import type { ArtemisContext } from "./session";

export type Precondition = {
  method: "xml" | "pixel" | "skipped";
  verdict: "pass" | "healed" | "blocked";
  detail: string;
  coords?: [number, number];
};

const PIXEL_CONFIDENCE_FLOOR = 0.5;

export async function validatePrecondition(
  ctx: ArtemisContext,
  action: string,
  target: [number, number],
  ref: IndexedElement | null,
  thought: string,
  args: Record<string, unknown>,
): Promise<Precondition> {
  const refObs = ctx.obs;
  const reference = ref ?? (refObs ? elementAt(ctx.elements, target, refObs.width, refObs.height) : null);

  // 1) XML-first.
  const fresh = await ctx.actuator.hierarchy().catch(() => null);
  if (fresh?.xml && reference) {
    const els = indexElements(parseHierarchy(fresh.xml), fresh.width || refObs?.width || 0, fresh.height || refObs?.height || 0);
    const w = fresh.width || refObs?.width || 1;
    const h = fresh.height || refObs?.height || 1;
    const atPoint = elementAt(els, target, w, h);
    if (atPoint && sameIdentity(atPoint, reference)) return { method: "xml", verdict: "pass", detail: `"${label(reference)}" is still at the target.` };
    const moved = els.find((e) => sameIdentity(e, reference));
    if (moved) return { method: "xml", verdict: "healed", detail: `"${label(reference)}" moved; coordinates self-healed.`, coords: moved.center };
    return { method: "xml", verdict: "blocked", detail: `"${label(reference)}" is no longer on screen (target_missing).` };
  }

  // 2) Pixel fallback: no usable XML, or a described coordinate target.
  if (!refObs?.screenshotB64) return { method: "skipped", verdict: "pass", detail: "No XML match and no screenshot available; executed without precondition." };
  let current;
  try {
    current = await ctx.actuator.observe();
  } catch {
    return { method: "skipped", verdict: "pass", detail: "Could not capture a current frame for the pixel safety net." };
  }
  if (!current.screenshotB64) return { method: "skipped", verdict: "pass", detail: "Current frame has no screenshot." };
  const mime = refObs.screenshotMime ?? "image/jpeg";
  const img1 = (await ctx.markTarget?.(refObs.screenshotB64, mime, target)) ?? refObs.screenshotB64;
  const img2 = (await ctx.markTarget?.(current.screenshotB64, current.screenshotMime ?? mime, target)) ?? current.screenshotB64;
  const desc = typeof args["target_description"] === "string" ? args["target_description"] : "";
  const targetBlock = reference
    ? `[Target]\nKind: specific UI control\nLabel: ${label(reference)}\nResource id: ${reference.resourceId || "-"}\nClass: ${reference.className}\nBounds: ${reference.bounds.join(",")}`
    : desc
      ? `[Target]\nKind: described target\nOperator's description: ${desc}`
      : "[Target]\nKind: coordinates only";
  const reply = await ctx.llm.call(
    "validator",
    [
      { role: "system", content: pixelSafetyNet },
      {
        role: "user",
        content: [
          { type: "text", text: `${targetBlock}\nRed dot (normalized 0-1000): [${target.join(", ")}]${ctx.markTarget ? "" : " (the dot could not be drawn; use these coordinates)"}\n\n[Planned Action & Original Thinking]\n${action} ${JSON.stringify(args)}\n${thought.slice(0, 800)}\n\nImage 1 (Reference):` },
          imagePart(img1, "image/png"),
          { type: "text", text: "Image 2 (Current State):" },
          imagePart(img2, "image/png"),
        ],
      },
    ],
    [],
  );
  const j = extractJson<{ reasoning?: string; is_present?: boolean; confidence?: number }>(reply.text);
  if (!j || typeof j.is_present !== "boolean") return { method: "pixel", verdict: "pass", detail: "Safety net returned no verdict; fail-open." };
  if (j.is_present && (j.confidence ?? 1) >= PIXEL_CONFIDENCE_FLOOR) return { method: "pixel", verdict: "pass", detail: j.reasoning ?? "Target present." };
  return { method: "pixel", verdict: "blocked", detail: j.reasoning ?? "Target no longer present." };
}

function label(e: IndexedElement) {
  return (e.text || e.contentDesc || e.resourceId || e.className).slice(0, 60);
}
