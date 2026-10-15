// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RpcError } from "../lib/rpc-error";
import { GoalBudgetDetails } from "./goal-budget-details";

const push = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("../lib/api", () => ({ rpc }));
vi.mock("../lib/native", () => ({
  useMobileTokens: () => ({ foreground: "#111", mutedForeground: "#666" }),
}));
vi.mock("react-native", () => {
  const surface =
    (tag: string) =>
    ({
      children,
      onPress,
      accessibilityState,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityState?: { busy?: boolean };
    }) =>
      createElement(tag, { onClick: onPress, "aria-busy": accessibilityState?.busy }, children);
  return {
    View: surface("div"),
    Text: surface("span"),
    Pressable: surface("button"),
  };
});

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  push.mockClear();
  rpc.mockReset();
});

const pausedGoal = {
  id: "goal-1",
  groupId: "group",
  usedTokens: 1,
  reservedTokens: 0,
  availableTokens: 1,
  usageComplete: true,
  boardWorkspaceId: "workspace",
  boardItemId: "board-a",
  boardDelivery: "paused",
  boardDeliveryActions: [
    { id: "delivery-1", transition: "completed", state: "paused", attempt: 1 },
  ],
};

async function renderExpanded() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => {
    root.render(createElement(GoalBudgetDetails, { groupId: "group" }));
  });
  await act(async () => {
    node.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return node;
}

function button(node: HTMLElement, label: string) {
  const found = [...node.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(found).toBeTruthy();
  return found as HTMLButtonElement;
}

it("opens the linked board item", async () => {
  rpc.mockResolvedValue({
    groupId: "group",
    usedTokens: 1,
    reservedTokens: 0,
    availableTokens: 1,
    usageComplete: true,
    boardWorkspaceId: "workspace",
    boardItemId: "board-a",
    boardDelivery: "delivered",
  });
  const node = await renderExpanded();
  const open = button(node, "Open board item");
  await act(async () => {
    open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(push).toHaveBeenCalledWith({
    pathname: "/overview",
    params: { view: "board", workspace: "workspace", item: "board-a" },
  });
});

it("retries a paused board delivery from the goal card", async () => {
  rpc.mockImplementation(async (proc: string) =>
    proc === "goals/boardDelivery" ? pausedGoal : pausedGoal,
  );
  const node = await renderExpanded();
  await act(async () => {
    button(node, "Retry board update").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(rpc).toHaveBeenCalledWith("goals/boardDelivery", {
    goalId: "goal-1",
    deliveryId: "delivery-1",
    action: "retry",
    attempt: 1,
  });
});

it.each(["revision-changed", "not-awaiting"])(
  "refreshes silently when the action hits a %s conflict",
  async (reason) => {
    rpc.mockImplementation(async (proc: string) => {
      if (proc === "goals/boardDelivery")
        throw new RpcError("Board delivery is not awaiting the owner", "CONFLICT", { reason });
      return pausedGoal;
    });
    const node = await renderExpanded();
    await act(async () => {
      button(node, "Retry board update").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(node.textContent).not.toContain("Could not update the board. Try again.");
    // The conflict refresh re-read the goal and keeps the reviewed card.
    expect(rpc).toHaveBeenCalledWith("goals/get", { groupId: "group" });
    expect(button(node, "Retry board update")).toBeTruthy();
  },
);

it("shows an error sentence when the action fails for another reason", async () => {
  rpc.mockImplementation(async (proc: string) => {
    if (proc === "goals/boardDelivery") throw new RpcError("private diagnostic");
    return pausedGoal;
  });
  const node = await renderExpanded();
  await act(async () => {
    button(node, "Retry board update").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(node.textContent).toContain("Could not update the board. Try again.");
  expect(button(node, "Retry board update")).toBeTruthy();
});

it("keeps the card visible when the refresh after a failure also fails", async () => {
  let reads = 0;
  rpc.mockImplementation(async (proc: string) => {
    if (proc === "goals/boardDelivery") throw new RpcError("private diagnostic");
    if (proc === "goals/get") {
      // The poll re-reads on expand; only the post-failure refresh may fail.
      reads += 1;
      if (reads <= 2) return pausedGoal;
      throw new Error("network down");
    }
    return pausedGoal;
  });
  const node = await renderExpanded();
  await act(async () => {
    button(node, "Retry board update").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(node.textContent).toContain("Could not update the board. Try again.");
  expect(button(node, "Retry board update")).toBeTruthy();
  expect(button(node, "Mark board update handled")).toBeTruthy();
});

it("marks only the settling delivery busy for accessibility", async () => {
  const twoRowsGoal = {
    ...pausedGoal,
    boardDeliveryActions: [
      { id: "delivery-1", transition: "completed", state: "paused", attempt: 1 },
      { id: "delivery-2", transition: "accepted", state: "paused", attempt: 3 },
    ],
  };
  let resolveBoard: ((goal: unknown) => void) | undefined;
  rpc.mockImplementation(
    (proc: string) =>
      new Promise((resolve, reject) => {
        if (proc === "goals/boardDelivery") resolveBoard = resolve;
        else if (proc === "goals/get") resolve(twoRowsGoal);
        else reject(new Error(`unexpected ${proc}`));
      }),
  );
  const node = await renderExpanded();
  const retryButtons = [...node.querySelectorAll("button")].filter((item) =>
    item.textContent?.includes("Retry board update"),
  );
  expect(retryButtons).toHaveLength(2);
  const [settlingRow, otherRow] = retryButtons as [HTMLButtonElement, HTMLButtonElement];
  await act(async () => {
    settlingRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(settlingRow.getAttribute("aria-busy")).toBe("true");
  expect(otherRow.getAttribute("aria-busy")).toBe("false");
  await act(async () => {
    resolveBoard?.(twoRowsGoal);
  });
  expect(settlingRow.getAttribute("aria-busy")).toBe("false");
});

it.each(["pending", "active"])(
  "shows a pending phone step waiting on a %s prerequisite",
  async (status) => {
    rpc.mockResolvedValue({
      ...pausedGoal,
      status: "running",
      plan: {
        revision: 2,
        steps: [
          { id: "draft", title: "Draft report", ownerId: "writer", status, prerequisiteIds: [] },
          {
            id: "done",
            title: "Earlier work",
            ownerId: "writer",
            status: "done",
            prerequisiteIds: [],
          },
          {
            id: "review",
            title: "Review report",
            ownerId: "reviewer",
            status: "pending",
            prerequisiteIds: ["draft", "done"],
          },
        ],
      },
    });
    const node = await renderExpanded();
    expect(node.textContent).toContain("Waiting for Draft report");
    expect(node.textContent).not.toContain("Waiting for Draft report, Earlier work");
    expect(node.textContent).toContain("Pending");
    expect(node.textContent).not.toContain("Blocked");
  },
);
