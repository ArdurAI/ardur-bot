// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RuntimeCapabilityChecks } from "../components/runtime-capability-checks";
import { rpc } from "./api";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, children),
}));
it("loads read-only metadata only after disclosure without probing or connecting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockResolvedValue({
    runtimeKind: "pi",
    adapterId: "fixture",
    adapterVersion: "1",
    runtimeVersion: null,
    checks: [{ behavior: "streaming", declared: true, verdict: "not-tested" }],
    versionMismatch: false,
  });
  const node = document.createElement("div"),
    root = createRoot(node);
  await act(async () => root.render(createElement(RuntimeCapabilityChecks, { kind: "pi" })));
  expect(rpc).not.toHaveBeenCalled();
  await act(async () => node.querySelector("button")!.click());
  expect(rpc).toHaveBeenCalledExactlyOnceWith("runtimes/capabilities", { runtimeKind: "pi" });
  expect(node.textContent).toContain("Declared");
  expect(node.textContent).toContain("Not tested");
  expect(node.textContent).not.toContain("Confirmed offline");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
