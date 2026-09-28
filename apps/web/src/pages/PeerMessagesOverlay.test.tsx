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
vi.mock("../lib/rpc", () => ({
  rpc: {
    threads: {
      messages: vi.fn(async () => ({
        messages: [
          {
            id: "sent",
            threadId: "thread",
            role: "bot",
            botId: "coordinator",
            createdAt: "2026-08-25T10:00:00.000Z",
            blocks: [
              { kind: "bot_message_sent", toBotId: "worker", toBotName: "Worker", text: "request" },
            ],
          },
          {
            id: "reply",
            threadId: "thread",
            role: "bot",
            replyToMessageId: "sent",
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
        ],
        olderCursor: null,
      })),
    },
  },
}));

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
    await act(async () =>
      root.render(
        createElement(PeerMessagesOverlay, {
          botId: "coordinator",
          groupId: "goal-room",
          botName: "Coordinator",
          botColor: "gray",
          peerBotId: "worker",
          peerBotName: "Worker",
          peerBotColor: "gray",
          onClose: vi.fn(),
          onOpenPeerThread: vi.fn(),
        }),
      ),
    );
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

it("separates two coordinators' exchanges with the same worker in one room", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.threads.messages).mockResolvedValue({
    threadId: "room",
    messages: [
      {
        id: "a-sent",
        threadId: "room",
        seq: 1,
        role: "bot",
        botId: "a",
        createdAt: "2026-08-25T10:00:00Z",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "w",
            toBotName: "Worker",
            text: "A request",
            deliveryId: "a-delivery",
          },
        ],
      },
      {
        id: "a-reply",
        threadId: "room",
        seq: 2,
        role: "user",
        replyToMessageId: "a-sent",
        createdAt: "2026-08-25T10:01:00Z",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "w",
            fromBotName: "Worker",
            text: "A reply",
            deliveryId: "a-reply-delivery",
          },
        ],
      },
      {
        id: "b-sent",
        threadId: "room",
        seq: 3,
        role: "bot",
        botId: "b",
        createdAt: "2026-08-25T10:02:00Z",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "w",
            toBotName: "Worker",
            text: "B request",
            deliveryId: "b-delivery",
          },
        ],
      },
      {
        id: "b-reply",
        threadId: "room",
        seq: 4,
        role: "user",
        replyToMessageId: "b-sent",
        createdAt: "2026-08-25T10:03:00Z",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "w",
            fromBotName: "Worker",
            text: "B reply",
            deliveryId: "b-reply-delivery",
          },
        ],
      },
    ],
    olderCursor: null,
  });
  for (const [botId, botName, own, other] of [
    ["a", "Coordinator A", "A", "B"],
    ["b", "Coordinator B", "B", "A"],
  ] as const) {
    const node = document.createElement("div");
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(PeerMessagesOverlay, {
            botId,
            botName,
            groupId: "room",
            botColor: "gray",
            peerBotId: "w",
            peerBotName: "Worker",
            peerBotColor: "gray",
            onClose: vi.fn(),
            onOpenPeerThread: vi.fn(),
          }),
        ),
      );
      const transcript = node.querySelector('[data-testid="peer-conversation-transcript"]');
      expect(transcript?.textContent).toContain(`${botName}${own} request`);
      expect(transcript?.textContent).toContain(`Worker${own} reply`);
      expect(transcript?.textContent).not.toContain(`${other} request`);
      expect(transcript?.textContent).not.toContain(`${other} reply`);
    } finally {
      await act(async () => root.unmount());
    }
  }
  vi.unstubAllGlobals();
});
