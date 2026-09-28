// @vitest-environment jsdom
import type { MessageBlock } from "@ardurbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactWorkRecord } from "./CompactWorkRecord";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: string[]) =>
      parts.reduce((label, part, index) => label + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: any) => <>{children}</>,
}));

describe("CompactWorkRecord", () => {
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

  it("shows a reasoning summary exactly once, in full, in the expanded record", () => {
    const summary =
      "Weighing two approaches before answering, with a deliberately long explanation that must never be truncated.";
    const blocks: MessageBlock[] = [{ kind: "progress", text: summary, reasoning: true }];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} live />);
    });

    // Collapsed: the status line previews the streaming summary, exactly once,
    // with no row rendered yet.
    expect(container.textContent).toContain(summary);
    expect(container.textContent?.split(summary).length).toBe(2);
    expect(container.querySelectorAll('[data-testid="work-record-reasoning"]')).toHaveLength(0);

    act(() => {
      container.querySelector("button")?.click();
    });

    // Expanded: the header steps back to the generic label and the full
    // Markdown row is the single copy of the summary.
    expect(container.querySelectorAll('[data-testid="work-record-reasoning"]')).toHaveLength(1);
    expect(container.textContent).toContain(summary);
    expect(container.textContent?.split(summary).length).toBe(2);
  });

  it("renders nothing for a plain reply with no record entries", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Here is the answer." },
      { kind: "progress", text: "On it, one moment." },
    ];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} live />);
    });

    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows current state and expands/collapses", () => {
    const blocks: MessageBlock[] = [
      {
        kind: "progress",
        text: "Checking status",
        activity: true,
      },
    ];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} live />);
    });

    expect(container.textContent).toContain("Checking status");
    expect(container.textContent).toContain("...");
    expect(container.textContent).not.toContain("running");

    const button = container.querySelector("button");
    act(() => {
      button?.click();
    });

    expect(container.textContent).toContain("running");

    act(() => {
      button?.click();
    });

    expect(container.textContent).not.toContain("running");
  });

  it("treats durable steps without a duration as complete, not running", () => {
    const blocks: MessageBlock[] = [{ kind: "steps", steps: [{ label: "Browser", count: 1 }] }];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} />);
    });

    expect(container.textContent).toContain("Browser (1)");
    expect(container.textContent).not.toContain("...");
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
  });

  it("preserves focus when expanded via keyboard", () => {
    const blocks: MessageBlock[] = [
      {
        kind: "progress",
        text: "Checking status",
        activity: true,
      },
    ];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} live />);
    });

    const button = container.querySelector("button")!;
    button.focus();
    expect(document.activeElement).toBe(button);

    // No need to test Enter specifically since the button element handles Enter natively for clicks.
    // We just test that expanding doesn't drop focus.
    act(() => {
      button.click();
    });

    expect(container.textContent).toContain("running");
    expect(document.activeElement).toBe(button);
  });

  it("shows reduced motion styles", () => {
    const blocks: MessageBlock[] = [
      {
        kind: "progress",
        text: "Checking status",
        activity: true,
      },
    ];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} live />);
    });

    // Check for the motion-safe:animate-pulse
    const pulseElement = container.querySelector(".motion-safe\\:animate-pulse");
    expect(pulseElement).not.toBeNull();
  });
});
