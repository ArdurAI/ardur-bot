import type { NotificationCategory } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import { notifyRun } from "./executor.js";

it.each<NotificationCategory>([
  "responseCompletions",
  "routines",
  "approvalsNeeded",
  "dispatchMessages",
])("gates executor %s delivery with the stored account preference", async (category) => {
  const send = vi.fn();
  const stored = {
    ...DEFAULT_USER_PREFERENCES,
    ...DEFAULT_USER_PREFERENCES.notifications,
    [category]: false,
  };
  const findUnique = vi.fn(async () => ({
    delegationId: null,
    delegationRootTaskId: null,
    trigger: category === "routines" ? "routine" : "user",
    originDeviceGrantId: category === "dispatchMessages" ? "phone" : null,
    bot: { notifyOnFinish: true },
    thread: { groupId: null },
  }));
  const deps = {
    prisma: {
      run: { findUnique, findFirst: findUnique },
      userPreferences: { findUnique: vi.fn(async () => stored) },
    },
    notifications: { send },
  } as unknown as ExecutorDeps;
  const run = { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };
  const message = {
    kind: category === "approvalsNeeded" ? ("help" as const) : ("completion" as const),
    title: "Finished",
    body: "",
    botId: "bot",
    threadId: "thread",
  };
  await notifyRun(deps, run, message);
  expect(send).not.toHaveBeenCalled();
  stored[category] = true;
  await notifyRun(deps, run, message);
  expect(send).toHaveBeenCalledWith(
    message,
    expect.objectContaining({ userId: "user", spaceId: "space" }),
  );
});
it("never emits a second push for a delegated subrun", async () => {
  const send = vi.fn();
  const findPreferences = vi.fn();
  const deps = {
    prisma: {
      run: { findUnique: async () => ({ delegationId: "delegate" }) },
      userPreferences: { findUnique: findPreferences },
    },
    notifications: { send },
  } as unknown as ExecutorDeps;
  await notifyRun(
    deps,
    { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
    { kind: "completion", title: "Finished", body: "", botId: "bot", threadId: "thread" },
  );
  expect(send).not.toHaveBeenCalled();
  expect(findPreferences).not.toHaveBeenCalled();
});
