import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  getSettings,
  subscribeSettings,
  updateSection,
  type NexusSettings,
  type SettingsSection,
} from "@/lib/settings-store";

/** Live NEXUS settings. SSR renders defaults, the client hydrates from localStorage. */
export function useSettings(): NexusSettings {
  return useSyncExternalStore(subscribeSettings, getSettings, () => DEFAULT_SETTINGS);
}

/** Convenience updater bound to one section. */
export function useSectionUpdater<S extends SettingsSection>(section: S) {
  return useCallback(
    (patch: Partial<NexusSettings[S]>) => updateSection(section, patch),
    [section],
  );
}
