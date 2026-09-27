import { ChatMarkdown } from "@ardurbot/chat-ui/native";
import type { MessageBlock } from "@ardurbot/contracts";
import { useState } from "react";
import { Pressable, Text, type TextProps, View } from "react-native";
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
  actionProps,
  onOpenPeer,
}: {
  block: PeerMessageBlock;
  color: string;
  actionProps: Pick<TextProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">;
  onOpenPeer: (botId: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  const sent = block.kind === "bot_message_sent";
  const peer = sent ? block.toBotName : block.fromBotName;
  const peerBotId = sent ? block.toBotId : block.fromBotId;
  const label =
    block.deliveryState === "delivered"
      ? sent
        ? t("Delivered to {peer}", { peer })
        : t("Delivered from {peer}", { peer })
      : sent
        ? t("Messaged {peer}", { peer })
        : t("Message from {peer}", { peer });
  const visibleLabel = block.queuedForBusy ? `${label} · ${t("Queued")}` : label;
  const canShowReply = !sent && block.text.trim().length > 0;

  return (
    <View style={{ width: "100%", alignItems: "center", gap: 6 }}>
      <Pressable
        {...actionProps}
        accessible
        accessibilityRole={canShowReply ? "button" : undefined}
        accessibilityLabel={
          canShowReply
            ? `${visibleLabel}. ${expanded ? t("Hide reply") : t("Show reply")}`
            : visibleLabel
        }
        accessibilityState={canShowReply ? { expanded } : undefined}
        onPress={canShowReply ? () => setExpanded((value) => !value) : undefined}
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
          {visibleLabel}
        </Text>
        {canShowReply ? (
          <Text style={{ color: tokens.foreground, fontSize: 13.5 }}>
            {expanded ? t("Hide reply") : t("Show reply")}
          </Text>
        ) : null}
      </Pressable>
      {canShowReply && expanded ? (
        <View
          style={{
            width: "100%",
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
            {block.text}
          </ChatMarkdown>
          {block.kind === "bot_message_received" && block.truncated ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => onOpenPeer(peerBotId, peer)}
              style={{ marginTop: 8 }}
            >
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: 13.5,
                  textDecorationLine: "underline",
                }}
              >
                {t("Reply shortened — open the conversation with {peer} for the full text", {
                  peer,
                })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
