/** Build/version identity surfaced in Settings → Advanced. */
export const NEXUS_VERSION = "1.0.0";

/** Short build stamp — the mode Vite built this bundle in. */
export const NEXUS_BUILD =
  typeof import.meta !== "undefined" && import.meta.env
    ? import.meta.env.MODE
    : "unknown";
