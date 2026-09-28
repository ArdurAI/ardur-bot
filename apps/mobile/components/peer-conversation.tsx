import { ChatMarkdown } from "@ardurbot/chat-ui/native";
import type { MessageBlock } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Button, ScrollView, Text, View } from "react-native";
import type { MobileMessage, MobileMessagePage } from "../lib/api";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

/** Read-only peer history for both a receipt sheet and the Team conversation route. */
export function PeerConversation({
  botId,
  groupId,
  peerBotId,
  peerName,
  botName,
  fallbackBlock,
  onOpenPeer,
}: {
  botId?: string;
  groupId?: string;
  peerBotId: string;
  peerName: string;
  botName: string;
  fallbackBlock?: PeerBlock;
  onOpenPeer: (botId: string, name: string) => void;
}) {
  const [messages, setMessages] = useState<MobileMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();

  useEffect(() => {
    if (!botId && !groupId) {
      setMessages(fallbackBlock ? [{ id: "current", role: "bot", blocks: [fallbackBlock] }] : []);
      return;
    }
    let active = true;
    setLoading(true);
    setFailed(false);
    const load = async () => {
      let before: number | undefined;
      let collected: MobileMessage[] = [];
      do {
        const page = await rpc<MobileMessagePage>("threads/messages", {
          ...(groupId ? { groupId } : { botId }),
          before,
          includePeerRuns: true,
        });
        if (!active) return;
        collected = [...page.messages, ...collected];
        before = page.olderCursor ?? undefined;
      } while (before !== undefined);
      if (active) setMessages(collected);
    };
    void load()
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [botId, groupId, fallbackBlock]);

  const conversation = messages.flatMap((message) =>
    message.blocks.flatMap((entry) => {
      if (entry.kind === "bot_message_sent" && entry.toBotId === peerBotId)
        return [{ id: message.id, author: botName, text: entry.text, truncated: false }];
      if (entry.kind === "bot_message_received" && entry.fromBotId === peerBotId)
        return [
          {
            id: message.id,
            author: peerName,
            text: entry.text,
            truncated: Boolean(entry.truncated),
          },
        ];
      return [];
    }),
  );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.background, padding: 16, gap: 12 }}>
      <Text style={{ color: tokens.foreground, fontSize: 18, fontWeight: "600" }}>{peerName}</Text>
      {loading ? <ActivityIndicator /> : null}
      {failed ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not load this chat.")}
        </Text>
      ) : null}
      {!loading && !failed && !conversation.length ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No messages yet.")}</Text>
      ) : null}
      <ScrollView contentContainerStyle={{ gap: 10 }}>
        {conversation.map((item) => (
          <View
            key={item.id}
            style={{ borderRadius: 12, backgroundColor: tokens.card, padding: 12 }}
          >
            <Text style={{ color: tokens.mutedForeground }}>{item.author}</Text>
            <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
              {item.text}
            </ChatMarkdown>
            {item.truncated ? (
              <Button
                title={t("Open peer thread")}
                onPress={() => onOpenPeer(peerBotId, peerName)}
              />
            ) : null}
          </View>
        ))}
      </ScrollView>
      <Text style={{ color: tokens.mutedForeground }}>{t("This chat is view-only")}</Text>
    </View>
  );
}
