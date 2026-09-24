import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./dispatch", () => ({ hasPairedDevice: vi.fn(async () => false) }));

import { rpc } from "./api";
import { hasPairedDevice } from "./dispatch";
import {
  availableNotificationCategories,
  loadNotificationPreferences,
  updateNotificationPreference,
} from "./notification-preferences";

beforeEach(() => vi.clearAllMocks());
it("hides account settings for a phone with only a dispatch grant", async () => {
  vi.mocked(hasPairedDevice).mockResolvedValueOnce(true);
  expect(await loadNotificationPreferences()).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});
it("shows only switches with a live delivery path", () => {
  expect(availableNotificationCategories(false, false)).toEqual([]);
  expect(availableNotificationCategories(false, true)).toEqual([
    "responseCompletions",
    "routines",
    "approvalsNeeded",
  ]);
  expect(availableNotificationCategories(true, false)).toEqual([
    "responseCompletions",
    "routines",
    "approvalsNeeded",
    "dispatchMessages",
  ]);
});
it("reads and writes the same per-user RPC with a minimal notification patch", async () => {
  vi.mocked(rpc)
    .mockResolvedValueOnce(DEFAULT_USER_PREFERENCES)
    .mockResolvedValueOnce({
      preferences: {
        ...DEFAULT_USER_PREFERENCES,
        notifications: { ...DEFAULT_USER_PREFERENCES.notifications, routines: false },
      },
    });
  expect(await loadNotificationPreferences()).toEqual(DEFAULT_USER_PREFERENCES);
  expect((await updateNotificationPreference("routines", false)).notifications.routines).toBe(
    false,
  );
  expect(rpc).toHaveBeenNthCalledWith(1, "preferences/get");
  expect(rpc).toHaveBeenNthCalledWith(2, "preferences/update", {
    notifications: { routines: false },
  });
});
