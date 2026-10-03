// NEXUS addition: the user's manual Flash/Pro selection. Only the composer
// switch writes it; the engine reads it once at task start.
import { useSyncExternalStore } from "react";
import type { ArtemisMode } from "./types";

const KEY = "nexus.artemis.mode";
let mode: ArtemisMode = "flash";
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  const v = window.localStorage.getItem(KEY);
  if (v === "flash" || v === "pro") mode = v;
}

export function getArtemisMode(): ArtemisMode {
  load();
  return mode;
}

export function setArtemisMode(m: ArtemisMode) {
  mode = m;
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, m);
  listeners.forEach((l) => l());
}

export function useArtemisMode(): ArtemisMode {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getArtemisMode,
    () => "flash",
  );
}
