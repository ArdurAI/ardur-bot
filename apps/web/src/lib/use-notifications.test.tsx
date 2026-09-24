// @vitest-environment jsdom

import type { NotificationActivity } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderSettings } from "../test/settings-ui";

const fake = vi.hoisted(() => ({ activity: vi.fn(), show: vi.fn(), ready: true }));
vi.mock("./rpc", () => ({ rpc: { notifications: { activity: fake.activity } } }));
vi.mock("../components/PreferencesProvider", () => ({
  usePreferences: () => ({ ready: fake.ready }),
}));
vi.mock("./i18n", () => ({
  i18n: {
    _: ({ message, values }: { message: string; values: { name: string } }) =>
      message.replace("{name}", values.name),
  },
}));

import { useNotifications } from "./use-notifications";

function Harness() {
  useNotifications();
  return null;
}
const row: NotificationActivity = {
  id: "run",
  name: "Helper",
  threadId: "thread",
  category: "responseCompletions",
  status: "completed",
  updatedAt: "2026-09-24T00:00:00Z",
  enabled: true,
};
const snapshot = (activities: NotificationActivity[], preferences = DEFAULT_USER_PREFERENCES) => ({
  userId: "user",
  preferences,
  activities,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fake.ready = true;
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        fake.show(title, options);
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const poll = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
it("seeds history and delivers changes from any account thread once", async () => {
  fake.activity
    .mockResolvedValueOnce(snapshot([{ ...row, id: "history" }]))
    .mockResolvedValue(snapshot([row]));
  await renderSettings(<Harness />);
  expect(fake.show).not.toHaveBeenCalled();
  await poll();
  expect(fake.show).toHaveBeenCalledExactlyOnceWith("Helper finished", { tag: "thread" });
  await poll();
  expect(fake.show).toHaveBeenCalledOnce();
});
it("uses current server preferences and keeps dispatch delivery on the phone", async () => {
  fake.activity.mockResolvedValueOnce(snapshot([])).mockResolvedValue(
    snapshot(
      [
        { ...row, category: "routines" },
        { ...row, id: "phone", category: "dispatchMessages" },
      ],
      {
        ...DEFAULT_USER_PREFERENCES,
        notifications: { ...DEFAULT_USER_PREFERENCES.notifications, routines: false },
      },
    ),
  );
  await renderSettings(<Harness />);
  await poll();
  expect(fake.show).not.toHaveBeenCalled();
});
it("routes approvals to Electron and suppresses foreground and denied web delivery", async () => {
  const show = vi.fn(async () => true);
  window.ardurbotDesktop = {
    platform: "darwin",
    notifications: { show, supported: async () => true },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  fake.activity
    .mockResolvedValueOnce(snapshot([]))
    .mockResolvedValue(
      snapshot([{ ...row, category: "approvalsNeeded", status: "waiting_input" }]),
    );
  await renderSettings(<Harness />);
  await poll();
  expect(show).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Helper needs your input", threadId: "thread" }),
  );
  expect(fake.show).not.toHaveBeenCalled();
  delete window.ardurbotDesktop;
});
it("does not poll before preferences load or replay events seen with denied permission", async () => {
  fake.ready = false;
  const { root } = await renderSettings(<Harness />);
  expect(fake.activity).not.toHaveBeenCalled();
  fake.ready = true;
  vi.stubGlobal("Notification", { permission: "denied" });
  fake.activity.mockResolvedValueOnce(snapshot([])).mockResolvedValue(snapshot([row]));
  await act(async () => root.render(<Harness />));
  await poll();
  expect(fake.show).not.toHaveBeenCalled();
});
