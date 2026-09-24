import { describe, expect, it, vi } from "vitest";
import type { NativeDevices, PairedHome } from "./dispatch-client";
import {
  createDispatchClient,
  DEVICE_HOME_KEY,
  dispatchReceiptLabel,
  HOME_CHANGED,
  WAITING_FOR_HOME,
} from "./dispatch-client";

function fixture() {
  const keys = {
    handle: "native-key",
    publicKey: "public",
    presencePublicKey: "presence-public",
    publicKeyFingerprint: "fingerprint",
  };
  const home: PairedHome = {
    url: "https://home.test",
    instanceId: "home",
    fingerprint: "a".repeat(64),
    certificateFingerprint: "b".repeat(64),
    homeName: "Test home",
    grantId: "phone",
    spaceId: "space",
    keys,
  };
  const values = new Map([[DEVICE_HOME_KEY, JSON.stringify(home)]]);
  const bodies: Array<Record<string, unknown>> = [];
  let offline = false;
  let changed = false;
  const native: NativeDevices = {
    nonce: () => "random-client-nonce",
    createKeys: async () => keys,
    sign: vi.fn(async () => "signature"),
    verifyHome: vi.fn(async () => true),
    scanQr: vi.fn(),
    request: vi.fn(async (url, _pin, body) => {
      if (offline) throw new Error("offline");
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      if (url.endsWith("/nonce"))
        return {
          status: 200,
          body: JSON.stringify({
            instanceId: "home",
            fingerprint: changed ? "different" : home.fingerprint,
            certificate: "certificate",
            signature: "server-proof",
            nonce: "server-nonce",
            timestamp: 123,
          }),
        };
      return {
        status: 200,
        body: JSON.stringify({
          taskId: "task",
          runId: "run",
          threadId: "thread",
          botId: "bot",
          state: "accepted",
          cancelRequested: false,
        }),
      };
    }),
  };
  const storage = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
  const status = vi.fn();
  const client = createDispatchClient(native, storage, status);
  return {
    native,
    storage,
    home,
    status,
    client,
    values,
    bodies,
    offline: (v: boolean) => {
      offline = v;
    },
    changed: () => {
      changed = true;
    },
  };
}
describe("mobile Dispatch", () => {
  it("retains the client nonce across an unreachable home and an app restart", async () => {
    const f = fixture();
    f.offline(true);
    await expect(f.client.send({ botId: "bot", text: "Hello" })).rejects.toThrow(
      "Home unreachable",
    );
    expect(f.status).toHaveBeenLastCalledWith(WAITING_FOR_HOME);
    expect(f.status).not.toHaveBeenCalledWith("Accepted");
    const nonce = (await f.client.pending())?.clientNonce;
    f.offline(false);
    const restarted = createDispatchClient(f.native, f.storage, f.status);
    expect((await restarted.retry())?.state).toBe("accepted");
    expect((f.bodies.at(-1)!.body as { clientNonce: string }).clientNonce).toBe(nonce);
    expect(f.status).toHaveBeenLastCalledWith("Accepted");
    expect(await restarted.pending()).toBeNull();
  });
  it("does not replace unsent work when the composer changes", async () => {
    const f = fixture();
    f.offline(true);
    await expect(f.client.send({ text: "Original", botId: "bot" })).rejects.toThrow();
    await expect(f.client.send({ text: "Changed", botId: "bot" })).rejects.toThrow(
      "retry or discard",
    );
    expect((await f.client.pending())?.text).toBe("Original");
    await f.client.discard();
    expect(await f.client.pending()).toBeNull();
  });
  it("requires re-pairing when the same URL has a different home identity", async () => {
    const f = fixture();
    f.changed();
    await expect(f.client.request("tasks")).rejects.toThrow(HOME_CHANGED);
    expect(f.native.sign).not.toHaveBeenCalled();
  });
  it("requires a fresh home signature and uses the protected key only for presence", async () => {
    const f = fixture();
    await f.client.request("presence");
    expect(f.native.verifyHome).toHaveBeenCalled();
    expect(f.native.sign).toHaveBeenCalledWith("native-key", expect.any(String), true);
    await f.client.request("tasks");
    expect(f.native.sign).toHaveBeenLastCalledWith("native-key", expect.any(String), false);
    expect(JSON.stringify(f.bodies)).not.toContain("session");
    expect(JSON.stringify(f.bodies)).not.toContain("authorization");
  });
});

it("labels a stop only after home confirms it", () => {
  expect(dispatchReceiptLabel({ state: "running", cancelRequested: true })).toBe("Stopping");
  expect(dispatchReceiptLabel({ state: "stopped", cancelRequested: true })).toBe("Stopped");
  expect(dispatchReceiptLabel({ state: "done", cancelRequested: true })).toBe("Done");
});
