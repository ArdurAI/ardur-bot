// @vitest-environment jsdom
import type { RunActivityRow, TeamRow } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ActivityList } from "./ActivityList";

const calls = vi.hoisted(() => ({
  list: vi.fn(),
  board: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { runs: { list: calls.list }, team: { board: calls.board } },
}));
vi.mock("../lib/run-status-label", () => ({ statusLabel: (status: string) => status }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/core", () => ({ i18n: { locale: "en" } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { id: string }) =>
      "id" in parts ? parts.id : parts.join(""),
  }),
}));

const makeRun = (
  runId: string,
  status: RunActivityRow["status"],
  promptSnippet: string,
): RunActivityRow => ({
  runId,
  botId: "worker",
  botName: "Worker",
  groupId: null,
  groupName: null,
  threadId: "desk",
  status,
  trigger: "follow_up",
  notificationsEnabled: true,
  promptSnippet,
  updatedAt: "2026-09-28T12:00:00.000Z",
});

it("keeps each run's task and completed outcome when the bot starts new work", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.list.mockImplementation(async ({ filter }: { filter: string }) => ({
    runs:
      filter === "active"
        ? [makeRun("current", "running", "Draft documentation")]
        : [makeRun("earlier", "completed", "Review release")],
  }));
  calls.board.mockResolvedValue({
    rows: [
      {
        botId: "worker",
        currentTaskTitle: "Draft documentation",
        availability: "unavailable",
        observedAt: "2026-09-28T11:00:00.000Z",
        latestDeliveryState: "read",
      } as TeamRow,
    ],
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ActivityList, { onOpenRun: vi.fn() })));
    const rows = [...node.querySelectorAll("button")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Draft documentation");
    expect(rows[1]?.textContent).toContain("Review release");
    expect(rows[1]?.textContent).toContain("completed");
    expect(rows[1]?.textContent).not.toContain("Status unavailable");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["waiting_input", "waiting_takeover"] as const)(
  "keeps %s visible when presence is unavailable",
  async (status) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    calls.list.mockImplementation(async ({ filter }: { filter: string }) => ({
      runs: filter === "active" ? [makeRun("waiting", status, "Owner decision")] : [],
    }));
    calls.board.mockResolvedValue({
      rows: [
        { botId: "worker", availability: "unavailable", observedAt: new Date().toISOString() },
      ],
    });
    const node = document.createElement("div");
    const root = createRoot(node);
    try {
      await act(async () => root.render(createElement(ActivityList, { onOpenRun: vi.fn() })));
      expect(node.textContent).toContain(status);
      expect(node.textContent).not.toContain("Status unavailable");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
