// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { IntegrationCatalog } from "../components/integration-catalog";
import { rpc } from "./api";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key) => values?.[key] ?? ""),
  }),
}));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (make: () => unknown) => make() }));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityRole: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, role: accessibilityRole },
      children,
    ),
  StyleSheet: { create: (value: unknown) => value },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Linking: { openURL: vi.fn() },
}));

it("renders host and expired sign-in states with web management links and no grant mutations", async () => {
  const catalog = {
    catalog: [
      {
        id: "github",
        name: "GitHub",
        vendor: "github",
        available: true,
        transport: "remote-http",
        authKind: "token",
        endpoint: "https://example.test/mcp",
        docsUrl: "https://example.test/docs",
        requiredInputs: [],
        verifiedAt: "2026-09-24",
        serverVersion: null,
        placement: "backend",
        riskClass: "collaboration",
        defaultAllowedTools: [],
        toolPolicies: {},
      },
    ],
    connections: [
      {
        id: "connection",
        catalogId: "github",
        state: "not-connected",
        manifest: null,
        needsReview: false,
        spaceToolPolicies: {},
        lastError: "Sign-in timed out.",
      },
    ],
    hostSignIns: [
      {
        id: "github",
        command: "gh",
        state: "signed-in",
        identity: "test-account",
        workspace: null,
        checkedAt: "2026-09-24T00:00:00.000Z",
      },
    ],
    webUrl: "https://app.example.test/",
  };
  vi.mocked(rpc).mockImplementation(async (path) => (path === "mcp/servers/list" ? [] : catalog));
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(IntegrationCatalog)));
  expect(node.textContent).toContain("Sign-in timed out.");
  expect(node.textContent).toContain("Signed in on this computer as test-account");
  expect(node.textContent).toContain("Connect on web");
  expect(node.querySelectorAll("input,select,textarea")).toHaveLength(0);
  expect(
    vi
      .mocked(rpc)
      .mock.calls.map(([path]) => path)
      .sort(),
  ).toEqual(["integrations/list", "mcp/servers/list"]);
  await act(async () => root.unmount());
});

it("translates new status, identity and subscription instructions in both mobile catalogs", () => {
  for (const messages of [RU_MESSAGES, ZH_MESSAGES])
    for (const key of [
      "Sign-in timed out.",
      "Needs sign-in",
      "Not found on this computer",
      "Needs sign-in on this computer",
      "Signed in on this computer as {identity}",
      "Last successful call",
      "To use your Claude subscription, choose Runs on → Claude Code in a bot's settings.",
      "Open bot settings",
    ])
      expect(messages[key]).toBeTruthy();
});
