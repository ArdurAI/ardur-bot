// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
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
    _: ({ message, values }: { message: string; values?: { name: string } }) =>
      values ? message.replace("{name}", values.name) : message,
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

it("delivers followed Board changes through the shared preference gate", async () => {
  fake.activity.mockResolvedValueOnce(snapshot([])).mockResolvedValue(
    snapshot([
      {
        ...row,
        id: "board-change",
        name: "Plan next step",
        status: "board_changed",
        threadId: "board:workspace:item",
        board: { spaceId: "space", workspaceId: "workspace", itemId: "item" },
      },
    ]),
  );
  await renderSettings(<Harness />);
  await poll();
  expect(fake.show).toHaveBeenCalledExactlyOnceWith("Plan next step", {
    tag: "board:workspace:item",
  });
  await poll();
  expect(fake.show).toHaveBeenCalledOnce();
});

it("says a board close that keeps failing could not be closed, and what to do, in the reader's language", async () => {
  fake.activity.mockResolvedValueOnce(snapshot([])).mockResolvedValue(
    snapshot([
      {
        ...row,
        id: "close-notice",
        name: "A board item filed by a bot could not be closed.",
        status: "board_changed",
        threadId: "board:workspace:item",
        board: { spaceId: "space", workspaceId: "workspace", itemId: "item", closeFailed: true },
      },
    ]),
  );
  await renderSettings(<Harness />);
  await poll();
  expect(fake.show).toHaveBeenCalledExactlyOnceWith(
    "A board item filed by a bot could not be closed.",
    {
      tag: "board:workspace:item",
      body: "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.",
    },
  );
  for (const locale of ["ru", "zh-CN"])
    for (const msgid of [
      "A board item filed by a bot could not be closed.",
      "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.",
    ]) {
      const catalog = readFileSync(
        path.join(import.meta.dirname, "../locales", locale, "messages.po"),
        "utf8",
      );
      const key = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
      const at = catalog.indexOf(key);
      const translated =
        at < 0 ? "" : catalog.slice(at + key.length, catalog.indexOf('"', at + key.length));
      expect(translated, `${locale}: ${msgid}`).toBeTruthy();
    }
});
