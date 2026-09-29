// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{value === 1 ? one.replace("#", "1") : other.replace("#", String(value))}</>
  ),
}));

import type { CoordinationBlock } from "@ardurbot/core";
import { CoordinationLine } from "./CoordinationLine";

function block(patch: Partial<CoordinationBlock> = {}): CoordinationBlock {
  return {
    kind: "coordination",
    nonce: "group-ask:1:run:call-1",
    round: 1,
    text: "Say hello to your teammates.",
    updates: [],
    members: [
      { botId: "radiant", name: "Radiant", outcome: "answered" },
      { botId: "test", name: "test", outcome: "answered" },
      { botId: "zai", name: "zai-bot", outcome: "answered" },
    ],
    ...patch,
  };
}

describe("CoordinationLine", () => {
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

  it("collapses a finished round to one line with the counts", () => {
    act(() => {
      root.render(<CoordinationLine block={block()} />);
    });

    const line = container.querySelector('[data-testid="coordination-line"]')!;
    expect(line).toBeTruthy();
    const summary = container.querySelector('[data-testid="coordination-line-summary"]')!;
    expect(summary.textContent).toContain("Asked 3 bots");
    expect(summary.textContent).toContain("3 answered");
    // Collapsed: no request text or member rows render.
    expect(container.querySelector('[data-testid="coordination-request"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="coordination-member"]')).toHaveLength(0);
    // One visual line: a single summary row inside the line.
    expect(line.querySelectorAll('[data-testid="coordination-line-summary"]')).toHaveLength(1);
  });

  it("expands to show the request and each member's outcome", () => {
    act(() => {
      root.render(<CoordinationLine block={block()} />);
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="coordination-line-toggle"]')!
        .click();
    });

    expect(container.querySelector('[data-testid="coordination-request"]')?.textContent).toBe(
      "Say hello to your teammates.",
    );
    const members = [...container.querySelectorAll('[data-testid="coordination-member"]')];
    expect(members).toHaveLength(3);
    expect(members[0]?.textContent).toContain("Radiant");
    expect(members[0]?.textContent).toContain("answered");
  });

  it("shows one plain failure line with a fix link for a member that could not answer", () => {
    const onOpenMemberSettings = vi.fn();
    act(() => {
      root.render(
        <CoordinationLine
          block={block({
            members: [
              { botId: "radiant", name: "Radiant", outcome: "answered" },
              {
                botId: "zai",
                name: "zai-bot",
                outcome: "failed",
                reasonCode: "auth",
              },
            ],
          })}
          onOpenMemberSettings={onOpenMemberSettings}
        />,
      );
    });

    const failure = container.querySelector('[data-testid="coordination-failure"]')!;
    expect(failure.textContent).toContain("couldn't answer: its model account needs attention");
    const fix = [...failure.querySelectorAll("button")].find((b) => b.textContent === "Fix");
    expect(fix).toBeTruthy();
    act(() => {
      fix!.click();
    });
    expect(onOpenMemberSettings).toHaveBeenCalledWith("zai");
    // Exactly one failure line, and the counts still lead.
    expect(container.querySelectorAll('[data-testid="coordination-failure"]')).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="coordination-line-summary"]')!.textContent,
    ).toContain("Asked 2 bots");
  });

  it("shows no fix link when the failure code is not owner-fixable", () => {
    act(() => {
      root.render(
        <CoordinationLine
          block={block({
            members: [
              {
                botId: "zai",
                name: "zai-bot",
                outcome: "failed",
                reasonCode: "other",
              },
            ],
          })}
        />,
      );
    });
    const failure = container.querySelector('[data-testid="coordination-failure"]')!;
    expect(failure.textContent).toContain("zai-bot couldn't answer");
    expect(failure.querySelector("button")).toBeNull();
  });

  it("offers the fix link for a rate-limited member from the code alone", () => {
    act(() => {
      root.render(
        <CoordinationLine
          block={block({
            members: [
              {
                botId: "zai",
                name: "zai-bot",
                outcome: "failed",
                reasonCode: "rate-limit",
              },
            ],
          })}
        />,
      );
    });
    const failure = container.querySelector('[data-testid="coordination-failure"]')!;
    expect(failure.textContent).toContain("hit a rate limit");
    expect([...failure.querySelectorAll("button")].some((b) => b.textContent === "Fix")).toBe(true);
  });

  it("reads a round stored with an old English reason as its code", () => {
    act(() => {
      root.render(
        <CoordinationLine
          block={block({
            members: [
              {
                botId: "zai",
                name: "zai-bot",
                outcome: "failed",
                reason: "zai-bot couldn't answer: its model is unavailable",
              },
            ],
          })}
        />,
      );
    });
    const failure = container.querySelector('[data-testid="coordination-failure"]')!;
    expect(failure.textContent).toContain("zai-bot couldn't answer: its model is unavailable");
    expect([...failure.querySelectorAll("button")].some((b) => b.textContent === "Fix")).toBe(true);
  });
});
