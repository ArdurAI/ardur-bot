// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RuntimeReliability } from "../components/runtime-reliability";
import { rpc } from "./api";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => {
  const t = (text: string, values: Record<string, string | number> = {}) =>
    Object.entries(values).reduce(
      (out, [key, value]) => out.replaceAll(`{${key}}`, String(value)),
      text,
    );
  return { t, dateLocaleForUi: () => "en-US", useI18n: () => ({ t, locale: "en" }) };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, children),
}));
it("reveals read-only reliability without setup, preserves null measurements and translated cause", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockResolvedValue({
    runtimes: [
      {
        runtimeKind: "pi",
        completed: 2,
        failed: 1,
        cancelled: 1,
        successRate: 2 / 3,
        firstReplyMedianMs: 2500,
        measuredRuns: 2,
        lastFailure: { category: "usage-limit" },
      },
      {
        runtimeKind: "codex-app-server",
        completed: 0,
        failed: 0,
        cancelled: 1,
        successRate: null,
        firstReplyMedianMs: null,
        measuredRuns: 0,
        lastFailure: null,
      },
    ],
  });
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () => root.render(createElement(RuntimeReliability)));
    expect(rpc).not.toHaveBeenCalled();
    await act(async () => node.querySelector("button")!.click());
    expect(rpc).toHaveBeenCalledExactlyOnceWith("runtimes/reliability");
    expect(node.textContent).toContain("67%");
    expect(node.textContent).toContain("2 measured runs");
    expect(node.textContent).toContain("Ardur's usage limit is reached");
    expect(node.textContent).toContain("Not measured");
    expect(node.textContent).not.toContain("0%");
    await act(async () => node.querySelector("button")!.click());
    expect(node.textContent).toBe("Last 7 days");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
