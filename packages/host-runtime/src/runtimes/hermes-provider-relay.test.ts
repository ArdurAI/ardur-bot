import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { startHermesProviderRelay } from "./hermes-provider-relay.js";

function grant() {
  return {
    protocol: 1 as const,
    id: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 60_000,
    hostGeneration: randomUUID(),
  };
}

it("authenticates the loopback grant and pulls sequenced chunks", async () => {
  const authorized = grant();
  const callback = vi.fn(async (method: string, args: unknown[]) => {
    if (method === "provider.open") {
      expect(args).toEqual([{ model: "fixture-model" }]);
      return { status: 200, contentType: "application/json" };
    }
    if (method === "provider.read")
      return { seq: args[0], chunk: Buffer.from("ok").toString("base64"), done: true };
    throw new Error("Unexpected callback");
  });
  const relay = await startHermesProviderRelay(authorized, callback);
  try {
    const refused = await fetch(`${relay.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
    expect(callback).not.toHaveBeenCalled();
    const accepted = await fetch(`${relay.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${authorized.token}` },
      body: JSON.stringify({ model: "fixture-model" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("ok");
    expect(callback.mock.calls.map(([method]) => method)).toEqual([
      "provider.open",
      "provider.read",
    ]);
  } finally {
    relay.close();
  }
});

it("fails closed on response sequence drift", async () => {
  const authorized = grant();
  const failed = vi.fn();
  const relay = await startHermesProviderRelay(
    authorized,
    async (method) => {
      if (method === "provider.open") return { status: 200, contentType: "application/json" };
      if (method === "provider.read") return { seq: 4, chunk: "", done: true };
      return undefined;
    },
    failed,
  );
  try {
    await expect(
      fetch(`${relay.url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${authorized.token}` },
        body: "{}",
      }).then((response) => response.text()),
    ).rejects.toThrow();
    expect(failed).toHaveBeenCalledOnce();
  } finally {
    relay.close();
  }
});

it("refuses request bodies above the broker limit before a callback", async () => {
  const authorized = grant();
  const callback = vi.fn();
  const relay = await startHermesProviderRelay(authorized, callback);
  try {
    const response = await fetch(`${relay.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${authorized.token}` },
      body: JSON.stringify({ text: "x".repeat(256 * 1024) }),
    });
    expect(response.status).toBe(502);
    expect(callback).not.toHaveBeenCalledWith("provider.open", expect.anything());
  } finally {
    relay.close();
  }
});
