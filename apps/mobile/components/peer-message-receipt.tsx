import { ChatMarkdown } from "@ardurbot/chat-ui/native";
import type { MessageBlock } from "@ardurbot/contracts";
import { botMessageReceiptKind } from "@ardurbot/core";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Button,
  Modal,
  Pressable,
  ScrollView,
  Text,
  type TextProps,
  View,
} from "react-native";
import type { MobileMessage, MobileMessagePage } from "../lib/api";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

type PeerMessageBlock = Extract<
  MessageBlock,
  { kind: "bot_message_sent" | "bot_message_received" }
>;

export function PeerMessageReceipt({
  block,
  color,
  recipientName,
  actionProps,
  onOpenPeer,
  botId,
  groupId,
}: {
  block: PeerMessageBlock;
  color: string;
  recipientName?: string;
  actionProps: Pick<TextProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">;
  onOpenPeer: (botId: string, name: string) => void;
  botId?: string;
  groupId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<MobileMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  const sent = block.kind === "bot_message_sent";
  const peer = sent ? block.toBotName : block.fromBotName;
  const peerBotId = sent ? block.toBotId : block.fromBotId;
  const receipt = botMessageReceiptKind(block);
  const recipient = sent ? peer : (block.recipientBotName ?? recipientName);
  const label =
    receipt === "waiting"
      ? t("Waiting for a turn")
      : receipt === "read"
        ? recipient
          ? t("Read by {recipient}", { recipient })
          : t("Read")
        : receipt === "replied"
          ? t("Replied")
          : receipt === "expired"
            ? t("Expired")
            : receipt === "failed"
              ? t("Failed")
              : receipt === "delivered"
                ? sent
                  ? t("Delivered to {peer}", { peer })
                  : t("Delivered from {peer}", { peer })
                : t("Sent");
  const accessibleLabel =
    receipt === "sent"
      ? sent
        ? t("Sent to {peer}", { peer })
        : t("Message from {peer}", { peer })
      : receipt === "delivered"
        ? label
        : `${label} · ${sent ? t("to {peer}", { peer }) : t("from {peer}", { peer })}`;
  useEffect(() => {
    if (!open) return;
    if (!botId && !groupId) {
      setMessages([{ id: "current", role: "bot", blocks: [block] }]);
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
  }, [open, botId, groupId, block]);
  const conversation = messages.flatMap((message) =>
    message.blocks.flatMap((entry) => {
      if (entry.kind === "bot_message_sent" && entry.toBotId === peerBotId)
        return [
          { id: message.id, author: recipientName ?? t("Bot"), text: entry.text, truncated: false },
        ];
      if (entry.kind === "bot_message_received" && entry.fromBotId === peerBotId)
        return [
          { id: message.id, author: peer, text: entry.text, truncated: Boolean(entry.truncated) },
        ];
      return [];
    }),
  );

  return (
    <View style={{ width: "100%", alignItems: "center", gap: 6 }}>
      <Pressable
        {...actionProps}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${accessibleLabel}. ${t("Open conversation")}`}
        onPress={() => setOpen(true)}
        style={{
          width: "100%",
          paddingVertical: 4,
          alignItems: "center",
          justifyContent: "flex-start",
          flexDirection: "row",
          gap: 6,
        }}
      >
        <BotAvatar color={color} identity={peerBotId} size={16} />
        <Text
          numberOfLines={1}
          style={{ color: tokens.mutedForeground, fontSize: 13.5, flexShrink: 1 }}
        >
          {label}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: tokens.background, padding: 16, gap: 12 }}>
          <Text style={{ color: tokens.foreground, fontSize: 18, fontWeight: "600" }}>{peer}</Text>
          <Button title={t("Close")} onPress={() => setOpen(false)} />
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
                    onPress={() => {
                      setOpen(false);
                      onOpenPeer(peerBotId, peer);
                    }}
                  />
                ) : null}
              </View>
            ))}
          </ScrollView>
          <Text style={{ color: tokens.mutedForeground }}>{t("This chat is view-only")}</Text>
        </View>
      </Modal>
    </View>
  );
}
