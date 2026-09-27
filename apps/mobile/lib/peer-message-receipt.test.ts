// @vitest-environment jsdom

import type { MessageBlock } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PeerMessageReceipt } from "../components/peer-message-receipt";

vi.mock("@ardurbot/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => createElement("article", null, children),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({
    mutedForeground: "gray",
    foreground: "black",
    border: "gray",
    card: "white",
  }),
}));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (value: string, args?: { peer: string }) => value.replace("{peer}", args?.peer ?? ""),
  }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityState?: { expanded?: boolean };
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-expanded": accessibilityState?.expanded },
      children,
    ),
}));

it("shows a completed peer receipt and expands the full answer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const answer = "The external request is completed, awaiting acceptance by its owner.";
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(PeerMessageReceipt, {
          block: {
            kind: "bot_message_received",
            fromBotId: "worker",
            fromBotName: "Worker",
            text: answer,
            intent: "result",
          },
          color: "gray",
          actionProps: {},
          onOpenPeer: vi.fn(),
        }),
      ),
    );
    expect(node.textContent).toContain("Message from Worker");
    expect(node.textContent).toContain("Show reply");
    expect(node.querySelector("article")).toBeNull();
    await act(async () => node.querySelector("button")!.click());
    expect(node.querySelector("article")?.textContent).toBe(answer);
    expect(node.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => node.querySelector("button")!.click());
    expect(node.querySelector("article")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("marks and links a shortened reply in the reader", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { fixture } = await vi.importActual<{
    fixture: () => {
      admit: (input: { admissionKey: string }) => Promise<{ id: string }>;
      worker: () => {
        $transaction: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      };
      state: () => { messages: Array<{ blocks: MessageBlock[] }> };
    };
  }>("../../../packages/db/src/delegation-test-fixture");
  const { finishDelegation } = await vi.importActual<{
    finishDelegation: (
      tx: unknown,
      id: string,
      status: "completed",
      text: string,
    ) => Promise<unknown>;
  }>("../../../packages/db/src/delegation");
  const f = fixture();
  const row = await f.admit({ admissionKey: "bot-message:parent:message_bot:0" });
  const answer = "x".repeat(2100);
  await f.worker().$transaction((tx) => finishDelegation(tx, row.id, "completed", answer));
  const block = f.state().messages[0]!.blocks[0] as Extract<
    MessageBlock,
    { kind: "bot_message_received" }
  >;
  expect(block).toMatchObject({ truncated: true, fullLength: 2100 });
  const onOpenPeer = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(PeerMessageReceipt, {
          block,
          color: "gray",
          actionProps: {},
          onOpenPeer,
        }),
      ),
    );
    await act(async () => node.querySelector("button")!.click());
    expect(node.querySelector("article")?.textContent).toBe(answer.slice(0, 2000));
    expect(node.textContent).toContain(
      "Reply shortened — open the conversation with Worker for the full text",
    );
    await act(async () => node.querySelectorAll("button")[1]!.click());
    expect(onOpenPeer).toHaveBeenCalledWith("worker", "Worker");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
