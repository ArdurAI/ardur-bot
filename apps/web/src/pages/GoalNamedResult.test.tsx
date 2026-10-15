// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const revision = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({
  rpc: { goals: { revision, get: vi.fn(), stop: vi.fn() } },
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Input: () => null,
  NativeSelect: () => null,
  NativeSelectOption: () => null,
  BotAvatar: () => null,
}));
vi.mock("./group-model-control", () => ({ GroupModelControl: () => null }));

import { GoalNamedResult } from "./GoalNamedResult";

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  revision.mockReset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

it("shows the revision a result link names, not the newest result", async () => {
  revision.mockResolvedValue({
    // A link naming the revision the goal is on now resolves as current.
    current: true,
    goal: {
      id: "goal-old",
      groupId: "group-1",
      status: "running",
      tokenLimit: 600,
      untilAt: "2030-01-01T00:00:00.000Z",
      usedTokens: 1,
      usageComplete: true,
      currentRevision: {
        id: "rev-old",
        summary: "Recorded result",
        conditions: [],
      },
    },
  });
  await act(async () => {
    root.render(<GoalNamedResult groupId="group-1" goalId="goal-old" revisionId="rev-old" />);
  });
  expect(revision).toHaveBeenCalledWith({
    groupId: "group-1",
    goalId: "goal-old",
    revisionId: "rev-old",
  });
  expect(node.textContent).toContain("Recorded result");
  expect(node.textContent).toContain("Review result");
  expect(node.textContent).not.toContain("Newest result");
  expect(node.textContent).not.toContain("Accept result");
});

it("falls back to the live goal strip when the named result link is stale", async () => {
  revision.mockResolvedValue(null);
  await act(async () => {
    root.render(
      <GoalNamedResult
        groupId="group-1"
        goalId="goal-old"
        revisionId="rev-old"
        fallback={<p>Live goal strip</p>}
      />,
    );
  });
  expect(node.textContent).toContain("Live goal strip");
});

it("falls back to the live goal strip when the named revision is historical", async () => {
  // The server answers with the requested historical revision in
  // currentRevision and reports freshness separately as current: false.
  revision.mockResolvedValue({
    current: false,
    goal: {
      id: "goal-1",
      groupId: "group-1",
      status: "completed",
      tokenLimit: 600,
      untilAt: "2030-01-01T00:00:00.000Z",
      usedTokens: 1,
      usageComplete: true,
      currentRevision: { id: "rev-old", summary: "Recorded result", conditions: [] },
    },
  });
  await act(async () => {
    root.render(
      <GoalNamedResult
        groupId="group-1"
        goalId="goal-1"
        revisionId="rev-old"
        fallback={<p>Live goal strip</p>}
      />,
    );
  });
  expect(node.textContent).toContain("Live goal strip");
  expect(node.textContent).not.toContain("Recorded result");
});
