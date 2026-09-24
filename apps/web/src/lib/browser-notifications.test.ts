import { describe, expect, it, vi } from "vitest";
import type { BrowserNotificationApi } from "./browser-notifications.js";
import { requestBrowserNotificationPermission } from "./browser-notifications.js";

describe("browser notification permission", () => {
  it.each(["granted", "denied"] as const)(
    "respects %s without another prompt",
    async (permission) => {
      const requestPermission = vi.fn();
      expect(await requestBrowserNotificationPermission({ permission, requestPermission })).toBe(
        permission,
      );
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );
  it("coalesces a prompt and allows a later gesture to retry a dismissal", async () => {
    let resolvePermission: ((permission: "default") => void) | undefined;
    const requestPermission = vi.fn(
      () =>
        new Promise<"default">((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const api: BrowserNotificationApi = { permission: "default", requestPermission };
    const first = requestBrowserNotificationPermission(api);
    expect(requestBrowserNotificationPermission(api)).toBe(first);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    resolvePermission?.("default");
    await first;
    const second = requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(2);
    resolvePermission?.("default");
    await second;
  });
  it("handles rejected or unavailable permission APIs", async () => {
    expect(
      await requestBrowserNotificationPermission({
        permission: "default",
        requestPermission: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toBe("default");
    expect(requestBrowserNotificationPermission()).toBeUndefined();
  });
});
