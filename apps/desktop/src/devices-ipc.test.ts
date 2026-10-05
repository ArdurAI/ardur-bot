import type { DesktopInstanceMode } from "@ardurbot/contracts";
import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts/local-settings";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalStackController } from "./local-stack.js";
import type { RemoteListener } from "./remote-listener.js";

const fake = vi.hoisted(() => ({
  app: { isPackaged: false, getPath: () => "/fixture" },
  handlers: new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>(),
  fetch: vi.fn(),
  readToken: vi.fn(),
}));
vi.mock("electron", () => ({
  app: fake.app,
  net: { fetch: fake.fetch },
  ipcMain: {
    handle: (name: string, fn: (event: IpcMainInvokeEvent, value?: unknown) => unknown) =>
      fake.handlers.set(name, fn),
  },
}));
vi.mock("./local-stack.js", () => ({
  readStackToken: fake.readToken,
  stackDir: () => "/fixture/stack",
}));

import { installDevices } from "./devices-ipc.js";

const FAKE_DEVELOPMENT_TOKEN = "a".repeat(64);
const FAKE_MANAGED_TOKEN = "b".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  fake.app.isPackaged = false;
  vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", "");
  fake.readToken.mockResolvedValue(FAKE_MANAGED_TOKEN);
  fake.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      certificate: "test-cert",
      privateKey: "test-key",
      certificateFingerprint: "test-fingerprint",
    }),
  });
});
afterEach(() => vi.unstubAllEnvs());
function fixture(mode: DesktopInstanceMode = "existing", target = "http://127.0.0.1:5173") {
  const frame = { url: `${target}/app` };
  const window = { webContents: { mainFrame: frame } } as unknown as BrowserWindow;
  const event = { sender: window.webContents, senderFrame: frame } as IpcMainInvokeEvent;
  let enabled = false;
  const listener = {
    state: () => ({ enabled, hints: [] }),
    start: vi.fn(async () => {
      enabled = true;
    }),
    stop: vi.fn(async () => {
      enabled = false;
    }),
  };
  const stack = {
    webUrl: () => "http://127.0.0.1:45173",
    matchesDesiredStack: vi.fn(async () => true),
  };
  installDevices({
    window: () => window,
    target: () => target,
    mode: () => mode,
    stack: stack as unknown as LocalStackController,
    listener: listener as unknown as RemoteListener,
  });
  return {
    event,
    listener,
    stack,
    state: () => fake.handlers.get("desktop.devices.state")!(event),
    set: (enabled: boolean, source = event) =>
      fake.handlers.get("desktop.devices.setEnabled")!(source, enabled),
  };
}
describe("Devices main-process boundary", () => {
  it("reports existing-instance pairing as unavailable without the development token", async () => {
    const f = fixture();
    expect(await f.state()).toMatchObject({
      available: false,
      mode: "existing",
      reason: "Phone pairing needs a home run by this app. Set up This computer to use it.",
    });
    await expect(f.set(true)).rejects.toThrow("Phone pairing needs a home run by this app.");
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"])(
    "allows development pairing only to the selected loopback origin %s",
    async (target) => {
      vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", FAKE_DEVELOPMENT_TOKEN);
      const f = fixture("existing", target);
      expect(await f.state()).toMatchObject({ available: true });
      await expect(f.set(true)).resolves.toMatchObject({ enabled: true });
      expect(fake.fetch).toHaveBeenCalledWith(
        `${target}/local/device-listener`,
        expect.objectContaining({
          headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: FAKE_DEVELOPMENT_TOKEN },
          redirect: "error",
        }),
      );
      expect(f.listener.start).toHaveBeenCalledWith(expect.objectContaining({ target }));
      expect(fake.readToken).not.toHaveBeenCalled();
      expect(f.stack.matchesDesiredStack).not.toHaveBeenCalled();
      expect(JSON.stringify(await f.state())).not.toContain(FAKE_DEVELOPMENT_TOKEN);
      await expect(f.set(false)).resolves.toMatchObject({ enabled: false });
    },
  );
  it.each(["http://192.168.1.2:5173", "https://example.test"])(
    "never sends the development token to %s",
    async (target) => {
      vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", FAKE_DEVELOPMENT_TOKEN);
      const f = fixture("existing", target);
      expect(await f.state()).toMatchObject({ available: false });
      await expect(f.set(true)).rejects.toThrow();
      expect(fake.fetch).not.toHaveBeenCalled();
    },
  );
  it("never enables the development exception in a packaged app", async () => {
    fake.app.isPackaged = true;
    vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", FAKE_DEVELOPMENT_TOKEN);
    const f = fixture();
    await expect(f.set(true)).rejects.toThrow();
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it("keeps managed pairing on the private stack token and checks stack identity", async () => {
    fake.app.isPackaged = true;
    const f = fixture("new", "http://127.0.0.1:45173");
    await expect(f.set(true)).resolves.toMatchObject({ enabled: true, available: true });
    expect(fake.readToken).toHaveBeenCalledOnce();
    expect(f.stack.matchesDesiredStack).toHaveBeenCalledOnce();
    f.stack.matchesDesiredStack.mockResolvedValue(false);
    await expect(f.set(true)).rejects.toThrow("Start your home before pairing a phone.");
  });
  it("rejects other windows and subframes before reading credentials", async () => {
    vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", FAKE_DEVELOPMENT_TOKEN);
    const f = fixture();
    await expect(
      f.set(true, {
        ...f.event,
        senderFrame: { url: "http://127.0.0.1:5173/app" },
      } as IpcMainInvokeEvent),
    ).rejects.toThrow("Open Devices on your Mac.");
    await expect(f.set(true, { ...f.event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow();
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

it("publishes desktop hints only after binding and clears them when stopped", async () => {
  vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", FAKE_DEVELOPMENT_TOKEN);
  const f = fixture();
  await f.set(true);
  expect(fake.fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:5173/local/device-listener-state",
    expect.objectContaining({
      body: JSON.stringify({ enabled: true, hints: [] }),
      headers: {
        [LOCAL_SETTINGS_TOKEN_HEADER]: FAKE_DEVELOPMENT_TOKEN,
        "content-type": "application/json",
      },
    }),
  );
  const calls = fake.fetch.mock.calls.length;
  await f.state();
  expect(fake.fetch.mock.calls.length).toBe(calls + 1);
  await f.set(false);
  expect(fake.fetch.mock.calls.at(-1)?.[1].body).toBe(
    JSON.stringify({ enabled: false, hints: [] }),
  );
});
it("stops the desktop listener when the home refuses approval", async () => {
  vi.stubEnv("ARDURBOT_DESKTOP_STACK_TOKEN", FAKE_DEVELOPMENT_TOKEN);
  const f = fixture();
  fake.fetch
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        certificate: "test-cert",
        privateKey: "test-key",
        certificateFingerprint: "test-pin",
      }),
    })
    .mockResolvedValue({ ok: false });
  await expect(f.set(true)).rejects.toThrow("Update your home");
  expect(f.listener.stop).toHaveBeenCalledOnce();
  expect(await f.state()).toMatchObject({ enabled: false });
});
