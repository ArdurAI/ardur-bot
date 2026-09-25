import type { NotificationCategory, UserPreferences } from "@ardurbot/contracts";
import { rpc } from "./api";
import { hasPairedDevice } from "./dispatch";

export function availableNotificationCategories(
  push: boolean,
  live: boolean,
): NotificationCategory[] {
  return [
    ...(push || live ? (["responseCompletions", "routines", "approvalsNeeded"] as const) : []),
    ...(push ? (["dispatchMessages"] as const) : []),
  ];
}
export async function loadNotificationPreferences() {
  // Device grants permit dispatch actions, not account preference or push-token changes.
  if (await hasPairedDevice()) return null;
  return rpc<UserPreferences>("preferences/get");
}
export async function updateNotificationPreference(key: NotificationCategory, enabled: boolean) {
  const result = await rpc<{ preferences: UserPreferences }>("preferences/update", {
    notifications: { [key]: enabled },
  });
  return result.preferences;
}
