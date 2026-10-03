import { afterEach, describe, expect, it } from "vitest";
import {
  getProviderConfig,
  nextProviderApiKey,
  providerApiKeys,
  providerKeyNames,
} from "./config";

const SLOTS = ["TESTPROV_KEY", "TESTPROV_KEY_2", "TESTPROV_KEY_3", "TESTPROV_KEY_4"];

function testCfg() {
  const cfg = getProviderConfig("gemini")!;
  return { ...cfg, id: "testprov" as any, secretName: "TESTPROV_KEY" };
}

afterEach(() => {
  for (const k of SLOTS) delete process.env[k];
});

describe("multi-key provider slots", () => {
  it("names 4 slots with the original key as slot 1", () => {
    expect(providerKeyNames(testCfg())).toEqual(SLOTS);
  });

  it("keeps single-key setups working (slot 1 only)", () => {
    process.env['TESTPROV_KEY'] = "a";
    expect(providerApiKeys(testCfg())).toEqual(["a"]);
  });

  it("collects only the configured slots, in order", () => {
    process.env['TESTPROV_KEY_2'] = "b";
    process.env['TESTPROV_KEY_4'] = "d";
    expect(providerApiKeys(testCfg())).toEqual(["b", "d"]);
  });

  it("rotates keys round-robin across calls", () => {
    process.env['TESTPROV_KEY'] = "a";
    process.env['TESTPROV_KEY_2'] = "b";
    process.env['TESTPROV_KEY_3'] = "c";
    const cfg = testCfg();
    expect([nextProviderApiKey(cfg), nextProviderApiKey(cfg), nextProviderApiKey(cfg), nextProviderApiKey(cfg)])
      .toEqual(["a", "b", "c", "a"]);
  });

  it("returns undefined when no key is configured", () => {
    expect(nextProviderApiKey(testCfg())).toBeUndefined();
  });
});
