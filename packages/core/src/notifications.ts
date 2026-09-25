import type {
  NotificationActivity,
  NotificationCategory,
  NotificationPreferences,
} from "@ardurbot/contracts";

export type NotificationEvent = {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  threadId: string;
};

/** A single preference gate; platform adapters own permission and delivery. */
export async function notify(
  event: NotificationEvent,
  preferences: NotificationPreferences,
  deliver: (event: NotificationEvent) => Promise<void> | void,
): Promise<boolean> {
  if (!preferences[event.category]) return false;
  await deliver(event);
  return true;
}

export function runNotificationCategory(
  run: {
    trigger?: string;
    originDeviceGrantId?: string | null;
  },
  needsInput = false,
): NotificationCategory {
  if (run.trigger === "routine") return "routines";
  if (needsInput) return "approvalsNeeded";
  return run.originDeviceGrantId ? "dispatchMessages" : "responseCompletions";
}

/** Seed history once, then deliver only changed states. Muted events stay consumed. */
export class NotificationActivityTracker {
  private seen = new Set<string>();
  private seeded = false;
  private newest = "";
  accept(rows: NotificationActivity[]): NotificationActivity[] {
    const next = new Set(rows.map((row) => `${row.id}:${row.status}`));
    const changed = this.seeded
      ? rows.filter(
          (row) =>
            row.enabled &&
            row.updatedAt >= this.newest &&
            !this.seen.has(`${row.id}:${row.status}`),
        )
      : [];
    this.seen = next;
    for (const row of rows) if (row.updatedAt > this.newest) this.newest = row.updatedAt;
    this.seeded = true;
    return changed;
  }
}
