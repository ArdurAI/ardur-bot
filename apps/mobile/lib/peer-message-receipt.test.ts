// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PeerMessageReceipt } from "../components/peer-message-receipt";
import { rpc } from "./api";

vi.mock("./api", () => ({ rpc: vi.fn() }));
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
    background: "white",
    destructive: "red",
  }),
}));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, args?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => args?.[key] ?? ""),
  }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("section", null, children),
  Modal: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
    visible ? createElement("dialog", { open: true }, children) : null,
  ActivityIndicator: () => null,
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, title),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
}));

it("opens a view-only native sheet with the peer's receipt and closes it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
            text: "Review complete.",
            deliveryState: "read",
          },
          color: "gray",
          actionProps: {},
          onOpenPeer: vi.fn(),
        }),
      ),
    );
    expect(node.querySelector("dialog")).toBeNull();
    expect(node.querySelector("button")?.getAttribute("aria-label")).toContain("Open conversation");
    await act(async () => node.querySelector("button")!.click());
    expect(node.querySelector("dialog")?.textContent).toContain("Review complete.");
    expect(node.querySelector("dialog")?.textContent).toContain("This chat is view-only");
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent === "Close")!
        .click(),
    );
    expect(node.querySelector("dialog")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the queued receipt label while offering the conversation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(PeerMessageReceipt, {
          block: {
            kind: "bot_message_sent",
            toBotId: "worker",
            toBotName: "Worker",
            text: "Please check.",
            deliveryState: "delivered",
            queuedForBusy: true,
          },
          color: "gray",
          actionProps: {},
          onOpenPeer: vi.fn(),
        }),
      ),
    );
    expect(node.textContent).toContain("Waiting for a turn");
    await act(async () => node.querySelector("button")!.click());
    expect(node.querySelector("dialog")?.textContent).toContain("Please check.");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("loads a full peer conversation from the owning thread without allowing edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockResolvedValue({
    messages: [
      {
        id: "sent",
        role: "bot",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "worker",
            toBotName: "Worker",
            text: "Please review.",
          },
        ],
      },
      {
        id: "received",
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "worker",
            fromBotName: "Worker",
            text: "Reviewed.",
          },
        ],
      },
    ],
    olderCursor: null,
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(PeerMessageReceipt, {
          block: {
            kind: "bot_message_sent",
            toBotId: "worker",
            toBotName: "Worker",
            text: "Please review.",
            deliveryState: "replied",
          },
          botId: "owner-bot",
          color: "gray",
          actionProps: {},
          onOpenPeer: vi.fn(),
        }),
      ),
    );
    await act(async () => node.querySelector("button")!.click());
    expect(vi.mocked(rpc)).toHaveBeenCalledWith("threads/messages", {
      botId: "owner-bot",
      before: undefined,
      includePeerRuns: true,
    });
    expect(node.querySelector("dialog")?.textContent).toContain("Please review.");
    expect(node.querySelector("dialog")?.textContent).toContain("Reviewed.");
    expect(node.querySelector("dialog input, dialog textarea")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.mocked(rpc).mockReset();
    vi.unstubAllGlobals();
  }
});
