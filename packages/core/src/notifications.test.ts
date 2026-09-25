import type { NotificationActivity, NotificationCategory } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { NotificationActivityTracker, notify, runNotificationCategory } from "./notifications.js";

describe("notification preference gate", () => {
  it.each<NotificationCategory>([
    "responseCompletions",
    "routines",
    "approvalsNeeded",
    "dispatchMessages",
  ])("gates %s before calling the transport", async (category) => {
    const deliver = vi.fn();
    const event = { id: "run", category, title: "Finished", body: "", threadId: "thread" };
    expect(
      await notify(
        event,
        { ...DEFAULT_USER_PREFERENCES.notifications, [category]: false },
        deliver,
      ),
    ).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(await notify(event, DEFAULT_USER_PREFERENCES.notifications, deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(event);
  });
  it("classifies routines, approvals, dispatch results and normal replies", () => {
    expect(runNotificationCategory({ trigger: "routine" })).toBe("routines");
    expect(runNotificationCategory({ trigger: "routine" }, true)).toBe("routines");
    expect(runNotificationCategory({ trigger: "user" }, true)).toBe("approvalsNeeded");
    expect(runNotificationCategory({ originDeviceGrantId: "phone" })).toBe("dispatchMessages");
    expect(runNotificationCategory({ originDeviceGrantId: "phone" }, true)).toBe("approvalsNeeded");
    expect(runNotificationCategory({})).toBe("responseCompletions");
  });
  it("does not mistake a failed transport for a successful delivery", async () => {
    await expect(
      notify(
        { id: "run", category: "routines", title: "Finished", body: "", threadId: "thread" },
        DEFAULT_USER_PREFERENCES.notifications,
        () => {
          throw new Error("offline");
        },
      ),
    ).rejects.toThrow("offline");
  });
  it("seeds history, deduplicates statuses, and consumes muted changes", () => {
    const tracker = new NotificationActivityTracker();
    const row: NotificationActivity = {
      id: "run",
      name: "Bot",
      threadId: "thread",
      category: "routines",
      status: "waiting_input",
      updatedAt: "2026-09-24T00:00:00Z",
      enabled: true,
    };
    expect(tracker.accept([row])).toEqual([]);
    const done = { ...row, status: "completed" as const };
    expect(tracker.accept([done])).toEqual([done]);
    expect(tracker.accept([done])).toEqual([]);
    const muted = { ...done, id: "muted", enabled: false };
    expect(tracker.accept([done, muted])).toEqual([]);
    expect(tracker.accept([done, { ...muted, enabled: true }])).toEqual([]);
  });
  it.each([true, false])("ignores mirror timestamps for a completion seeded=%s", (seeded) => {
    const tracker = new NotificationActivityTracker();
    const done: NotificationActivity = {
      id: "run",
      name: "Bot",
      threadId: "thread",
      category: "responseCompletions",
      status: "completed",
      updatedAt: "2026-09-24T00:00:00Z",
      enabled: true,
    };
    tracker.accept(seeded ? [done] : []);
    expect(tracker.accept([done])).toEqual(seeded ? [] : [done]);
    expect(tracker.accept([{ ...done, updatedAt: "2026-09-24T00:00:01Z" }])).toEqual([]);
    expect(tracker.accept([{ ...done, updatedAt: "2026-09-24T00:00:02Z" }])).toEqual([]);
    const waiting = {
      ...done,
      status: "waiting_input" as const,
      updatedAt: "2026-09-24T00:00:03Z",
    };
    expect(tracker.accept([waiting])).toEqual([waiting]);
    const completedAgain = { ...done, updatedAt: "2026-09-24T00:00:04Z" };
    expect(tracker.accept([completedAgain])).toEqual([completedAgain]);
  });
  it("keeps a muted completion consumed after mirror writes and enabling notifications", () => {
    const tracker = new NotificationActivityTracker();
    const row: NotificationActivity = {
      id: "run",
      name: "Bot",
      threadId: "thread",
      category: "routines",
      status: "completed",
      updatedAt: "2026-09-24T00:00:00Z",
      enabled: false,
    };
    tracker.accept([]);
    expect(tracker.accept([row])).toEqual([]);
    expect(tracker.accept([{ ...row, enabled: true, updatedAt: "2026-09-24T00:00:01Z" }])).toEqual(
      [],
    );
  });
});
