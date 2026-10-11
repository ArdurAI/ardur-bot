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
}));
vi.mock("../lib/rpc", () => ({ rpc: { goals: decisions } }));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: () => null,
  NativeSelect: () => null,
  NativeSelectOption: () => null,
  BotAvatar: () => null,
}));
vi.mock("./group-model-control", () => ({ GroupModelControl: () => null }));

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
