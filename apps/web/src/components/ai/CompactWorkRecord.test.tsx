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

  it("keeps reasoning summaries out of the record", () => {
    // Reasoning narration is rendered once, in full, by the message bubble;
    // the compact record must not repeat it as a truncated line.
    const blocks: MessageBlock[] = [
      {
        kind: "progress",
        text: "Thinking through the options before answering",
      },
    ];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} />);
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
      root.render(<CompactWorkRecord blocks={blocks} />);
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

  it("preserves focus when expanded via keyboard", () => {
    const blocks: MessageBlock[] = [
      {
        kind: "progress",
        text: "Checking status",
        activity: true,
      },
    ];

    act(() => {
      root.render(<CompactWorkRecord blocks={blocks} />);
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
      root.render(<CompactWorkRecord blocks={blocks} />);
    });

    // Check for the motion-safe:animate-pulse
    const pulseElement = container.querySelector(".motion-safe\\:animate-pulse");
    expect(pulseElement).not.toBeNull();
  });
});
