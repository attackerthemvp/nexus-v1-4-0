import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { JarvisChat } from "@/components/JarvisChat";

export const Route = createFileRoute("/chat/$chatId")({
  head: () => ({
    meta: [
      { title: "Conversation — NEXUS" },
      {
        name: "description",
        content:
          "A saved NEXUS conversation with full message history, voice control and local agent actions.",
      },
      { property: "og:title", content: "NEXUS Conversation" },
      {
        property: "og:description",
        content: "Persistent NEXUS chat with voice and computer control.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ChatPage,
});

function ChatPage() {
  const { chatId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <JarvisChat
      key={chatId}
      chatId={chatId}
      onNavigateChat={(id) => navigate({ to: "/chat/$chatId", params: { chatId: id } })}
    />
  );
}
