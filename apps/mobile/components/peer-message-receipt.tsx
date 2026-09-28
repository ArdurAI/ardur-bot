import type { MessageBlock } from "@ardurbot/contracts";
import { botMessageReceiptKind } from "@ardurbot/core";
import { useState } from "react";
import { Button, Modal, Pressable, Text, type TextProps, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { BotAvatar } from "./bot-avatar";
import { PeerConversation } from "./peer-conversation";

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
        {open ? (
          <View style={{ flex: 1, backgroundColor: tokens.background }}>
            <Button title={t("Close")} onPress={() => setOpen(false)} />
            <PeerConversation
              botId={botId}
              groupId={groupId}
              peerBotId={peerBotId}
              peerName={peer}
              botName={recipientName ?? t("Bot")}
              fallbackBlock={block}
              onOpenPeer={(id, name) => {
                setOpen(false);
                onOpenPeer(id, name);
              }}
            />
          </View>
        ) : null}
      </Modal>
    </View>
  );
}
