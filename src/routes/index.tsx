import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { resolveStartupChatId } from "@/lib/chat-store";
import { ArcReactor } from "@/components/ArcReactor";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEXUS — Neural Executive eXchange Utility System" },
      {
        name: "description",
        content:
          "NEXUS OS — an AI assistant that controls your computer through a local helper agent.",
      },
      { property: "og:title", content: "NEXUS — Neural Executive eXchange Utility System" },
      {
        property: "og:description",
        content: "Your personal AI computer assistant.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    const id = resolveStartupChatId();
    navigate({ to: "/chat/$chatId", params: { chatId: id }, replace: true });
  }, [navigate]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <ArcReactor active size={72} />
      <p className="font-display text-sm tracking-widest text-primary text-glow">
        INITIALIZING NEXUS
      </p>
    </div>
  );
}
