import { createHash, X509Certificate } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { connect } from "node:tls";
import { DEVICE_API_PATHS } from "@ardurbot/contracts/device-paths";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { HOME_CHANGED, pinnedPost } from "../../cli/src/transport.js";
import { loadEnv } from "./env.js";
import { generateInstanceCertificate } from "./instance-certificate.js";
import { createServerDeviceListener } from "./server-device-listener.js";

let material: Awaited<ReturnType<typeof generateInstanceCertificate>>;
let certificateFingerprint: string;
const servers: Server[] = [];
const listeners: ReturnType<typeof createServerDeviceListener>[] = [];

beforeAll(async () => {
  material = await generateInstanceCertificate();
  certificateFingerprint = createHash("sha256")
    .update(new X509Certificate(material.certificate).raw)
    .digest("hex");
});

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.stop()));
  await Promise.all(servers.splice(0).map(close));
});

async function fixture(enabled = true) {
  const received = vi.fn();
  // Disposable HTTP fixture only; no application, database or development stack.
  const upstream = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    received(incoming.url, incoming.headers, Buffer.concat(chunks).toString());
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true }));
  });
  servers.push(upstream);
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const apiPort = (upstream.address() as AddressInfo).port;
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/fixture",
    // loadEnv forwards on API_PORT (env.port). PORT only feeds a discarded
    // reachability check, so both must name this fixture, never the default API port.
    PORT: String(apiPort),
    API_PORT: String(apiPort),
    ...(enabled
      ? {
          ARDURBOT_DEVICE_LISTENER_ENABLED: "true",
          ARDURBOT_DEVICE_LISTENER_ORIGIN: "https://127.0.0.1:43119",
        }
      : {}),
  });
  // Reserve an ephemeral test port, then release it for the TLS listener.
  const reservation = createServer();
  servers.push(reservation);
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await close(reservation);
  const origin = `https://127.0.0.1:${port}`;
  if (env.deviceListener) env.deviceListener = { ...env.deviceListener, port, hints: [origin] };
  const home = {
    certificate: material.certificate,
    certificateFingerprint,
    privateKeyCiphertext: "v2:nonfunctional-fixture",
    instanceId: "fixture-home",
  } as Parameters<typeof createServerDeviceListener>[1];
  const secrets = { load: vi.fn(() => material.privateKey) };
  const listener = createServerDeviceListener(env, home, secrets);
  listeners.push(listener);
  return { listener, env, origin, port, apiPort, received, secrets };
}

it("opens no socket or pairing address by default", async () => {
  const f = await fixture(false);
  await f.listener.start();
  expect(f.env.deviceListener).toBeUndefined();
  expect(f.listener.state()).toEqual({ enabled: false, hints: [] });
  expect(f.secrets.load).not.toHaveBeenCalled();
  await expect(
    pinnedPost(`${f.origin}/device/request`, certificateFingerprint, {}),
  ).rejects.toThrow();
});

it("uses the loopback default and accepts the saved pin on every device route", async () => {
  const f = await fixture();
  expect(f.env.port).toBe(f.apiPort);
  expect(f.env.deviceListener?.bind).toBe("127.0.0.1");
  await f.listener.start();
  expect(f.listener.state()).toEqual({ enabled: true, hints: [f.origin] });
  for (const path of DEVICE_API_PATHS) {
    await expect(
      pinnedPost(`${f.origin}${path}`, certificateFingerprint, { fixture: true }),
    ).resolves.toEqual({ ok: true });
  }
  expect(f.received.mock.calls.map(([path]) => path)).toEqual([...DEVICE_API_PATHS]);
});

it("refuses a wrong pin before sending any HTTP request", async () => {
  const f = await fixture();
  await f.listener.start();
  await expect(
    pinnedPost(`${f.origin}/device/request`, "0".repeat(64), { fixture: true }),
  ).rejects.toThrow(HOME_CHANGED);
  expect(f.received).not.toHaveBeenCalled();
});

// These negative boundary probes intentionally inspect raw HTTP status over fixture TLS.
function status(origin: string, path: string, method = "POST", headers = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      `${origin}${path}`,
      { method, headers, rejectUnauthorized: false, agent: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      },
    );
    req.once("error", reject);
    req.end("{}");
  });
}

it("returns 404 for RPC, local keys, auth, non-device paths and non-POST requests", async () => {
  const f = await fixture();
  await f.listener.start();
  for (const path of [
    "/",
    "/rpc",
    "/rpc/me",
    "/local/device-listener",
    "/local/device-listener-state",
    "/api/auth/session",
    "/device/request?path=/rpc/me",
    "/device/%72equest",
  ]) {
    expect(await status(f.origin, path)).toBe(404);
  }
  expect(await status(f.origin, "/device/request", "GET")).toBe(404);
  expect(f.received).not.toHaveBeenCalled();
});

it("strips stack tokens, session cookies and authorization before forwarding", async () => {
  const f = await fixture();
  await f.listener.start();
  expect(
    await status(f.origin, "/device/request", "POST", {
      cookie: "nonfunctional-fixture-cookie",
      authorization: "Bearer nonfunctional-fixture-token",
      "x-ardurbot-local-settings-token": "nonfunctional-fixture-stack-token",
    }),
  ).toBe(200);
  const headers = f.received.mock.calls[0]![1];
  expect(headers["content-type"]).toBe("application/json");
  expect(headers.cookie).toBeUndefined();
  expect(headers.authorization).toBeUndefined();
  expect(headers["x-ardurbot-local-settings-token"]).toBeUndefined();
});

it("closes WebSocket upgrades without forwarding them", async () => {
  const f = await fixture();
  await f.listener.start();
  const socket = connect({ host: "127.0.0.1", port: f.port, rejectUnauthorized: false });
  const received = vi.fn();
  socket.on("data", received);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", () => resolve());
      socket.once("secureConnect", () =>
        socket.write(
          "GET /device/request HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      );
    });
    expect(received).not.toHaveBeenCalled();
    expect(f.received).not.toHaveBeenCalled();
  } finally {
    socket.destroy();
  }
});

it("reports an occupied device port and publishes no pairing address", async () => {
  const f = await fixture();
  f.env.deviceListener!.port = f.apiPort;
  await expect(f.listener.start()).rejects.toThrow(
    `Device HTTPS listener cannot start: 127.0.0.1:${f.apiPort} is already in use.`,
  );
  expect(f.listener.state()).toEqual({ enabled: false, hints: [] });
});

it("closes idle TLS connections and releases the listener port on shutdown", async () => {
  const f = await fixture();
  await f.listener.start();
  const socket = connect({ host: "127.0.0.1", port: f.port, rejectUnauthorized: false });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    socket.resume();
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await f.listener.stop();
    await closed;
    expect(f.listener.state()).toEqual({ enabled: false, hints: [] });
    await expect(
      pinnedPost(`${f.origin}/device/request`, certificateFingerprint, {}),
    ).rejects.toThrow();
    await f.listener.start();
    await expect(
      pinnedPost(`${f.origin}/device/request`, certificateFingerprint, {}),
    ).resolves.toEqual({ ok: true });
  } finally {
    socket.destroy();
  }
});
