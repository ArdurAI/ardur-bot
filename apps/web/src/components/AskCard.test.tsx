// @vitest-environment jsdom
import { MessageBlock } from "@ardurbot/contracts";
import { selectedAskActionLabel } from "@ardurbot/core";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AskCard } from "./AskCard";

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@ardurbot/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div data-markdown>{children}</div>,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  Input: () => null,
}));

it("renders the entire command literally in an expandable block and answers the bound card", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = `'gh' 'issue' 'create' '--body' '${"x".repeat(6000)} <a href="https://example.test">**tail**</a> $(false)'`;
  const detail = "Identity: fixture-account\nWorking directory: '/workspace'\n[redacted]";
  const block = MessageBlock.parse({
    kind: "ask",
    approvalEffectId: "effect",
    text,
    detail,
    preformatted: true,
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
  if (block.kind !== "ask") throw new Error("Expected an approval");
  const node = document.createElement("div");
  const root = createRoot(node);
  const answer = vi.fn(async () => undefined);
  try {
    await act(async () => root.render(<AskCard block={block} canAnswer onAnswer={answer} />));
    expect(node.querySelector("details")?.open).toBe(true);
    expect(node.querySelector("pre")?.textContent).toBe(`${text}\n${detail}`);
    expect(node.querySelector("a, [data-markdown]")).toBeNull();
    node.querySelector("details")!.open = false;
    node.querySelector("details")!.open = true;
    expect(node.querySelector("pre")?.textContent).toBe(`${text}\n${detail}`);
    await act(async () => node.querySelector("button")!.click());
    expect(answer).toHaveBeenCalledWith("allow");
    expect(node.textContent).not.toContain("Always allow");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});
