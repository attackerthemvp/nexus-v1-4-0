import { describe, expect, test } from "vitest";
import {
  ANDROID_INTENT_RULES,
  ANDROID_REPEAT_SAFE_COMMANDS,
  normalizePhoneCommandArgs,
  resolveAndroidApp,
} from "./android-apps";

describe("android app mapping", () => {
  test("resolves plain names, aliases and abbreviations case-insensitively", () => {
    expect(resolveAndroidApp("WhatsApp").resolved).toBe("com.whatsapp");
    expect(resolveAndroidApp("yt").resolved).toBe("com.google.android.youtube");
    expect(resolveAndroidApp("IG").resolved).toBe("com.instagram.android");
    expect(resolveAndroidApp("Play Store").resolved).toBe("com.android.vending");
    expect(resolveAndroidApp("the browser").resolved).toBe("com.android.chrome");
    expect(resolveAndroidApp("Disney+").resolved).toBe("com.disney.disneyplus");
    expect(resolveAndroidApp("open up whatsapp now").resolved).toBe("com.whatsapp");
  });

  test("passes through an explicit package id", () => {
    const r = resolveAndroidApp("com.example.thing");
    expect(r.exact).toBe(true);
    expect(r.resolved).toBe("com.example.thing");
  });

  test("prefers the installed variant when several candidates exist", () => {
    const r = resolveAndroidApp("phone", ["com.google.android.dialer", "com.whatsapp"]);
    expect(r.resolved).toBe("com.google.android.dialer");
    const none = resolveAndroidApp("phone", ["com.whatsapp"]);
    expect(none.resolved).toBeNull();
  });

  test("unknown apps resolve to nothing rather than a guess", () => {
    const r = resolveAndroidApp("zzzz totally unknown app");
    expect(r.candidates).toEqual([]);
    expect(r.resolved).toBeNull();
  });

  test("open_app arguments are corrected to the verified {package} schema", () => {
    const a = normalizePhoneCommandArgs("open_app", { package_name: "com.whatsapp" });
    expect(a.args).toEqual({ package: "com.whatsapp" });
    expect(a.note).toContain("package");

    const b = normalizePhoneCommandArgs("open_app", { package: "YouTube" });
    expect(b.args["package"]).toBe("com.google.android.youtube");

    const c = normalizePhoneCommandArgs("home", {});
    expect(c.args).toEqual({});
    expect(c.note).toBeUndefined();
  });

  test("state checks and home are repeat-safe", () => {
    for (const c of ["home", "back", "foreground_app", "screen_read", "wait_for_app"])
      expect(ANDROID_REPEAT_SAFE_COMMANDS.has(c)).toBe(true);
    expect(ANDROID_REPEAT_SAFE_COMMANDS.has("click_element")).toBe(false);
  });
});

describe("device-verified packages and recents", () => {
  test("phone resolves to the verified Samsung contacts package", () => {
    expect(resolveAndroidApp("phone").resolved).toBe("com.samsung.android.contacts");
    expect(resolveAndroidApp("dialer").resolved).toBe("com.samsung.android.contacts");
  });

  test("janitor ai is a known app", () => {
    expect(resolveAndroidApp("Janitor AI").resolved).toBe("com.janitor.ai");
  });

  test("recents navigation is repeat-safe", () => {
    expect(ANDROID_REPEAT_SAFE_COMMANDS.has("recents")).toBe(true);
  });

  test("prompt rules cover recents, incomplete list_apps and completion", () => {
    expect(ANDROID_INTENT_RULES).toContain("recents");
    expect(ANDROID_INTENT_RULES).toContain("INCOMPLETE");
    expect(ANDROID_INTENT_RULES).toContain("COMPLETION");
  });
});
