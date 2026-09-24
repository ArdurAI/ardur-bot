// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ foreground: "black", mutedForeground: "gray", destructive: "red" }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
}));

import { HostComputerStatus } from "../components/host-computer-status";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("exposes the host status and folders on mobile without mutation controls", () => {
  // Resolve fixtures from this test so package and repository runs use the same files.
  const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(mobileRoot, "components/host-computer-status.tsx"), "utf8");
  expect(source).toContain('"host/status"');
  expect(source).toContain("status.roots.map");
  expect(source).not.toMatch(
    /host\/disconnect|\.setup\(|\.removeRoot\(|\.addRoot\(|Pressable|Button/,
  );
  expect(readFileSync(path.join(mobileRoot, "app/account.tsx"), "utf8")).toContain(
    "<HostComputerStatus />",
  );
});

it.each([true, false])(
  "renders inventory and diagnostics only for a connected host (%s), with no controls",
  async (connected) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const diagnostic =
      "Your login shell profile failed to load (zsh, exit 1); commands run with a default PATH";
    request.mockResolvedValue({
      configured: true,
      connected,
      roots: ["/fixture/projects"],
      health: {
        claude: {},
        codex: {},
        environment: { tools: [{ name: "gh" }, { name: "kubectl" }], diagnostic },
      },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(HostComputerStatus)));
      expect(container.textContent).toContain("/fixture/projects");
      expect(container.textContent?.includes("Tools: gh, kubectl")).toBe(connected);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        connected ? diagnostic : undefined,
      );
      expect(container.querySelector("button, input")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
