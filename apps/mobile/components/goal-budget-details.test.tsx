// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
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
    ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement(tag, { onClick: onPress }, children);
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
});

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
  const open = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Open board item"),
  );
  expect(open).toBeTruthy();
  await act(async () => {
    open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(push).toHaveBeenCalledWith({
    pathname: "/overview",
    params: { view: "board", workspace: "workspace", item: "board-a" },
  });
});

it("retries a paused board delivery from the goal card", async () => {
  const goal = {
    id: "goal-1",
    groupId: "group",
    usedTokens: 1,
    reservedTokens: 0,
    availableTokens: 1,
    usageComplete: true,
    boardWorkspaceId: "workspace",
    boardItemId: "board-a",
    boardDelivery: "paused",
    boardDeliveryActions: [{ id: "delivery-1", transition: "completed", state: "paused" }],
  };
  rpc.mockImplementation(async (proc: string) => (proc === "goals/boardDelivery" ? goal : goal));
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
  const retry = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Retry board update"),
  );
  expect(retry).toBeTruthy();
  await act(async () => {
    retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(rpc).toHaveBeenCalledWith("goals/boardDelivery", {
    goalId: "goal-1",
    deliveryId: "delivery-1",
    action: "retry",
  });
});
