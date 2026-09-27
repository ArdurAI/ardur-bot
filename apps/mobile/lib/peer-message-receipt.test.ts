// @vitest-environment jsdom
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
