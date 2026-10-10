import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts/local-settings";
import type { RemoteListener } from "@ardurbot/host-runtime/device-listener";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  createServerDeviceListener,
  localDeviceTarget,
  mountDesktopListenerState,
} from "./server-device-listener.js";

function fixture(enabled = false) {
  let state = { enabled: false, hints: [] as string[] };
  const listener = {
    state: () => state,
    start: vi.fn(async (input) => {
      state = { enabled: true, hints: input.listen.hints };
    }),
    stop: vi.fn(async () => {
      state = { enabled: false, hints: [] };
    }),
  };
  const secrets = { load: vi.fn(() => "nonfunctional-fixture-private-key") };
  const config = { bind: "127.0.0.1", port: 43119, hints: ["https://home.example.test:43119"] };
  const home = {
    certificate: "nonfunctional-fixture-certificate",
    certificateFingerprint: "a".repeat(64),
    privateKeyCiphertext: "v2:nonfunctional-fixture",
    instanceId: "fixture-home",
  } as Parameters<typeof createServerDeviceListener>[1];
  const coordinator = createServerDeviceListener(
    { apiHost: "0.0.0.0", port: 3100, deviceListener: enabled ? config : undefined },
    home,
    secrets,
    listener as unknown as RemoteListener,
  );
  return { coordinator, listener, secrets, home, config };
}
afterEach(() => vi.useRealTimers());
it("keeps a default headless home unavailable without decrypting its key or binding", async () => {
  const f = fixture();
  await f.coordinator.start();
  expect(f.coordinator.state()).toEqual({ enabled: false, hints: [] });
  expect(f.listener.start).not.toHaveBeenCalled();
  expect(f.secrets.load).not.toHaveBeenCalled();
});
it("uses the durable instance material and fixed local API target, then shuts down", async () => {
  const f = fixture(true);
  await f.coordinator.start();
  expect(f.secrets.load).toHaveBeenCalledWith(f.home.privateKeyCiphertext, f.home.instanceId);
  expect(f.listener.start).toHaveBeenCalledWith(
    expect.objectContaining({
      target: "http://127.0.0.1:3100",
      certificate: f.home.certificate,
      certificateFingerprint: f.home.certificateFingerprint,
      listen: f.config,
    }),
  );
  expect(f.coordinator.state()).toEqual({ enabled: true, hints: f.config.hints });
  await f.coordinator.stop();
  expect(f.listener.stop).toHaveBeenCalledOnce();
  expect(f.coordinator.state()).toEqual({ enabled: false, hints: [] });
});
it("propagates a listener failure to startup instead of reporting enabled", async () => {
  const f = fixture(true);
  f.listener.start.mockRejectedValue(new Error("Fixture bind failure"));
  await expect(f.coordinator.start()).rejects.toThrow("Fixture bind failure");
  expect(f.coordinator.state().enabled).toBe(false);
});
it("identifies a conflicting device port and preserves the bind error", async () => {
  const f = fixture(true);
  const conflict = Object.assign(new Error("Fixture bind failed"), { code: "EADDRINUSE" });
  f.listener.start.mockRejectedValue(conflict);
  await expect(f.coordinator.start()).rejects.toMatchObject({
    message: "Device HTTPS listener cannot start: 127.0.0.1:43119 is already in use.",
    cause: conflict,
  });
  expect(f.coordinator.state()).toEqual({ enabled: false, hints: [] });
});
it("derives a loopback target and rejects arbitrary destinations", () => {
  expect(localDeviceTarget({ apiHost: "localhost", port: 3100 })).toBe("http://localhost:3100");
  expect(localDeviceTarget({ apiHost: "::", port: 3100 })).toBe("http://[::1]:3100");
  for (const apiHost of ["https://external.example.test", "10.0.0.2", "external.example.test"])
    expect(() => localDeviceTarget({ apiHost, port: 3100 })).toThrow("local API");
});
it("approves desktop hints only with the stack token, bounds input, and expires stale approvals", async () => {
  const f = fixture();
  const app = new Hono();
  const token = "a".repeat(64);
  mountDesktopListenerState(app, token, f.coordinator);
  const call = (body: unknown, supplied?: string) =>
    app.request("/local/device-listener-state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(supplied ? { [LOCAL_SETTINGS_TOKEN_HEADER]: supplied } : {}),
      },
      body: JSON.stringify(body),
    });
  const state = { enabled: true, hints: ["https://10.0.0.2:43119"] };
  for (const supplied of [undefined, "b".repeat(64)])
    expect((await call(state, supplied)).status).toBe(403);
  expect((await call(state, token)).status).toBe(200);
  expect(f.coordinator.trustedDesktopHints()).toEqual(state.hints);
  expect((await call({ ...state, privateKey: "nonfunctional-fixture-key" }, token)).status).toBe(
    400,
  );
  expect(
    (await call({ enabled: true, hints: ["https://home.example.test/rpc"] }, token)).status,
  ).toBe(400);
  expect((await call({ enabled: true, hints: ["x".repeat(17 * 1024)] }, token)).status).toBe(413);
  vi.setSystemTime(Date.now() + 30_001);
  expect(f.coordinator.trustedDesktopHints()).toEqual([]);
  await call(state, token);
  await call({ enabled: false, hints: [] }, token);
  expect(f.coordinator.trustedDesktopHints()).toEqual([]);
  expect((await app.request("/local/device-listener-state")).status).toBe(404);
});
