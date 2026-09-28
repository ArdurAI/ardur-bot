// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { PeerMessagesOverlay } from "./PeerMessagesOverlay";

vi.mock("@ardurbot/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => createElement("article", null, children),
}));
vi.mock("@ardurbot/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogClose: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../lib/rpc", () => ({ rpc: { threads: { messages: vi.fn(async () => ({
  messages: [
      {
        id: "reply",
        threadId: "thread",
        role: "bot",
        createdAt: "2026-08-25T10:01:00.000Z",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "worker",
            fromBotName: "Worker",
            text: "preview",
            truncated: true,
            fullLength: 2100,
          },
        ],
      },
  ], olderCursor: null,
})) } } }));

it("shows a link to the peer thread for a shortened reply", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onOpenPeerThread = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(PeerMessagesOverlay, {
          botId: "coordinator",
          botName: "Coordinator",
          botColor: "gray",
          peerBotId: "worker",
          peerBotName: "Worker",
          peerBotColor: "gray",
          onClose: vi.fn(),
          onOpenPeerThread,
        }),
      ),
    );
    const marker = [...node.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Reply shortened"),
    );
    expect(marker?.textContent).toContain("Worker");
    await act(async () => marker!.click());
    expect(onOpenPeerThread).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("loads the coordinator's latest peer exchange from its group thread", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(PeerMessagesOverlay, {
      botId: "coordinator",
      groupId: "goal-room",
      botName: "Coordinator",
      botColor: "gray",
      peerBotId: "worker",
      peerBotName: "Worker",
      peerBotColor: "gray",
      onClose: vi.fn(),
      onOpenPeerThread: vi.fn(),
    })));
    expect(rpc.threads.messages).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "goal-room", includePeerRuns: true }),
      expect.anything(),
    );
    expect(node.textContent).toContain("preview");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
