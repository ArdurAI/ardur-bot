// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OverviewScreen from "../app/overview";
import { rpc } from "./api";
import { loadOverviewConnections, loadOverviewNow, loadOverviewUsage } from "./overview";

vi.mock("./api", () => ({
  rpc: vi.fn(async (procedure: string) =>
    procedure === "board/filingOutcomes"
      ? {
          bots: [{ botId: "bot", name: "Helper", filed: 3, done: 1, open: 1, other: 1 }],
        }
      : { workspace: null, ready: 0, inProgress: 0, blocked: 0, items: [] },
  ),
}));
vi.mock("./overview", () => ({
  loadOverviewConnections: vi.fn(),
  loadOverviewNow: vi.fn(),
  loadOverviewUsage: vi.fn(),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? key)),
  }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), setParams: vi.fn() }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  AppState: { currentState: "active" },
  ActivityIndicator: () => createElement("span", { "data-loading": true }),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, title),
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const usage = {
  inputTokens: 0,
  outputTokens: 0,
  runs: 0,
  dayStart: "2026-09-24T00:00:00Z",
  weekStart: "2026-09-21T00:00:00Z",
  asOf: "2026-09-24T12:00:00Z",
  providers: [],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(loadOverviewNow).mockResolvedValue({ rows: [], runs: [], approvals: [] });
  vi.mocked(loadOverviewConnections).mockResolvedValue([]);
  vi.mocked(loadOverviewUsage).mockResolvedValue(usage);
  node = document.createElement("div");
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("renders the three read-only Overview panels and their empty states", async () => {
  await act(async () => root.render(createElement(OverviewScreen)));
  for (const text of [
    "Now",
    "Connections",
    "Usage",
    "Nothing running",
    "No connections",
    "No usage",
  ])
    expect(node.textContent).toContain(text);
  expect(node.textContent).not.toContain("Allow once");
  expect(node.textContent).toContain(
    "Helper filed 3: 1 done, 1 open, 1 closed without being completed.",
  );
  expect(node.textContent).not.toContain("closed otherwise");
});
it("keeps loading and error recovery independent without exposing approval or settings actions", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(loadOverviewNow).mockImplementationOnce(
    () =>
      new Promise((_yes, no) => {
        reject = no;
      }),
  );
  vi.mocked(loadOverviewConnections).mockResolvedValue([
    { id: "connection", name: "Calendar", kind: "integration", state: "needs-sign-in" },
  ]);
  await act(async () => root.render(createElement(OverviewScreen)));
  expect(node.querySelector("[data-loading]")).not.toBeNull();
  expect(node.textContent).toContain("Calendar · Needs sign-in");
  await act(async () => reject(new Error("offline fixture")));
  expect(node.textContent).toContain("Could not load");
  expect([...node.querySelectorAll("button")].map((button) => button.textContent)).toContain(
    "Retry",
  );
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click(),
  );
  expect(node.textContent).toContain("Nothing running");
  expect(node.textContent).not.toContain("Could not load");
});
it("shows recorded provider periods and never substitutes a price for unknown cost", async () => {
  const period = { records: 3, inputTokens: 30, outputTokens: 12, cost: null };
  vi.mocked(loadOverviewUsage).mockResolvedValue({
    ...usage,
    providers: [{ provider: "Local provider", today: period, week: period, daily: [] }],
  });
  await act(async () => root.render(createElement(OverviewScreen)));
  expect(node.textContent).toContain("Local provider");
  expect(node.textContent).toContain("Today (UTC)");
  expect(node.textContent).toContain("3 usage records · 42 tokens");
  expect(node.textContent).not.toContain("Cost:");
  expect(node.textContent).not.toContain("Allow once");
});

it("renders every pending approval per run in read-only form", async () => {
  vi.mocked(loadOverviewNow).mockResolvedValue({
    rows: [],
    runs: ["older", "newer"].map((runId) => ({
      runId,
      botId: "bot",
      botName: "Reviewer",
      threadId: "thread",
      groupId: null,
      groupName: null,
      status: "waiting_input",
      trigger: "user",
      notificationsEnabled: false,
      promptSnippet: `Review ${runId}`,
      updatedAt: "2026-09-24T00:00:00Z",
    })),
    approvals: ["older", "newer"].map((runId) => ({
      runId,
      messageId: `message-${runId}`,
      block: {
        kind: "ask",
        status: "pending",
        text: `Approve ${runId}?`,
        approvalEffectId: `effect-${runId}`,
      },
    })),
  });
  await act(async () => root.render(createElement(OverviewScreen)));
  expect(node.textContent).toContain("Approve older?");
  expect(node.textContent).toContain("Approve newer?");
  expect(node.textContent?.match(/Waiting for your approval/g)).toHaveLength(2);
  expect(node.textContent).not.toContain("Allow once");
});
it.each(["needs-sign-in", "not-connected"])(
  "renders canonical %s integrations as needing sign-in",
  async (state) => {
    vi.mocked(loadOverviewConnections).mockResolvedValue(
      connectionOverview({
        integrations: {
          catalog: [],
          connections: [{ id: "calendar", catalogId: "Calendar", state }],
        } as unknown as IntegrationCatalogList,
        servers: [{ id: "calendar", name: "Calendar", enabled: true, oauthStatus: "reconnect" }],
        devices: [],
        channels: [],
      }),
    );
    await act(async () => root.render(createElement(OverviewScreen)));
    expect(node.textContent).toContain("Calendar · Needs sign-in");
  },
);
it("shows the work list and leaves the counts out when filing outcomes fail", async () => {
  const original = vi.mocked(rpc).getMockImplementation()!;
  vi.mocked(rpc).mockImplementation(async (procedure: string, input?: unknown) => {
    if (procedure === "board/filingOutcomes") throw new Error("outcomes unavailable");
    if (procedure === "board/work")
      return {
        workspace: {
          id: "workspace",
          kind: "space",
          path: "",
          prefix: "work",
          name: "Work",
          enabled: true,
          initialized: true,
          isDefault: true,
          allowAllBots: true,
          allowedBotIds: [],
        },
        ready: 2,
        inProgress: 0,
        blocked: 0,
        items: [
          {
            id: "work-1",
            title: "Ready work",
            description: "",
            acceptanceCriteria: "",
            type: "task",
            status: "open",
            priority: 2,
            assignee: null,
            labels: [],
            parent: null,
            dependencies: [],
            dueAt: null,
            deferUntil: null,
            estimateMinutes: null,
            externalRef: null,
            createdAt: "2026-09-25T12:00:00.000Z",
            updatedAt: "2026-09-25T12:00:00.000Z",
            closedAt: null,
            commentCount: 0,
            comments: [],
            history: [],
            closeWhenDone: false,
          },
        ],
      };
    return original(procedure, input);
  });
  try {
    await act(async () => root.render(createElement(OverviewScreen)));
    expect(node.textContent).not.toContain("Board outcomes");
    expect(node.textContent).not.toContain("closed without being completed");
    expect(node.textContent).toContain("Ready work");
    expect(node.textContent).toContain("Ready: 2");
    expect(node.textContent).not.toContain("Could not load");
  } finally {
    vi.mocked(rpc).mockImplementation(original);
  }
});
it("renders the Work summary from a server that has no filing outcomes", async () => {
  const original = vi.mocked(rpc).getMockImplementation()!;
  vi.mocked(rpc).mockImplementation(async (procedure: string, input?: unknown) => {
    if (procedure === "board/filingOutcomes") throw new Error("NOT_FOUND");
    return original(procedure, input);
  });
  try {
    await act(async () => root.render(createElement(OverviewScreen)));
    expect(node.textContent).toContain("Ready: 0 · In progress: 0 · Blocked: 0");
    expect(node.textContent).not.toContain("filed");
    expect(node.textContent).not.toContain("Could not load");
  } finally {
    vi.mocked(rpc).mockImplementation(original);
  }
});
it("identifies totals-only usage as records on mobile", async () => {
  const period = { records: 1, requests: 1, inputTokens: 20, outputTokens: 5, cost: null };
  vi.mocked(loadOverviewUsage).mockResolvedValue({
    ...usage,
    providers: [{ provider: "Aggregate collector", today: period, week: period, daily: [] }],
  });
  await act(async () => root.render(createElement(OverviewScreen)));
  expect(node.textContent).toContain("1 usage records · 25 tokens");
  expect(node.textContent).not.toContain("requests");
});

import type { IntegrationCatalogList } from "@ardurbot/contracts";
import { connectionOverview } from "@ardurbot/core";
