// Portions ported from Google Artemis (https://github.com/google/artemis)
// artemis/mcp/action_session.py, action_executor.py, actuators/base.py
// Copyright 2026 Google LLC. Apache License, Version 2.0.
// Modified for NEXUS: the ADB actuator is REPLACED by a zero-ADB Android Agent
// actuator: NEXUS -> PC local agent -> tailnet -> NEXUS Android Agent app.
// Aliases are normalized only here, at the transport boundary.

import { resolveAndroidApp, looksLikePackage } from "@/lib/android-apps";
import type { ActionResult, Observation } from "./types";

/** Sends one capability to the phone; returns the raw local-agent response text. */
export type PhoneTransport = (command: string, args: Record<string, unknown>, timeoutSec?: number) => Promise<string>;

export const RESULT_CODES = ["OK", "INVALID_ARGS", "TARGET_NOT_FOUND", "DEVICE_ERROR", "PACKAGE_NOT_FOUND", "TIMEOUT", "UNSUPPORTED"] as const;

/** Artemis action → phone capability names accepted (first match wins). */
const ALIASES: Record<string, string[]> = {
  observe_screen: ["snapshot", "observe_screen"],
  take_screenshot: ["take_screenshot", "screenshot"],
  get_ui_hierarchy: ["get_ui_hierarchy", "dump_ui"],
  click: ["click", "tap"],
  click_sequence: ["click_sequence"],
  long_press: ["long_press"],
  swipe: ["swipe"],
  input_text: ["input_text"],
  focus_and_clear_text: ["focus_and_clear_text"],
  erase_one_char: ["erase_one_char"],
  press_key: ["press_key"],
  open_link: ["open_link"],
  wait_for_text: ["wait_for_text"],
};

export type Parity = "full" | "degraded" | "local";

export type CapabilityMap = {
  /** Artemis-facing action names the phone can serve. */
  actions: Set<string>;
  parity: Record<string, Parity>;
  /** The raw capability names the phone advertised. */
  advertised: Set<string>;
};

export function negotiateCapabilities(advertised: Iterable<string>): CapabilityMap {
  const adv = new Set(advertised);
  const actions = new Set<string>();
  const parity: Record<string, Parity> = {};
  for (const [action, names] of Object.entries(ALIASES)) {
    if (names.some((n) => adv.has(n))) {
      actions.add(action);
      parity[action] = "full";
    }
  }
  // press_key: the phone's global actions are an acceptable degraded binding.
  if (!actions.has("press_key") && (adv.has("home") || adv.has("back"))) {
    actions.add("press_key");
    parity["press_key"] = "degraded";
  }
  // manage_app: launch via launch intent; true force-stop is impossible without
  // system rights, so "stop" is always degraded (Home/Recents dismissal).
  if (adv.has("manage_app") || adv.has("open_app")) {
    actions.add("manage_app");
    parity["manage_app"] = "degraded";
  }
  // wait_for_delay needs no device: NEXUS waits locally.
  actions.add("wait_for_delay");
  parity["wait_for_delay"] = "local";
  return { actions, parity, advertised: adv };
}

function pick(cap: CapabilityMap, action: string): string | null {
  return (ALIASES[action] ?? []).find((n) => cap.advertised.has(n)) ?? null;
}

/** Normalize any phone/local-agent response into the Artemis result envelope. */
export function normalizeResult(raw: string): ActionResult {
  const text = raw.trim();
  if (text.startsWith("ERROR")) {
    const code = /\(504\)|timed? ?out|did not answer/i.test(text)
      ? "TIMEOUT"
      : /unsupported|UNKNOWN_CAPABILITY|\(400\)/i.test(text)
        ? "UNSUPPORTED"
        : "DEVICE_ERROR";
    return { ok: false, code, message: text.slice(0, 500) };
  }
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: true, code: "OK", message: text.slice(0, 500) };
  }
  const inner = v && typeof v === "object" && v.result && typeof v.result === "object" ? v.result : v;
  const ok = inner?.ok !== false && v?.ok !== false;
  const code = typeof inner?.code === "string" ? inner.code : ok ? "OK" : "DEVICE_ERROR";
  const message = typeof inner?.message === "string" ? inner.message : typeof inner?.error === "string" ? inner.error : ok ? "ok" : "failed";
  return { ok: ok && code === "OK", code, message, data: inner };
}

export class AndroidAgentActuator {
  constructor(
    private transport: PhoneTransport,
    public caps: CapabilityMap,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async send(command: string, args: Record<string, unknown>, timeoutSec = 30): Promise<ActionResult> {
    return normalizeResult(await this.transport(command, args, timeoutSec));
  }

  async observe(): Promise<Observation> {
    const snap = pick(this.caps, "observe_screen");
    if (snap) {
      const r = await this.send(snap, {}, 45);
      if (!r.ok) throw new Error(`observe_screen failed: ${r.code} ${r.message}`);
      return toObservation(r.data);
    }
    const shotCmd = pick(this.caps, "take_screenshot");
    const xmlCmd = pick(this.caps, "get_ui_hierarchy");
    const t0 = Date.now();
    const [shot, xml] = await Promise.all([
      shotCmd ? this.send(shotCmd, {}, 45) : Promise.resolve(null),
      xmlCmd ? this.send(xmlCmd, {}, 45) : Promise.resolve(null),
    ]);
    if (!shot?.ok && !xml?.ok) throw new Error(`observation unavailable: ${shot?.message ?? xml?.message ?? "no capability"}`);
    const o = toObservation({ ...((shot?.ok && (shot.data as object)) || {}), ...((xml?.ok && (xml.data as object)) || {}) });
    o.skewMs = Date.now() - t0;
    return o;
  }

  async hierarchy(): Promise<Observation | null> {
    const cmd = pick(this.caps, "get_ui_hierarchy");
    if (!cmd) return null;
    const r = await this.send(cmd, {}, 30);
    return r.ok ? toObservation(r.data) : null;
  }

  /** Execute one Artemis action on the wire dialect (normalized 0-1000 coordinates). */
  async execute(action: string, args: Record<string, unknown>): Promise<ActionResult> {
    if (!this.caps.actions.has(action))
      return { ok: false, code: "UNSUPPORTED", message: `The phone does not support '${action}'.` };
    switch (action) {
      case "wait_for_delay": {
        const ms = Math.max(0, Math.min(120_000, Number(args["time_in_ms"] ?? 1000)));
        await this.sleep(ms);
        return { ok: true, code: "OK", message: `Waited ${ms} ms.` };
      }
      case "press_key": {
        const key = String(args["key"] ?? "").toUpperCase();
        if (this.caps.parity["press_key"] === "full") return this.send(pick(this.caps, "press_key")!, { key: key.toLowerCase() });
        const map: Record<string, string> = { HOME: "home", BACK: "back", APP_SWITCH: "recents" };
        const cmd = map[key];
        if (!cmd || !this.caps.advertised.has(cmd))
          return { ok: false, code: "UNSUPPORTED", message: `press_key ${key} has no Android API equivalent on this phone.` };
        return this.send(cmd, {});
      }
      case "manage_app": {
        const op = String(args["action"] ?? "launch");
        const name = String(args["app_name"] ?? "");
        if (this.caps.advertised.has("manage_app")) return this.send("manage_app", { action: op, app_name: name }, 30);
        if (op === "stop") {
          if (this.caps.advertised.has("close_app")) return this.send("close_app", looksLikePackage(name) ? { package: name } : { app_name: name });
          return { ok: false, code: "UNSUPPORTED", message: "Stopping another app is not possible without system rights (degraded: use HOME)." };
        }
        const pkg = looksLikePackage(name) ? name : resolveAndroidApp(name).resolved ?? resolveAndroidApp(name).candidates[0];
        if (!pkg) return { ok: false, code: "PACKAGE_NOT_FOUND", message: `Unknown app '${name}'.` };
        return this.send("open_app", { package: pkg }, 30);
      }
      case "long_press": {
        const { duration, ...rest } = args;
        return this.send(pick(this.caps, action)!, { ...rest, duration_ms: duration ?? args["duration_ms"] ?? 1000 });
      }
      case "swipe": {
        const { duration, ...rest } = args;
        return this.send(pick(this.caps, action)!, { ...rest, ...(duration != null ? { duration_ms: duration } : {}) });
      }
      default:
        return this.send(pick(this.caps, action)!, args, action === "wait_for_text" ? 60 : 30);
    }
  }
}

function toObservation(d: any): Observation {
  const o: Observation = {
    width: Number(d?.width ?? d?.screen_width ?? 0),
    height: Number(d?.height ?? d?.screen_height ?? 0),
    ts: Number(d?.ts ?? d?.timestamp ?? Date.now()),
  };
  const b64 = d?.screenshot_b64 ?? d?.screenshot ?? d?.image_b64;
  if (typeof b64 === "string" && b64.length > 100) {
    o.screenshotB64 = b64;
    o.screenshotMime = d?.screenshot_mime ?? d?.mime ?? "image/jpeg";
  }
  const xml = d?.xml ?? d?.hierarchy ?? d?.ui_xml;
  if (typeof xml === "string") o.xml = xml;
  const fg = d?.foreground_package ?? d?.package;
  if (typeof fg === "string") o.foregroundPackage = fg;
  if (typeof d?.skew_ms === "number") o.skewMs = d.skew_ms;
  return o;
}
