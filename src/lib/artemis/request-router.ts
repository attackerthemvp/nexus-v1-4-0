// NEXUS addition: Android request router. Decides ONLY whether a request needs
// Android control. It never acts on the phone and never makes Artemis decisions.
// Deterministic obvious-case detection first; a small-model contextual pass is
// used only when the deterministic pass is unsure.

export type RouteDecision = "NORMAL" | "ANDROID" | "AMBIGUOUS";

export type ActiveDevice = "pc" | "android" | null;

const PHONE_WORDS = /\b(phone|android|my mobile|on mobile|handy|smartphone)\b/i;
// Apps that effectively only exist on the phone. Cross-platform apps (chrome,
// spotify, youtube, gmail, maps, telegram…) are deliberately NOT here: an app
// name alone must never imply Android.
const MOBILE_ONLY_APPS = /\b(whatsapp|instagram|tiktok|snapchat|play store|dialer|gallery|contacts|camera app)\b/i;
const ACT_WORDS = /\b(open|launch|start|tap|click|swipe|scroll|type|message|text|send|call|dial|play|turn on|turn off|enable|disable|post|reply|search (?:in|on)|go to|do (?:that|this|it))\b/i;
const PC_WORDS = /\b(pc|computer|laptop|desktop|windows|terminal|powershell|vs ?code|esp32|esp|arduino|browser|chrome tab|tabs?|window|screen|monitor|taskbar|explorer|mouse|keyboard)\b/i;
// Demonstratives that anchor the task to what is in front of the user on the PC.
const PC_DEMONSTRATIVE = /\b(this|that|the|current|same|exact|active|open)\s+(?:exact\s+|current\s+|same\s+)?(?:chrome\s+|browser\s+)?(tab|window)\b|\bon (?:my |the )?screen\b/i;
const EXPLICIT_PHONE = /\b(on|in|with|using|to) (?:my |the )?(phone|android|mobile|smartphone)\b|\bphone\b/i;
const QUESTION = /^(what|why|how|who|when|where|explain|tell me about|is|are|can you explain)\b/i;

export function routeDeterministic(text: string, lastDevice: ActiveDevice = null): RouteDecision | null {
  const t = text.trim();
  if (!t) return "NORMAL";
  const phone = PHONE_WORDS.test(t) || EXPLICIT_PHONE.test(t);
  const act = ACT_WORDS.test(t);
  // 1. Demonstrative PC guard beats any app-name matching.
  if (PC_DEMONSTRATIVE.test(t) && !phone) return "NORMAL";
  if (PC_WORDS.test(t) && !phone) return "NORMAL";
  if (QUESTION.test(t) && !/\b(on|in) my phone\b/i.test(t)) return "NORMAL";
  // 2. Explicit device switch to the phone.
  if (act && phone) return "ANDROID";
  // 3. Conversational continuity: stay on the device we were just using.
  if (lastDevice === "pc") return "NORMAL";
  if (lastDevice === "android" && act) return "ANDROID";
  if (act && MOBILE_ONLY_APPS.test(t)) return "ANDROID";
  if (!act && !phone) return "NORMAL";
  return null; // unsure → contextual model
}

export const ROUTER_SYSTEM = `You are the NEXUS Android request router. Classify ONLY whether the user's latest request requires controlling their Android phone (tapping, opening apps, typing, messaging on the phone).
Answer with exactly one word: NORMAL (no phone control needed — questions, PC tasks, chat), ANDROID (phone control needed), or AMBIGUOUS (could be either and the conversation does not tell).`;

export function parseRouterReply(text: string): RouteDecision {
  const m = /\b(NORMAL|ANDROID|AMBIGUOUS)\b/.exec(text.toUpperCase());
  return (m?.[1] as RouteDecision) ?? "AMBIGUOUS";
}

export async function routeRequest(
  text: string,
  context: string,
  classify: (system: string, user: string) => Promise<string>,
  lastDevice: ActiveDevice = null,
): Promise<{ decision: RouteDecision; via: "deterministic" | "model" }> {
  const d = routeDeterministic(text, lastDevice);
  if (d) return { decision: d, via: "deterministic" };
  try {
    const reply = await classify(ROUTER_SYSTEM, `Last active device: ${lastDevice ?? "none"} (stay on it unless the user explicitly switches).\nRecent conversation:\n${context.slice(-2000)}\n\nLatest request: ${text}`);
    return { decision: parseRouterReply(reply), via: "model" };
  } catch {
    return { decision: "AMBIGUOUS", via: "model" };
  }
}
