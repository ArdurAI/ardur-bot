// @vitest-environment jsdom
import type { Goal } from "@ardurbot/contracts";
import { GOAL_FINAL_REVIEW_DESCRIPTION } from "@ardurbot/contracts";
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const decisions = vi.hoisted(() => ({
  accept: vi.fn(),
  reject: vi.fn(),
  reviewCondition: vi.fn(),
  revision: vi.fn(),
  boardDelivery: vi.fn(),
}));
const supportCalls = vi.hoisted(() => ({
  runSummary: vi.fn(),
  record: vi.fn(),
  artifactGet: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    goals: decisions,
    evidence: { runSummary: supportCalls.runSummary, record: supportCalls.record },
    artifacts: { get: supportCalls.artifactGet },
  },
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (descriptor: { id: string }) => descriptor.id } }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Input: () => null,
  NativeSelect: () => null,
  NativeSelectOption: () => null,
  BotAvatar: () => null,
}));
vi.mock("./group-model-control", () => ({ GroupModelControl: () => null }));

import { GoalNamedResult } from "./GoalNamedResult";
import { GroupGoalStrip } from "./GroupPanel";

const goal = {
  id: "goal-1",
  groupId: "group-1",
  status: "completed",
  tokenLimit: 600,
  untilAt: "2030-01-01T00:00:00.000Z",
  currentRevision: {
    id: "revision-1",
    summary: "Candidate",
    conditions: [
      { id: "cond-final", description: GOAL_FINAL_REVIEW_DESCRIPTION, status: "unknown" },
    ],
  },
} as Goal;
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (name: string) =>
  [...node.querySelectorAll("button")].find((item) => item.textContent === name)!;
async function typeNotes(value: string) {
  const field = node.querySelector("textarea");
  if (!field) throw new Error("missing rework notes");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  decisions.accept.mockResolvedValue({});
  decisions.reject.mockResolvedValue({});
  decisions.reviewCondition.mockResolvedValue({});
  decisions.boardDelivery.mockResolvedValue({});
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

it.each(["accept", "reject"] as const)(
  "refreshes and disables repeat clicks while %s is pending",
  async (action) => {
    let finish!: () => void;
    decisions[action].mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onRefresh = vi.fn(async () =>
      root.render(
        <GroupGoalStrip
          goal={{ ...goal, status: action === "accept" ? "accepted" : "running" }}
          onStop={vi.fn()}
          onRefresh={onRefresh}
        />,
      ),
    );
    await act(async () =>
      root.render(<GroupGoalStrip goal={goal} onStop={vi.fn()} onRefresh={onRefresh} />),
    );
    expect(node.textContent).toContain("Final owner review");
    expect(node.textContent).not.toContain(GOAL_FINAL_REVIEW_DESCRIPTION);
    if (action === "reject") await typeNotes("Fix the summary");
    await act(async () => {
      button(action === "accept" ? "Accept result" : "Reject result").click();
      button(action === "accept" ? "Accept result" : "Reject result").click();
    });
    expect(decisions[action]).toHaveBeenCalledTimes(1);
    expect(decisions[action]).toHaveBeenCalledWith({
      goalId: goal.id,
      revisionId: goal.currentRevision!.id,
      ...(action === "reject" ? { reworkNotes: "Fix the summary" } : {}),
    });
    expect([...node.querySelectorAll("button")].every((item) => item.disabled)).toBe(true);
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(node.textContent).not.toContain("Accept result");
  },
);

it.each([
  ["accept", "revision-changed", "Result changed; review again.", true],
  ["reject", "revision-changed", "Result changed; review again.", true],
  ["accept", "work-active", "Work is still active.", false],
  ["accept", "lease-active", "Work is still active.", false],
  ["accept", "effects-open", "Effects are still unsettled.", false],
  ["accept", "conditions-open", "Every condition must pass.", false],
  ["reject", null, "Could not review result. Try again.", false],
] as const)("shows a useful error for %s (%s)", async (action, reason, message, refresh) => {
  decisions[action].mockRejectedValue(
    reason ? new ORPCError("CONFLICT", { data: { reason } }) : new Error("private diagnostic"),
  );
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<GroupGoalStrip goal={goal} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  if (action === "reject") await typeNotes("Fix the summary");
  await act(async () => button(action === "accept" ? "Accept result" : "Reject result").click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(node.textContent).not.toContain("private diagnostic");
  expect(onRefresh).toHaveBeenCalledTimes(refresh ? 1 : 0);
  expect(button("Accept result").disabled).toBe(false);
});

it("surfaces a refresh failure after a saved decision", async () => {
  const onRefresh = vi.fn().mockRejectedValue(new Error("read failed"));
  await act(async () =>
    root.render(<GroupGoalStrip goal={goal} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  await act(async () => button("Accept result").click());
  expect(decisions.accept).toHaveBeenCalledTimes(1);
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not review result. Try again.",
  );
  expect(button("Accept result").disabled).toBe(false);
});

it("shows late usage as a discrepancy on an accepted goal", async () => {
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <GroupGoalStrip
        goal={{
          ...goal,
          status: "accepted",
          settlement: {
            revisionId: goal.currentRevision!.id,
            usedTokens: 120,
            reservedTokens: 0,
            lateTokens: 15,
            discrepancyCount: 1,
            createdAt: "2030-01-01T00:00:00.000Z",
          },
        }}
        onStop={vi.fn()}
        onRefresh={onRefresh}
      />,
    ),
  );
  expect(node.textContent).toContain("Late usage arrived after acceptance.");
  expect(node.textContent).toContain("15");
});

it("shows the board link and a pending update", async () => {
  await act(async () =>
    root.render(
      <GroupGoalStrip
        goal={{
          ...goal,
          boardWorkspaceId: "workspace",
          boardItemId: "board-a",
          boardDelivery: "pending",
        }}
        onStop={vi.fn()}
        onRefresh={vi.fn()}
      />,
    ),
  );
  await act(() => vi.dynamicImportSettled());
  expect(node.textContent).toContain("Board item");
  expect(node.textContent).toContain("Open board item");
  expect(node.textContent).toContain("Board update pending");
  expect(node.querySelector("a")?.getAttribute("href")).toBe(
    "/app/board?workspace=workspace&item=board-a",
  );
});

const goalWithSupport = {
  ...goal,
  currentRevision: {
    ...goal.currentRevision!,
    conditions: [
      {
        id: "cond-final",
        description: GOAL_FINAL_REVIEW_DESCRIPTION,
        status: "unknown",
        actorId: null,
        reason: null,
        evidenceId: null,
        createdAt: null,
        support: [{ kind: "run", recordId: "run-1", revision: null }],
        proposedSupport: [{ kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) }],
      },
    ],
  },
} as Goal;

it("sends the checked supporting records with the owner's pass", async () => {
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<GroupGoalStrip goal={goalWithSupport} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  const boxes = [...node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes).toHaveLength(2);
  expect(boxes.map((box) => box.checked)).toEqual([true, false]);
  await act(async () => {
    boxes[1]!.click();
  });
  await act(async () => {
    button("Pass").click();
  });
  expect(decisions.reviewCondition).toHaveBeenCalledWith({
    goalId: goal.id,
    revisionId: goal.currentRevision!.id,
    conditionId: "cond-final",
    status: "pass",
    support: [
      { kind: "run", recordId: "run-1", revision: null },
      { kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) },
    ],
  });
});

it("omits an attested record from the decision when the owner unchecks it", async () => {
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<GroupGoalStrip goal={goalWithSupport} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  const boxes = [...node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  await act(async () => {
    boxes[0]!.click();
    boxes[1]!.click();
  });
  await act(async () => {
    button("Fail").click();
  });
  expect(decisions.reviewCondition).toHaveBeenCalledWith({
    goalId: goal.id,
    revisionId: goal.currentRevision!.id,
    conditionId: "cond-final",
    status: "fail",
    support: [{ kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) }],
  });
});

it("opens an accepted artifact record through the goal's group scope", async () => {
  supportCalls.artifactGet.mockResolvedValue({
    id: "artifact-1",
    botId: "bot-1",
    groupId: "group-1",
    runId: null,
    name: "result.md",
    mimeType: "text/markdown",
    size: 5,
    createdAt: "2030-01-01T00:00:00.000Z",
    contentBase64: btoa("ready"),
  });
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <GroupGoalStrip
        goal={{
          ...goal,
          status: "accepted",
          currentRevision: {
            ...goal.currentRevision!,
            conditions: [
              {
                id: "cond-final",
                description: GOAL_FINAL_REVIEW_DESCRIPTION,
                status: "pass",
                actorId: null,
                reason: null,
                evidenceId: null,
                createdAt: null,
                support: [{ kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) }],
                proposedSupport: [],
              },
            ],
          },
        }}
        onStop={vi.fn()}
        onRefresh={onRefresh}
        recordedResult
      />,
    ),
  );
  await act(async () => button("Artifact artifact…").click());
  expect(supportCalls.artifactGet).toHaveBeenCalledWith({
    groupId: "group-1",
    artifactId: "artifact-1",
  });
  expect(node.textContent).toContain("result.md");
});

it("shows supporting records on a reviewed condition and opens one beside it", async () => {
  supportCalls.runSummary.mockResolvedValue({
    sessionId: "run-1",
    recordedAt: "2030-01-01T00:00:00.000Z",
    decisions: { allowed: 2, denied: 0, asked: 0, recorded: 2 },
    captureLevel: "decisions",
    gates: { spend: null, risks: [] },
    state: "verified",
    sealed: true,
    gapCount: 0,
    failureCodes: [],
  });
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <GroupGoalStrip
        goal={{
          ...goal,
          currentRevision: {
            ...goal.currentRevision!,
            conditions: [
              {
                id: "cond-final",
                description: GOAL_FINAL_REVIEW_DESCRIPTION,
                status: "unknown",
                actorId: null,
                reason: null,
                evidenceId: null,
                createdAt: null,
                support: [{ kind: "run", recordId: "run-1", revision: null }],
                proposedSupport: [
                  { kind: "artifact", recordId: "artifact-1", revision: "a".repeat(64) },
                ],
              },
            ],
          },
        }}
        onStop={vi.fn()}
        onRefresh={onRefresh}
      />,
    ),
  );
  expect(node.textContent).toContain("Run record");
  expect(node.textContent).toContain("Proposed");
  await act(async () => button("Run record run-1…").click());
  expect(supportCalls.runSummary).toHaveBeenCalledWith({ runId: "run-1" });
  expect(node.textContent).toContain("Decisions recorded");
});

it("maps a support conflict to a plain sentence and refreshes nothing", async () => {
  decisions.reviewCondition.mockRejectedValue(
    new ORPCError("CONFLICT", { data: { reason: "stale-record" } }),
  );
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<GroupGoalStrip goal={goal} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  await act(async () => button("Pass").click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(
    "A supporting record is missing or changed; review again.",
  );
  expect(onRefresh).not.toHaveBeenCalled();
});

it("shows the named accepted result and keeps owner decision controls disabled", async () => {
  decisions.revision.mockResolvedValue({
    current: true,
    goal: {
      ...goal,
      status: "accepted",
      currentRevision: { ...goal.currentRevision, summary: "Accepted result" },
    },
  });
  await act(async () =>
    root.render(<GoalNamedResult groupId="group-1" goalId="goal-1" revisionId="revision-1" />),
  );
  expect(decisions.revision).toHaveBeenCalledWith({
    groupId: "group-1",
    goalId: "goal-1",
    revisionId: "revision-1",
  });
  expect(node.textContent).toContain("Accepted result");
  expect(node.querySelector("details")?.open).toBe(true);
  expect(node.textContent).not.toContain("Accept result");
  expect(node.textContent).not.toContain("Reject result");
  expect(node.querySelectorAll("button")).toHaveLength(0);
});

const pausedBoardGoal = {
  ...goal,
  boardWorkspaceId: "workspace",
  boardItemId: "board-a",
  boardDelivery: "paused",
  boardDeliveryActions: [
    { id: "delivery-1", transition: "completed", state: "paused", attempt: 1 },
  ],
} as Goal;

it("lets the owner retry or handle a paused board delivery", async () => {
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<GroupGoalStrip goal={pausedBoardGoal} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  expect(node.textContent).toContain("Retry board update");
  expect(node.textContent).toContain("Mark board update handled");
  await act(async () => button("Retry board update").click());
  expect(decisions.boardDelivery).toHaveBeenCalledWith({
    goalId: goal.id,
    deliveryId: "delivery-1",
    action: "retry",
    attempt: 1,
  });
  expect(onRefresh).toHaveBeenCalledTimes(1);
  await act(async () => button("Mark board update handled").click());
  expect(decisions.boardDelivery).toHaveBeenLastCalledWith({
    goalId: goal.id,
    deliveryId: "delivery-1",
    action: "handle",
    attempt: 1,
  });
  expect(onRefresh).toHaveBeenCalledTimes(2);
});

it.each([
  ["revision-changed", 1],
  ["not-awaiting", 1],
  [null, 0],
] as const)("resolves a board delivery conflict (%s) by refreshing", async (reason, refresh) => {
  decisions.boardDelivery.mockRejectedValue(
    reason ? new ORPCError("CONFLICT", { data: { reason } }) : new Error("private diagnostic"),
  );
  const onRefresh = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<GroupGoalStrip goal={pausedBoardGoal} onStop={vi.fn()} onRefresh={onRefresh} />),
  );
  await act(async () => button("Retry board update").click());
  expect(onRefresh).toHaveBeenCalledTimes(refresh);
  if (reason) expect(node.querySelector('[role="alert"]')).toBeNull();
  else
    expect(node.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not update the board. Try again.",
    );
});
