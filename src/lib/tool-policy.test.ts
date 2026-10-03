import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings-store";
import { checkToolPolicy, isInsideWorkspace, pathArgsOf, toolCategory } from "@/lib/tool-policy";

const base = () =>
  JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;

describe("workspace containment", () => {
  it("accepts the root and paths inside it", () => {
    expect(isInsideWorkspace("/home/me/projects", "/home/me/projects")).toBe(true);
    expect(isInsideWorkspace("/home/me/projects/app/src/a.ts", "/home/me/projects")).toBe(true);
    expect(isInsideWorkspace("C:\\Users\\Me\\Dev\\app", "C:/Users/me/dev")).toBe(true);
  });

  it("rejects paths outside the root", () => {
    expect(isInsideWorkspace("/home/me/secrets/.ssh", "/home/me/projects")).toBe(false);
    expect(isInsideWorkspace("/home/me/projects-other", "/home/me/projects")).toBe(false);
  });

  it("collects every path-like argument", () => {
    expect(pathArgsOf({ path: "a", repo: "b", paths: ["c", "-A"], other: 1 })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("coding policy", () => {
  it("blocks a patch outside the workspace", () => {
    const s = base();
    s.coding.workspaceRoot = "/home/me/projects";
    const d = checkToolPolicy("apply_patch", { path: "/etc/hosts", edits: [] }, s);
    expect(d.allow).toBe(false);
  });

  it("allows a patch inside the workspace in autonomous mode", () => {
    const s = base();
    s.coding.workspaceRoot = "/home/me/projects";
    const d = checkToolPolicy("apply_patch", { path: "/home/me/projects/a.ts", edits: [] }, s);
    expect(d).toEqual({ allow: true });
  });

  it("asks for confirmation for every write in confirm mode", () => {
    const s = base();
    s.coding.mode = "confirm";
    const d = checkToolPolicy("apply_patch", { path: "/tmp/a.ts", edits: [] }, s);
    expect(d.allow).toBe(true);
    expect(d.allow && d.confirm).toBeTruthy();
  });

  it("blocks git push unless explicitly allowed", () => {
    const s = base();
    expect(checkToolPolicy("git_push", { repo: "/tmp/r" }, s).allow).toBe(false);
    s.coding.allowPush = true;
    expect(checkToolPolicy("git_push", { repo: "/tmp/r" }, s).allow).toBe(true);
  });

  it("blocks the toolkit when coding is disabled", () => {
    const s = base();
    s.coding.enabled = false;
    expect(checkToolPolicy("grep", { root: "/tmp", pattern: "x" }, s).allow).toBe(false);
  });
});

describe("NEXUS Android Agent tools", () => {
  it("allows the read-only phone tools by default", () => {
    for (const t of ["phone_agent_status", "phone_ping", "phone_info"]) {
      expect(checkToolPolicy(t, {}, base()).allow).toBe(true);
      expect(toolCategory(t)).toBe("info");
    }
  });

  it("treats phone_agent_command as device control gated by desktop permission", () => {
    expect(toolCategory("phone_agent_command")).toBe("desktop");
    const s = base();
    expect(checkToolPolicy("phone_agent_command", { command: "ping" }, s).allow).toBe(true);
    s.security.permissions.desktopControl = false;
    expect(checkToolPolicy("phone_agent_command", { command: "ping" }, s).allow).toBe(false);
  });
});

describe("desktop automation tools", () => {
  it("categorises launch_app and show_desktop as desktop tools", () => {
    expect(toolCategory("launch_app")).toBe("desktop");
    expect(toolCategory("show_desktop")).toBe("desktop");
  });

  it("allows ordinary desktop actions without confirmation by default", () => {
    const s = base();
    expect(checkToolPolicy("launch_app", { name: "Steam" }, s)).toEqual({ allow: true });
    expect(checkToolPolicy("show_desktop", {}, s)).toEqual({ allow: true });
    expect(checkToolPolicy("desktop_click", { x: 10, y: 20, double: true }, s)).toEqual({ allow: true });
  });

  it("blocks desktop tools when desktop control is off", () => {
    const s = base();
    s.security.permissions.desktopControl = false;
    expect(checkToolPolicy("launch_app", { name: "Steam" }, s).allow).toBe(false);
    expect(checkToolPolicy("show_desktop", {}, s).allow).toBe(false);
  });

  it("asks for confirmation only when confirmDesktopControl is on", () => {
    const s = base();
    s.computer.confirmDesktopControl = true;
    const d = checkToolPolicy("launch_app", { name: "Steam" }, s);
    expect(d.allow).toBe(true);
    expect(d.allow && d.confirm).toBeTruthy();
    // reads stay silent even in confirm mode
    expect(checkToolPolicy("desktop_read", {}, s)).toEqual({ allow: true });
  });
});
