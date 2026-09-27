import type { MessageBlock } from "@ardurbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: string[]) =>
      parts.reduce((label, part, index) => label + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("./ai/CollaborationMarker", () => ({
  CollaborationMarker: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

import { PeerMessageReceipt } from "./PeerMessageReceipt";

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" }>;

it.each([
  [undefined, false, "Sent"],
  ["delivered", false, "Delivered to Worker"],
  ["delivered", true, "Waiting for a turn"],
  ["read", false, "Read by Worker"],
  ["replied", false, "Replied"],
  ["expired", false, "Expired"],
  ["failed", false, "Failed"],
] as const)("renders %s / busy %s as one %s chip", (state, queuedForBusy, label) => {
  const block: PeerBlock = {
    kind: "bot_message_sent",
    toBotId: "worker",
    toBotName: "Worker",
    text: "Check the fixture",
    ...(state ? { deliveryState: state } : {}),
    queuedForBusy,
  };
  const html = renderToStaticMarkup(
    <PeerMessageReceipt block={block} color="ink" onOpen={vi.fn()} />,
  );
  expect(html).toContain(label);
  expect(html.match(/<button/g)).toHaveLength(1);
});

it("names the recipient in the received thread", () => {
  const html = renderToStaticMarkup(
    <PeerMessageReceipt
      block={{
        kind: "bot_message_received",
        fromBotId: "chief",
        fromBotName: "Chief",
        recipientBotName: "Worker",
        text: "Check the fixture",
        deliveryState: "read",
      }}
      color="ink"
      onOpen={vi.fn()}
    />,
  );
  expect(html).toContain("Read by Worker");
});
