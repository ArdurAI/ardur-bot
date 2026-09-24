// @vitest-environment jsdom
import type { RunActivityRow } from "@ardurbot/contracts";
import type { PropsWithChildren } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ get: vi.fn(), answer: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { threads: calls } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => {
  const Wrapper = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return { Dialog: Wrapper, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper };
});
vi.mock("../components/AskCard", () => ({
  AskCard: ({
    canAnswer,
    onAnswer,
  }: {
    canAnswer: boolean;
    onAnswer: (value: string) => Promise<void>;
  }) => (
    <button type="button" disabled={!canAnswer} onClick={() => void onAnswer("allow")}>
      Read once
    </button>
  ),
}));

import { ChatTaskReview } from "./ChatTaskReview";

it("reads and answers the isolated task thread without opening the personal bot history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.get.mockResolvedValue({
    run: { id: "run", status: "waiting_input" },
    messages: [
      {
        id: "message",
        runId: "run",
        blocks: [{ kind: "ask", text: "Preview", status: "pending" }],
      },
    ],
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChatTaskReview
          run={
            { botId: "bot", threadId: "room", runId: "run", botName: "Test bot" } as RunActivityRow
          }
          onClose={() => undefined}
        />,
      ),
    );
    expect(calls.get).toHaveBeenCalledWith({ botId: "bot", threadId: "room" });
    await act(async () => container.querySelector("button")!.click());
    expect(calls.answer).toHaveBeenCalledWith({
      botId: "bot",
      threadId: "room",
      runId: "run",
      messageId: "message",
      answer: "allow",
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
