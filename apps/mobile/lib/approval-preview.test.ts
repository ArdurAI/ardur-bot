// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApprovalPreview } from "../components/ApprovalPreview";
import { AskActions } from "../components/AskActions";

vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, numberOfLines }: { children: ReactNode; numberOfLines?: number }) =>
    createElement("span", { "data-lines": numberOfLines }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityState?: { expanded?: boolean };
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-expanded": accessibilityState?.expanded },
      children,
    ),
  Alert: { alert: vi.fn() },
}));

it("shows every command argument and context, supports collapse, and preserves the approval action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = `'gh' 'issue' 'create' '--body' '${"x".repeat(6000)} **tail** <b>literal</b>'`;
  const detail = "Identity: fixture-account\nWorking directory: '/workspace'\n[redacted]";
  const node = document.createElement("div");
  const root = createRoot(node);
  const onAnswer = vi.fn(async () => undefined);
  try {
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement(ApprovalPreview, { text, detail }),
          createElement(AskActions, {
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
            onAnswer,
          }),
        ),
      ),
    );
    expect(node.textContent).toContain(`${text}\n${detail}`);
    expect(node.querySelector("b, [data-lines]")).toBeNull();
    const toggle = node.querySelector("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle.click());
    expect(node.textContent).not.toContain(text);
    await act(async () => toggle.click());
    expect(node.textContent).toContain(`${text}\n${detail}`);
    await act(async () => node.querySelectorAll("button")[1]!.click());
    expect(onAnswer).toHaveBeenCalledWith("allow");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
