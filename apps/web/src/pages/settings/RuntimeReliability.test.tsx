// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { RuntimeReliability } from "./RuntimeReliability";

vi.mock("../../lib/rpc", () => ({ rpc: { runtimes: { reliability: vi.fn() } } }));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join("") }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray) => parts.join(""),
    i18n: {
      locale: "en",
      _: ({ id, values }: { id: string; values: Record<string, string> }) =>
        Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, value),
          id,
        ),
    },
  }),
}));
const report = {
  from: "2030-01-01T00:00:00Z",
  asOf: "2030-01-08T00:00:00Z",
  runtimes: [
    {
      runtimeKind: "pi" as const,
      completed: 2,
      failed: 1,
      cancelled: 1,
      successRate: 2 / 3,
      firstReplyMedianMs: 2500,
      measuredRuns: 2,
      lastFailure: { category: "usage-limit" as const, at: "2030-01-08T00:00:00Z" },
    },
    {
      runtimeKind: "codex-app-server" as const,
      completed: 0,
      failed: 0,
      cancelled: 1,
      successRate: null,
      firstReplyMedianMs: null,
      measuredRuns: 0,
      lastFailure: null,
    },
  ],
};
it("loads only expanded recorded outcomes and leaves textless cancellations unmeasured", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.runtimes.reliability).mockResolvedValue(report);
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () => root.render(createElement(RuntimeReliability)));
    expect(rpc.runtimes.reliability).not.toHaveBeenCalled();
    await act(async () => {
      node.querySelector("details")!.open = true;
      node.querySelector("details")!.dispatchEvent(new Event("toggle"));
    });
    expect(rpc.runtimes.reliability).toHaveBeenCalledOnce();
    expect(node.textContent).toContain("67%");
    expect(node.textContent).toContain("2 measured runs");
    expect(node.textContent).toContain("Ardur's usage limit is reached");
    expect(node.querySelector('section[aria-label="Codex"]')?.textContent).toContain(
      "Not measured",
    );
    expect(node.querySelector('section[aria-label="Codex"]')?.textContent).not.toContain("0%");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
it("does not display a late response after details close", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish!: (value: typeof report) => void;
  vi.mocked(rpc.runtimes.reliability).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () => root.render(createElement(RuntimeReliability)));
    await act(async () => {
      node.querySelector("details")!.open = true;
      node.querySelector("details")!.dispatchEvent(new Event("toggle"));
    });
    await act(async () => {
      node.querySelector("details")!.open = false;
      node.querySelector("details")!.dispatchEvent(new Event("toggle"));
    });
    await act(async () => finish(report));
    expect(node.textContent).not.toContain("67%");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
