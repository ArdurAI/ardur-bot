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
  CollaborationMarker: ({ label, ariaLabel }: { label: string; ariaLabel: string }) => (
    <button type="button" aria-label={ariaLabel}>
      {label}
    </button>
  ),
}));

import { PeerMessageReceipt } from "./PeerMessageReceipt";

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" }>;

it.each([
  [undefined, false, "Sent", "Sent to Worker"],
  ["delivered", false, "Delivered to Worker", "Delivered to Worker"],
  ["delivered", true, "Waiting for a turn", "Waiting for a turn · to Worker"],
  ["read", false, "Read by Worker", "Read by Worker · to Worker"],
  ["replied", false, "Replied", "Replied · to Worker"],
  ["expired", false, "Expired", "Expired · to Worker"],
  ["failed", false, "Failed", "Failed · to Worker"],
] as const)("renders %s / busy %s as one %s chip", (state, queuedForBusy, label, accessible) => {
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
  expect(html).toContain(`aria-label="${accessible}"`);
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
  expect(html).toContain('aria-label="Read by Worker · from Chief"');
});

it("keeps the sender's name on historical incoming messages", () => {
  const html = renderToStaticMarkup(
    <PeerMessageReceipt
      block={{
        kind: "bot_message_received",
        fromBotId: "chief",
        fromBotName: "Chief",
        text: "Hello",
      }}
      color="ink"
      onOpen={vi.fn()}
    />,
  );
  expect(html).toContain('aria-label="Message from Chief"');
});

it("identifies the sender of a failed incoming delivery", () => {
  const html = renderToStaticMarkup(
    <PeerMessageReceipt
      block={{
        kind: "bot_message_received",
        fromBotId: "chief",
        fromBotName: "Chief",
        text: "",
        deliveryState: "failed",
      }}
      color="ink"
      onOpen={vi.fn()}
    />,
  );
  expect(html).toContain('aria-label="Failed · from Chief"');
});
