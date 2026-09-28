// @vitest-environment jsdom
import type { ThreadSnapshot } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeDictation = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  subscribe: vi
    .fn()
    .mockImplementation(
      (fn: (state: { status: string; transcript: string; error?: string }) => void) => {
        fn({ status: "listening", transcript: "" });
        return () => {};
      },
    ),
}));

const fakeTtsLazy = vi.hoisted(() => ({
  withSpeaker: vi.fn(),
}));

vi.mock("../lib/dictation", () => ({
  dictation: fakeDictation,
}));

vi.mock("../lib/tts-lazy", () => ({
  withSpeaker: fakeTtsLazy.withSpeaker,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: any) => <button {...props} />,
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children, showCloseButton: _showCloseButton, ...props }: any) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

import { CallView } from "./CallView";

describe("CallView", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("returns to listening and reports error when TTS chunk loader fails", async () => {
    let shouldFail = false;
    fakeTtsLazy.withSpeaker.mockImplementation(
      (action: (speaker: any) => void, onError?: (error: unknown) => void) => {
        if (shouldFail) {
          onError?.(new Error("Failed to load chunk for voice playback"));
        } else {
          action({
            subscribe: vi.fn().mockReturnValue(() => {}),
            speak: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn(),
          });
        }
      },
    );

    const onSend = vi.fn().mockResolvedValue(undefined);
    const initialSnapshot: ThreadSnapshot = {
      messages: [],
      run: null,
    } as unknown as ThreadSnapshot;

    await act(async () => {
      root.render(
        <CallView
          botId="bot-1"
          botName="Test Bot"
          transcribe={false}
          snapshot={initialSnapshot}
          onSend={onSend}
          onFollowUp={vi.fn()}
          onAnswer={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Listening…");
    expect(fakeDictation.listen).toHaveBeenCalledOnce();

    // User speaks, transitioning call phase from listening to thinking.
    const listenOptions = fakeDictation.listen.mock.calls[0]?.[0];
    await act(async () => {
      listenOptions.onFinal("What is the capital of France?");
    });

    expect(container.textContent).toContain("Working…");
    expect(onSend).toHaveBeenCalledWith("What is the capital of France?");

    // Now bot response arrives while in thinking, and voice chunk loader fails.
    shouldFail = true;
    fakeDictation.listen.mockClear();

    const botSnapshot: ThreadSnapshot = {
      messages: [
        {
          id: "bot-msg-1",
          role: "bot",
          blocks: [{ kind: "text", text: "The capital of France is Paris." }],
          createdAt: new Date().toISOString(),
        },
      ],
      run: null,
    } as unknown as ThreadSnapshot;

    await act(async () => {
      root.render(
        <CallView
          botId="bot-1"
          botName="Test Bot"
          transcribe={false}
          snapshot={botSnapshot}
          onSend={onSend}
          onFollowUp={vi.fn()}
          onAnswer={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    // The call must leave the speaking/thinking path and return to listening.
    expect(container.textContent).toContain("Listening…");
    expect(fakeDictation.listen).toHaveBeenCalledOnce();

    // It must report the failure with a plain sentence instead of raw error details.
    expect(container.textContent).toContain("Voice failed");
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Failed to load chunk for voice playback" }),
    );
  });
});
