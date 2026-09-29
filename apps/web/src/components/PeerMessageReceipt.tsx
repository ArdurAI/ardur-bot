import type { MessageBlock } from "@ardurbot/contracts";
import { botMessageReceiptKind } from "@ardurbot/core";
import { useLingui } from "@lingui/react/macro";
import { CollaborationMarker } from "./ai/CollaborationMarker";

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

export function PeerMessageReceipt({
  block,
  color,
  onOpen,
}: {
  block: PeerBlock;
  color: string;
  onOpen: (peer: { peerBotId: string; peerBotName: string }) => void;
}) {
  const { t } = useLingui();
  const sent = block.kind === "bot_message_sent";
  const peer = sent ? block.toBotName : block.fromBotName;
  const peerBotId = sent ? block.toBotId : block.fromBotId;
  const recipient = sent ? peer : block.recipientBotName;
  const receipt = botMessageReceiptKind(block);
  const label =
    receipt === "held"
      ? t`Waiting for your approval`
      : receipt === "denied"
        ? t`Not approved`
        : receipt === "cancelled"
          ? t`Cancelled`
          : receipt === "waiting"
            ? t`Waiting for a turn`
            : receipt === "read"
              ? recipient
                ? t`Read by ${recipient}`
                : t`Read`
              : receipt === "replied"
                ? t`Replied`
                : receipt === "expired"
                  ? t`Expired`
                  : receipt === "failed"
                    ? t`Failed`
                    : receipt === "delivered"
                      ? sent
                        ? t`Delivered to ${peer}`
                        : t`Delivered from ${peer}`
                      : t`Sent`;
  const accessibleLabel =
    receipt === "sent"
      ? sent
        ? t`Sent to ${peer}`
        : t`Message from ${peer}`
      : receipt === "delivered"
        ? label
        : `${label} · ${sent ? t`to ${peer}` : t`from ${peer}`}`;
  return (
    <CollaborationMarker
      ariaLabel={accessibleLabel}
      color={color}
      identity={peerBotId}
      label={label}
      name={peer}
      onClick={() => onOpen({ peerBotId, peerBotName: peer })}
    />
  );
}
