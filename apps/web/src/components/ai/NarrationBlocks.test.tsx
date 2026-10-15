// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import type { MessageBlock } from "@ardurbot/contracts";
import { GOAL_FREEZE_CANCELLED } from "@ardurbot/contracts";
import { i18n } from "@lingui/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NarrationBlocks } from "./NarrationBlocks";

describe("NarrationBlocks", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders a streaming unmarked progress block's text in the bubble", () => {
    // Unit-level equivalent of the e2e assertion that a streamed reply token
    // becomes visible while the run is still in flight.
    const blocks: MessageBlock[] = [{ kind: "progress", text: "First fixture token" }];

    act(() => {
      root.render(<NarrationBlocks blocks={blocks} />);
    });

    expect(container.textContent).toContain("First fixture token");
  });

  it("translates the stored freeze reason in ordinary chat", () => {
    const sentence = "The goal reached owner review before this work started.";
    const catalog = readFileSync("apps/web/src/locales/ru/messages.po", "utf8");
    const entry = `msgid ${JSON.stringify(sentence)}\nmsgstr "`;
    const at = catalog.indexOf(entry);
    expect(at).toBeGreaterThanOrEqual(0);
    const translation = catalog.slice(at + entry.length, catalog.indexOf('"\n', at + entry.length));
    i18n.load("ru", { [sentence]: translation });
    i18n.activate("ru");
    try {
      act(() =>
        root.render(
          <NarrationBlocks
            blocks={[
              { kind: "text", text: `Coordinator → Worker: cancelled.\n${GOAL_FREEZE_CANCELLED}` },
            ]}
          />,
        ),
      );
      expect(container.textContent).toContain(translation);
      expect(container.textContent).not.toContain(GOAL_FREEZE_CANCELLED);
      expect(container.textContent).not.toContain(sentence);
    } finally {
      i18n.activate("en");
    }
  });

  it("renders text and progress narration in order", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Earlier answer." },
      { kind: "progress", text: "Still streaming" },
    ];

    act(() => {
      root.render(<NarrationBlocks blocks={blocks} quoteMessageId="m_1" />);
    });

    expect(container.textContent).toBe("Earlier answer.Still streaming");
    expect(container.querySelector("[data-quote-message-id='m_1']")?.textContent).toContain(
      "Earlier answer.",
    );
  });
});
