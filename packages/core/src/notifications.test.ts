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
});
