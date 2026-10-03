// NEXUS LLM adapter endpoint for the ported Artemis engine. Replaces upstream
// Gemini/Vertex/LangChain clients with the NEXUS provider router (Lovable AI
// first, then backup keys, health-aware failover). The Artemis mode is not an
// input here, so provider failover can never switch Flash <-> Pro.
import { createFileRoute } from "@tanstack/react-router";
import { routeChat, type RoutingOverrides } from "@/lib/ai/router";

export const Route = createFileRoute("/api/artemis-llm")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { messages?: unknown; tools?: unknown; ai?: RoutingOverrides };
          if (!Array.isArray(body.messages)) return Response.json({ error: "messages required" }, { status: 400 });
          const { response, attempts } = await routeChat({
            messages: body.messages,
            tools: Array.isArray(body.tools) ? body.tools : [],
            ...(body.ai ? { overrides: body.ai } : {}),
          });
          return Response.json({
            text: response.text,
            toolCalls: response.toolCalls,
            provider: response.providerName,
            model: response.model,
            attempts: attempts.length,
          });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
    },
  },
});
