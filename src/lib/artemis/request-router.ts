// NEXUS addition: Android request router. Decides ONLY whether a request needs
// Android control. It never acts on the phone and never makes Artemis decisions.
// Deterministic obvious-case detection first; a small-model contextual pass is
// used only when the deterministic pass is unsure.

export type RouteDecision = "NORMAL" | "ANDROID" | "AMBIGUOUS";

const PHONE_WORDS = /\b(phone|android|my mobile|on mobile|handy|smartphone)\b/i;
const APP_WORDS = /\b(whatsapp|instagram|telegram|youtube|spotify|tiktok|snapchat|messenger|gmail|chrome|maps|settings app|play store|camera|gallery|contacts|dialer)\b/i;
const ACT_WORDS = /\b(open|launch|start|tap|click|swipe|scroll|type|message|text|send|call|dial|play|turn on|turn off|enable|disable|post|reply|search (?:in|on)|go to)\b/i;
const PC_WORDS = /\b(pc|computer|laptop|desktop|windows|terminal|powershell|vs ?code|esp32|esp|arduino|browser on my pc)\b/i;
const QUESTION = /^(what|why|how|who|when|where|explain|tell me about|is|are|can you explain)\b/i;

export function routeDeterministic(text: string): RouteDecision | null {
  const t = text.trim();
  if (!t) return "NORMAL";
  const phone = PHONE_WORDS.test(t);
  const app = APP_WORDS.test(t);
  const act = ACT_WORDS.test(t);
  const pc = PC_WORDS.test(t);
  if (pc && !phone) return "NORMAL";
  if (QUESTION.test(t) && !/\b(on|in) my phone\b/i.test(t)) return "NORMAL";
  if (act && (phone || app)) return "ANDROID";
  if (!act && !phone && !app) return "NORMAL";
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
): Promise<{ decision: RouteDecision; via: "deterministic" | "model" }> {
  const d = routeDeterministic(text);
  if (d) return { decision: d, via: "deterministic" };
  try {
    const reply = await classify(ROUTER_SYSTEM, `Recent conversation:\n${context.slice(-2000)}\n\nLatest request: ${text}`);
    return { decision: parseRouterReply(reply), via: "model" };
  } catch {
    return { decision: "AMBIGUOUS", via: "model" };
  }
}
