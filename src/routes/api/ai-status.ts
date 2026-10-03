import { createFileRoute } from "@tanstack/react-router";

import { snapshot } from "@/lib/ai/health";

// Non-sensitive provider health for the NEXUS HUD. Never returns keys.
export const Route = createFileRoute("/api/ai-status")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ providers: snapshot() }), {
          headers: { "Content-Type": "application/json" },
        }),
    },
  },
});
