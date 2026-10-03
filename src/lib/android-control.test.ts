import { beforeEach, describe, expect, test } from "vitest";
import {
  evaluateAndroidEvidence,
  interpretAndroidIntent,
  parseAndroidStatus,
  validatePhoneCommand,
  type AndroidCapabilitySnapshot,
} from "./android-apps";
import {
  checkAndroidCompletion,
  checkAndroidRetry,
  getAndroidSnapshot,
  noteAndroidDispatch,
  noteAndroidStateCheck,
  recordAndroidStatus,
  resetAndroidSession,
} from "./android-session";

const STATUS = JSON.stringify({
  agents: [
    {
      online: true,
      model: "SM-S911B",
      app_version: "1.4.0",
      capabilities: ["ping", "device_info", "open_app", "home", "back", "recents", "foreground_app", "screen_read", "click_element", "wait_for_app", "list_apps"],
    },
  ],
});

const snap = (): AndroidCapabilitySnapshot => parseAndroidStatus(STATUS);

describe("capability snapshot", () => {
  test("parses the advertised capabilities of the online agent", () => {
    const s = snap();
    expect(s.known).toBe(true);
    expect(s.online).toBe(true);
    expect(s.agentVersion).toBe("1.4.0");
    expect(s.capabilities.has("open_app")).toBe(true);
  });

  test("unparseable status leaves the contract unknown rather than empty-but-authoritative", () => {
    expect(parseAndroidStatus("<html>oops").known).toBe(false);
  });
});

describe("phone command validation", () => {
  test("accepts an advertised capability with the verified schema", () => {
    const v = validatePhoneCommand("open_app", { package: "com.whatsapp" }, snap());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.args).toEqual({ package: "com.whatsapp" });
  });

  test("rejects a capability the phone does not advertise", () => {
    const v = validatePhoneCommand("scroll_until_text_appears", { text: "x" }, snap());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("UNKNOWN_CAPABILITY");
  });

  test("normalizes the known legacy package_name key only", () => {
    const ok = validatePhoneCommand("open_app", { package_name: "com.whatsapp" }, snap());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.args).toEqual({ package: "com.whatsapp" });

    const bad = validatePhoneCommand("open_app", { pkg_id: "com.whatsapp" }, snap());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("INVALID_ARGUMENTS");
  });

  test("rejects an invented argument on a verified schema", () => {
    const v = validatePhoneCommand("home", { screen: 2 }, snap());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("INVALID_ARGUMENTS");
  });

  test("resolves a spoken app name but never guesses an unknown one", () => {
    const yt = validatePhoneCommand("open_app", { package: "YT" }, snap());
    expect(yt.ok).toBe(true);
    if (yt.ok) expect(yt.args["package"]).toBe("com.google.android.youtube");

    const unknown = validatePhoneCommand("open_app", { package: "zzz mystery app" }, snap());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("UNRESOLVED_APP");
  });

  test("leaves unverified capability arguments untouched", () => {
    const v = validatePhoneCommand("click_element", { text: "Phone" }, snap());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.args).toEqual({ text: "Phone" });
  });

  test("does not reject capabilities before a status snapshot exists", () => {
    expect(validatePhoneCommand("recents", {}).ok).toBe(true);
  });
});

describe("intent semantics", () => {
  test("open / launch means open_app", () => {
    for (const t of ["open WhatsApp", "launch WhatsApp", "start whatsapp"]) {
      const i = interpretAndroidIntent(t);
      expect(i.action).toBe("open_app");
      expect(i.package).toBe("com.whatsapp");
    }
  });

  test("home and back", () => {
    expect(interpretAndroidIntent("go home").action).toBe("home");
    expect(interpretAndroidIntent("go to the home screen").action).toBe("home");
    expect(interpretAndroidIntent("go back").action).toBe("back");
  });

  test("close / exit / leave means backgrounding, not termination", () => {
    for (const t of ["close WhatsApp", "exit whatsapp", "leave WhatsApp"]) {
      const i = interpretAndroidIntent(t);
      expect(i.action).toBe("home");
      expect(i.reporting).toMatch(/foreground/i);
      expect(i.reporting).toMatch(/never/i);
    }
  });

  test("explicit termination is a separate intent gated on a real capability", () => {
    const i = interpretAndroidIntent("force stop WhatsApp");
    expect(i.action).toBe("terminate");
    expect(validatePhoneCommand("close_app", { package: "com.whatsapp" }, snap()).ok).toBe(false);
  });

  test("recents and task switching are not launching", () => {
    expect(interpretAndroidIntent("show recent apps").action).toBe("recents");
    const s = interpretAndroidIntent("switch to the Phone app that's already in the background");
    expect(s.action).toBe("switch_task");
    expect(s.reporting).toMatch(/switched/i);
  });
});

describe("verification evidence", () => {
  test("dispatch success alone is not a verified UI state", () => {
    expect(evaluateAndroidEvidence("com.whatsapp", {}, true).state).toBe("inconclusive");
  });

  test("foreground agreement verifies", () => {
    expect(
      evaluateAndroidEvidence("com.whatsapp", { foregroundPackage: "com.whatsapp" }, true).state,
    ).toBe("verified");
  });

  test("null foreground_app is inconclusive, never failure", () => {
    const v = evaluateAndroidEvidence("com.whatsapp", { foregroundPackage: null }, true);
    expect(v.state).toBe("inconclusive");
    expect(v.detail).toMatch(/do NOT repeat/i);
  });

  test("screen evidence can carry a null foreground_app", () => {
    expect(
      evaluateAndroidEvidence(
        "com.whatsapp",
        { foregroundPackage: "", screenText: "package=com.whatsapp chats" },
        true,
      ).state,
    ).toBe("verified");
  });

  test("conflicting evidence is reported, not declared successful", () => {
    expect(
      evaluateAndroidEvidence(
        "com.sec.android.app.camera",
        { foregroundPackage: "com.android.chrome" },
        true,
      ).state,
    ).toBe("conflict");
  });

  test("a failed dispatch is a failure", () => {
    expect(evaluateAndroidEvidence("com.whatsapp", {}, false).state).toBe("failed");
  });
});

describe("bounded, state-aware retries", () => {
  beforeEach(() => resetAndroidSession());

  test("a failed action cannot be blindly repeated", () => {
    const args = { package: "com.whatsapp" };
    expect(checkAndroidRetry("open_app", args, false).allow).toBe(true);
    noteAndroidDispatch("open_app", args, false, "504 phone did not answer", false);
    const blocked = checkAndroidRetry("open_app", args, false);
    expect(blocked.allow).toBe(false);
    if (!blocked.allow) expect(blocked.error).toContain("ANDROID_BLIND_RETRY");
  });

  test("a real state check re-enables one retry, then the budget stops it", () => {
    const args = { package: "com.whatsapp" };
    noteAndroidDispatch("open_app", args, false, "504", false);
    noteAndroidStateCheck();
    expect(checkAndroidRetry("open_app", args, false).allow).toBe(true);
    noteAndroidDispatch("open_app", args, false, "504", false);
    noteAndroidStateCheck();
    const stop = checkAndroidRetry("open_app", args, false);
    expect(stop.allow).toBe(false);
    if (!stop.allow) expect(stop.error).toContain("ANDROID_RETRY_EXHAUSTED");
  });

  test("harmless state checks stay repeatable", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkAndroidRetry("foreground_app", {}, true).allow).toBe(true);
      noteAndroidDispatch("foreground_app", {}, true, "{}", true);
    }
  });

  test("status results become the runtime contract", () => {
    recordAndroidStatus(STATUS);
    expect(getAndroidSnapshot().capabilities.has("recents")).toBe(true);
  });
});

describe("completion honesty", () => {
  beforeEach(() => resetAndroidSession());

  test("a failed Android action cannot be reported as success", () => {
    noteAndroidDispatch("open_app", { package: "com.whatsapp" }, false, "503 not connected", false);
    expect(checkAndroidCompletion("WhatsApp opened successfully.")).toContain("FALSE_COMPLETION");
  });

  test("a verified action finishes normally", () => {
    noteAndroidDispatch("open_app", { package: "com.whatsapp" }, true, "{\"ok\":true}", false);
    expect(checkAndroidCompletion("WhatsApp is now in the foreground (verified).")).toBeNull();
  });

  test("an honest failure report passes through", () => {
    noteAndroidDispatch("open_app", { package: "com.whatsapp" }, false, "503", false);
    expect(checkAndroidCompletion("The launch failed: the phone is not connected.")).toBeNull();
  });
});
