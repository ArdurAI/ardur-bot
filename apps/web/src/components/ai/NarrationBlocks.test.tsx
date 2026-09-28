// @vitest-environment jsdom
import type { MessageBlock } from "@ardurbot/contracts";
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
