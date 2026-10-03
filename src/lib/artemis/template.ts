// Portions ported from Google Artemis (https://github.com/google/artemis)
// Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0.
// Modified for NEXUS: Python (Jinja2 + prompt_assembly.py) -> TypeScript.
//
// A deliberately small Jinja subset: exactly the constructs the upstream
// prompt assets use. `{{ var }}`, `{% if <expr> %}…{% else %}…{% endif %}`
// (nesting allowed) where <expr> is `"tool" in available_tools` or a bare
// variable name. The Operator's contract phase uses the alternate delimiters
// `[% … %]` / `[[ tool_enum(list, "or") ]]` exactly as apply_operator_prompt_contract.

export type TemplateContext = Record<string, unknown> & { available_tools?: Set<string> };

/** Port of prompt_assembly.render_tool_enum (byte-identical wording). */
export function renderToolEnum(
  tools: readonly string[],
  available: Set<string>,
  finalSep?: "or" | "and",
): string {
  const ticked = tools.filter((n) => available.has(n)).map((n) => `\`${n}\``);
  if (!ticked.length) return "";
  if (ticked.length === 1) return ticked[0]!;
  if (!finalSep) return ticked.join(", ");
  if (ticked.length === 2) return `${ticked[0]} ${finalSep} ${ticked[1]}`;
  return `${ticked.slice(0, -1).join(", ")}, ${finalSep} ${ticked[ticked.length - 1]}`;
}

function evalCondition(expr: string, ctx: TemplateContext): boolean {
  const e = expr.trim();
  const inTools = /^["']([^"']+)["']\s+in\s+available_tools$/.exec(e);
  if (inTools) return !!ctx.available_tools?.has(inTools[1]!);
  const neg = /^not\s+(\w+)$/.exec(e);
  if (neg) return !ctx[neg[1]!];
  return !!ctx[e];
}

function renderBlocks(src: string, ctx: TemplateContext, open: string, close: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagRe = new RegExp(`${esc(open)}\\s*(if\\s+[^%]+?|else|endif)\\s*${esc(close)}`, "g");
  type Frame = { active: boolean; parentActive: boolean; taken: boolean };
  const stack: Frame[] = [];
  let out = "";
  let last = 0;
  const isActive = () => (stack.length ? stack[stack.length - 1]!.active : true);
  for (let m = tagRe.exec(src); m; m = tagRe.exec(src)) {
    if (isActive()) out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const tag = m[1]!.trim();
    if (tag.startsWith("if")) {
      const parentActive = isActive();
      const cond = parentActive && evalCondition(tag.slice(2), ctx);
      stack.push({ active: cond, parentActive, taken: cond });
    } else if (tag === "else") {
      const f = stack[stack.length - 1];
      if (!f) throw new Error("template: else without if");
      f.active = f.parentActive && !f.taken;
      f.taken = true;
    } else {
      if (!stack.pop()) throw new Error("template: endif without if");
    }
  }
  if (stack.length) throw new Error("template: unclosed if");
  if (isActive()) out += src.slice(last);
  return out;
}

/** Render `{% %}` blocks and `{{ }}` variables. Unknown variables render empty. */
export function renderTemplate(src: string, ctx: TemplateContext): string {
  const blocks = renderBlocks(src, ctx, "{%", "%}");
  return blocks.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = ctx[name];
    return v == null ? "" : String(v);
  });
}

/**
 * Port of operator/prompts.apply_operator_prompt_contract: renders `[% if %]`
 * gates and `[[ tool_enum(<list>, "or") ]]` slots, leaving `{{ }}` untouched.
 */
export function applyContract(
  src: string,
  available: Set<string>,
  lists: Record<string, readonly string[]>,
): string {
  const gated = renderBlocks(src, { available_tools: available }, "[%", "%]");
  return gated.replace(
    /\[\[\s*tool_enum\(\s*(\w+)\s*(?:,\s*"(or|and)"\s*)?\)\s*\]\]/g,
    (_, list: string, sep?: string) => {
      const names = lists[list];
      if (!names) throw new Error(`template: unknown tool list ${list}`);
      return renderToolEnum(names, available, sep as "or" | "and" | undefined);
    },
  );
}
