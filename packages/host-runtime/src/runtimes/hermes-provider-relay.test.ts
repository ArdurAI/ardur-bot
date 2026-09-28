import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clientRequest(url: string, token: string, onData?: () => void) {
  const client = httpRequest(`${url}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  client.on("error", () => undefined);
  client.on("response", (response) => {
    response.on("data", () => onData?.());
    response.on("error", () => undefined);
  });
  client.end("{}");
  return client;
}

it("cancels once when the client disconnects while provider.open is pending", async () => {
  const authorized = grant();
  const opened = deferred<void>();
  const pending = deferred<{ status: number; contentType: "application/json" }>();
  const failed = vi.fn();
  let requests = 0;
  const callback = vi.fn(async (method: string, args: unknown[]) => {
    if (method === "provider.open") {
      if (requests++ === 0) {
        opened.resolve();
        return pending.promise;
      }
      return { status: 200, contentType: "application/json" };
    }
    if (method === "provider.cancel") {
      pending.reject(new Error("Cancelled."));
      return undefined;
    }
    if (method === "provider.read")
      return { seq: args[0], chunk: Buffer.from("ok").toString("base64"), done: true };
    throw new Error("Unexpected callback");
  });
  const relay = await startHermesProviderRelay(authorized, callback, failed);
  const client = clientRequest(relay.url, authorized.token);
  try {
    await opened.promise;
    client.destroy();
    await vi.waitFor(() =>
      expect(callback.mock.calls.filter(([method]) => method === "provider.cancel")).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    const response = await fetch(`${relay.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${authorized.token}` },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(callback.mock.calls.filter(([method]) => method === "provider.cancel")).toHaveLength(1);
  } finally {
    pending.reject(new Error("Test cleanup."));
    client.destroy();
    relay.close();
  }
});

it("cancels once when the client disconnects during a provider stream", async () => {
  const authorized = grant();
  const reading = deferred<void>();
  const pending = deferred<{ seq: number; chunk: string; done: boolean }>();
  const failed = vi.fn();
  let reads = 0;
  let opens = 0;
  const callback = vi.fn(async (method: string, args: unknown[]) => {
    if (method === "provider.open") {
      opens++;
      return { status: 200, contentType: "application/json" };
    }
    if (method === "provider.read") {
      if (opens > 1)
        return { seq: args[0], chunk: Buffer.from("ok").toString("base64"), done: true };
      if (reads++ === 0)
        return { seq: args[0], chunk: Buffer.from("first").toString("base64"), done: false };
      reading.resolve();
      return pending.promise;
    }
    if (method === "provider.cancel") {
      pending.reject(new Error("Cancelled."));
      return undefined;
    }
    throw new Error("Unexpected callback");
  });
  const relay = await startHermesProviderRelay(authorized, callback, failed);
  const client = clientRequest(relay.url, authorized.token, () => client.destroy());
  try {
    await reading.promise;
    await vi.waitFor(() =>
      expect(callback.mock.calls.filter(([method]) => method === "provider.cancel")).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    const response = await fetch(`${relay.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${authorized.token}` },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  } finally {
    pending.reject(new Error("Test cleanup."));
    client.destroy();
    relay.close();
  }
});

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
