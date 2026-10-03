// NEXUS addition (not part of upstream Artemis): human confirmation gate for
// risky steps (send, pay, delete, call). Applies even when the user's original
// request named the action.

const RISKY = /\b(send|sent|submit|post|publish|pay|payment|purchase|buy|checkout|order now|place order|transfer|delete|remove|erase|uninstall|clear data|reset|call|dial|share|confirm)\b/i;

export type RiskContext = { targetLabel?: string; args: Record<string, unknown> };

/** Returns a reason when the action needs confirmation, else null. */
export function riskReason(action: string, ctx: RiskContext): string | null {
  const desc = [
    ctx.targetLabel,
    typeof ctx.args["target_description"] === "string" ? ctx.args["target_description"] : "",
    Array.isArray(ctx.args["target_descriptions"]) ? (ctx.args["target_descriptions"] as unknown[]).join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (["click", "long_press", "click_sequence"].includes(action) && RISKY.test(desc))
    return `This tap targets "${desc.trim()}", which can send, pay, delete or call.`;
  if (action === "press_key" && String(ctx.args["key"]).toUpperCase() === "ENTER")
    return "Pressing ENTER may send or submit what was typed.";
  if (action === "manage_app" && ctx.args["action"] === "stop") return "Stopping an app can lose unsaved work.";
  return null;
}
