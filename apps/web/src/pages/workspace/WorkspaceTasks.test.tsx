// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceTasks } from "./WorkspaceTasks";

const calls = vi.hoisted(() => ({
  tasks: vi.fn(),
  stop: vi.fn(async () => ({})),
  followUp: vi.fn(async () => ({})),
  cancel: vi.fn(async () => ({})),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    workspace: { tasks: calls.tasks },
    threads: { stop: calls.stop, followUp: calls.followUp },
    delegations: { cancel: calls.cancel },
  },
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((value, part, index) => value + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/run-status-label", () => ({ statusLabel: (status: string) => status }));
vi.mock("../ChatTaskReview", () => ({ ChatTaskReview: () => null }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const run = (runId: string, status: string, botId = "bot") => ({
    runId,
    status,
    botId,
    botName: botId,
    threadId: `${runId}-thread`,
    rootTaskId: `${runId}-root`,
    coordinatorThreadId: "coordinator-thread",
    groupId: null,
    groupName: null,
    trigger: "user",
    notificationsEnabled: false,
    promptSnippet: runId,
    updatedAt: "2026-09-28T00:00:00.000Z",
  });
  calls.tasks.mockResolvedValue({
    runs: [
      run("active", "running"),
      run("queued", "queued"),
      run("recent", "completed"),
      run("helper", "running", "helper-bot"),
    ],
    delegations: [
      {
        id: "waiting-helper",
        rootTaskId: "tree-root",
        runId: null,
        status: "queued",
        actingName: "Helper",
      },
    ],
    routines: [{ id: "routine", name: "Tomorrow", nextRunAt: "2026-09-29T00:00:00.000Z" }],
    observedAt: "2026-09-28T00:00:00.000Z",
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("separates queued runs from future routines and applies the correct stop scope", async () => {
  await act(async () => root.render(<WorkspaceTasks botId="bot" visible onOpenRun={() => {}} />));
  expect(container.textContent).toContain("Running");
  expect(container.textContent).toContain("Queued");
  expect(container.textContent).toContain("Delegated");
  expect(container.textContent).toContain("Recent");
  expect(container.textContent).not.toContain("Tomorrow");
  const ownStop = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop work in this conversation",
  );
  await act(async () => ownStop?.click());
  expect(calls.stop).toHaveBeenCalledWith({ threadId: "active-thread" });
  expect(container.textContent).toContain("Stopping");
  const delegatedStop = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Stop delegated work",
  );
  await act(async () => delegatedStop[0]?.click());
  expect(calls.cancel).toHaveBeenCalledWith({ rootTaskId: "helper-root" });
});

it("does not poll while the tab is hidden", async () => {
  await act(async () =>
    root.render(<WorkspaceTasks botId="bot" visible={false} onOpenRun={() => {}} />),
  );
  expect(calls.tasks).not.toHaveBeenCalled();
  await act(async () => root.render(<WorkspaceTasks botId="bot" visible onOpenRun={() => {}} />));
  expect(calls.tasks).toHaveBeenCalledTimes(1);
});
