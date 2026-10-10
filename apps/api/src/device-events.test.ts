import { generateKeyPairSync, sign } from "node:crypto";
import type { DeviceEventsInput, ProductEvent } from "@ardurbot/contracts";
import { DeviceEventsInputSchema, deviceSignedText } from "@ardurbot/contracts";
import type { DeviceGrant, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEVICE_EVENT_STREAM_LIMIT_MESSAGE,
  deviceRunEvents,
  getOpenDeviceEventWindows,
  MAX_DEVICE_EVENT_WINDOWS_PER_GRANT,
  resetDeviceEventWindows,
} from "./device-events.js";
import { mountRemoteDevices } from "./remote-devices.js";
import { resolveThreadTarget } from "./thread-target.js";

vi.mock("./thread-target.js", () => ({ resolveThreadTarget: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  resetDeviceEventWindows();
});
function fixture() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const grant = {
    id: "device",
    instanceId: "home",
    userId: "user",
    spaceId: "space",
    kind: "device",
    scopes: ["read"],
    revokedAt: null,
    devicePublicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  } as DeviceGrant;
  const run = {
    id: "run",
    taskId: "task",
    botId: "bot",
    threadId: "thread",
    userId: "user",
    spaceId: "space",
    trigger: "user",
  };
  const receipt = { runId: "run", taskId: "task", botId: "bot", threadId: "thread" };
  const mocks = {
    instanceIdentity: { findUniqueOrThrow: vi.fn(async () => ({ instanceId: "home" })) },
    deviceGrant: {
      findFirst: vi.fn(async () => grant),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member" })) },
    dispatchReceipt: { findFirst: vi.fn(async () => receipt) },
    run: { findFirst: vi.fn(async () => run), findUnique: vi.fn(async () => run) },
    thread: { findFirst: vi.fn(async () => ({ nextEventSeq: 20 })) },
    deviceNonce: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    ...mocks,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(mocks),
  } as unknown as PrismaClient;
  const target = { kind: "bot", threadId: "thread", botId: "bot" };
  vi.mocked(resolveThreadTarget).mockResolvedValue(target as never);
  const rows: ProductEvent[] = [];
  const stopped = vi.fn();
  const events = {
    follow: vi.fn(async function* () {
      try {
        yield* rows;
      } finally {
        stopped();
      }
    }),
  } as unknown as ThreadEvents;
  const input: DeviceEventsInput = { runId: "run", threadId: "thread", botId: "bot", cursor: -1 };
  const app = new Hono();
  mountRemoteDevices(app, { prisma, events, jobs: {} as never, read: vi.fn() });
  const signed = (body: unknown) => {
    const proof = {
      grantId: grant.id,
      nonce: "n".repeat(43),
      timestamp: Date.now(),
      signature: "",
    };
    proof.signature = sign(
      "sha256",
      Buffer.from(deviceSignedText("home", proof, "events", body)),
      keys.privateKey,
    ).toString("base64");
    return { operation: "events", body, proof };
  };
  const call = (body: unknown) =>
    app.request("/device/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { grant, mocks, deps: { prisma, events }, input, rows, stopped, target, signed, call };
}
const row = (seq: number, changes: Partial<ProductEvent> = {}): ProductEvent => ({
  id: `event-${seq}`,
  seq,
  type: "thread.progress",
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  runId: "run",
  createdAt: "2026-10-01T00:00:00.000Z",
  payload: { text: "fixture" },
  ...changes,
});

it("authenticates the signed operation and follows only its run with existing peer filtering", async () => {
  const f = fixture();
  f.rows.push(
    row(1, { runId: "other-run" }),
    row(2, { threadId: "other-thread" }),
    row(3, { spaceId: "other-space" }),
    row(4),
  );
  const response = await f.call(f.signed(f.input));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text.match(/^id: /gm)).toHaveLength(1);
  expect(text).toContain("id: 4\n");
  expect(text).not.toContain("other-");
  expect(f.mocks.dispatchReceipt.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { instanceId: "home", spaceId: "space", deviceGrantId: "device", runId: "run" },
    }),
  );
  expect(f.mocks.run.findFirst).toHaveBeenCalledWith({
    where: {
      spaceId: "space",
      userId: "user",
      id: "run",
      taskId: "task",
      botId: "bot",
      threadId: "thread",
    },
  });
});
it("uses the thread follower's peer projection and advances past hidden peer activity", async () => {
  const f = fixture();
  f.mocks.run.findUnique.mockResolvedValue({
    ...(await f.mocks.run.findFirst()),
    trigger: "bot_message",
  });
  f.rows.push(row(1), row(3, { type: "run.completed" }));
  const text = await (await deviceRunEvents(f.deps, f.grant, f.input)).text();
  expect(text).not.toContain("id: 1\n");
  expect(text).toContain("id: 3\n");
});
it.each(["runId", "threadId", "botId", "cursor"] as const)(
  "rejects a changed signed %s",
  async (key) => {
    const f = fixture();
    const request = f.signed(f.input);
    request.body = { ...f.input, [key]: key === "cursor" ? 4 : "other" };
    expect((await f.call(request)).status).toBe(401);
    expect(f.deps.events.follow).not.toHaveBeenCalled();
  },
);
it("refuses replayed nonces and missing read scope", async () => {
  const f = fixture();
  f.mocks.deviceNonce.updateMany.mockResolvedValueOnce({ count: 0 });
  expect((await f.call(f.signed(f.input))).status).toBe(401);
  f.grant.scopes = [];
  expect((await f.call(f.signed(f.input))).status).toBe(403);
});
it.each([
  "receipt",
  "run",
  "member",
  "grant",
  "thread",
  "target",
  "run-thread",
  "run-bot",
  "ahead-cursor",
])("denies unavailable %s before following", async (kind) => {
  const f = fixture();
  if (kind === "receipt") f.mocks.dispatchReceipt.findFirst.mockResolvedValue(null as never);
  if (kind === "run") f.mocks.run.findFirst.mockResolvedValue(null as never);
  if (kind === "member") f.mocks.spaceMember.findUnique.mockResolvedValue(null as never);
  if (kind === "grant") f.mocks.deviceGrant.findFirst.mockResolvedValue(null as never);
  if (kind === "thread") f.mocks.thread.findFirst.mockResolvedValue(null as never);
  if (kind === "target")
    vi.mocked(resolveThreadTarget).mockRejectedValue(new Error("private target"));
  if (kind === "run-thread") (await f.mocks.run.findFirst()).threadId = "other-thread";
  if (kind === "run-bot") (await f.mocks.run.findFirst()).botId = "other-bot";
  if (kind === "ahead-cursor") f.input.cursor = 21;
  await expect(deviceRunEvents(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
  expect(f.deps.events.follow).not.toHaveBeenCalled();
});
it("checks room membership and exact room thread rather than accepting a bot receipt elsewhere", async () => {
  const f = fixture();
  const input = { runId: "run", threadId: "thread", groupId: "room", cursor: -1 };
  vi.mocked(resolveThreadTarget).mockResolvedValue({
    kind: "group",
    threadId: "thread",
    memberBotIds: [],
  } as never);
  await expect(deviceRunEvents(f.deps, f.grant, input)).rejects.toMatchObject({ status: 403 });
  vi.mocked(resolveThreadTarget).mockResolvedValue({
    kind: "group",
    threadId: "other-thread",
    memberBotIds: ["bot"],
  } as never);
  await expect(deviceRunEvents(f.deps, f.grant, input)).rejects.toMatchObject({ status: 403 });
});
it.each([
  { cursor: -2 },
  { cursor: 1.5 },
  { cursor: 2_147_483_648 },
  { groupId: "room" },
  { botId: undefined },
  { extra: true },
])("rejects invalid or ambiguous signed bodies %j", (changes) => {
  expect(
    DeviceEventsInputSchema.safeParse({
      runId: "run",
      threadId: "thread",
      botId: "bot",
      ...changes,
    }).success,
  ).toBe(false);
});

it("enforces the concurrent event window cap per grant and rejects over-limit requests with 429", async () => {
  const f = fixture();
  f.deps.events.follow = vi.fn(async function* (
    _threadId: string,
    _cursor: number,
    signal?: AbortSignal,
  ) {
    yield row(1);
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });

  const streams: Response[] = [];
  for (let i = 0; i < MAX_DEVICE_EVENT_WINDOWS_PER_GRANT; i++) {
    const res = await f.call(f.signed(f.input));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    streams.push(res);
  }
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT);

  // 5th request for the same grant exceeds the cap and receives 429 with { message, problem } shape.
  const overLimit = await f.call(f.signed(f.input));
  expect(overLimit.status).toBe(429);
  expect(await overLimit.json()).toEqual({
    message: DEVICE_EVENT_STREAM_LIMIT_MESSAGE,
    problem: {
      code: "stream_limit",
      message: DEVICE_EVENT_STREAM_LIMIT_MESSAGE,
    },
  });

  // Calling deviceRunEvents directly also throws DeviceRequestError with 429 and problem.
  await expect(deviceRunEvents(f.deps, f.grant, f.input)).rejects.toMatchObject({
    status: 429,
    message: DEVICE_EVENT_STREAM_LIMIT_MESSAGE,
    problem: { code: "stream_limit", message: DEVICE_EVENT_STREAM_LIMIT_MESSAGE },
  });

  // A different grant is independent and can open its own event window.
  const otherKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const otherGrant: DeviceGrant = {
    ...f.grant,
    id: "other-device-grant",
    devicePublicKey: otherKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const otherRes = await deviceRunEvents(f.deps, otherGrant, f.input);
  expect(otherRes.status).toBe(200);
  expect(getOpenDeviceEventWindows("other-device-grant")).toBe(1);
  await otherRes.body?.cancel();
  expect(getOpenDeviceEventWindows("other-device-grant")).toBe(0);

  // Clean up open streams
  for (const s of streams) {
    await s.body?.cancel();
  }
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(0);
});

it("frees a slot when an open event window ends", async () => {
  const f = fixture();
  f.deps.events.follow = vi.fn(async function* (
    _threadId: string,
    _cursor: number,
    signal?: AbortSignal,
  ) {
    yield row(1);
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });

  const streams: Response[] = [];
  for (let i = 0; i < MAX_DEVICE_EVENT_WINDOWS_PER_GRANT; i++) {
    const res = await f.call(f.signed(f.input));
    expect(res.status).toBe(200);
    streams.push(res);
  }
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT);

  // 5th fails with 429
  expect((await f.call(f.signed(f.input))).status).toBe(429);

  // Cancel one stream to end it
  await streams[0]!.body?.cancel();
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT - 1);

  // Now a new stream can be opened
  const newStream = await f.call(f.signed(f.input));
  expect(newStream.status).toBe(200);
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT);

  // Clean up
  await newStream.body?.cancel();
  for (let i = 1; i < streams.length; i++) {
    await streams[i]!.body?.cancel();
  }
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(0);
});

it("frees a slot when an open event window crashes", async () => {
  const f = fixture();
  let streamCount = 0;
  f.deps.events.follow = vi.fn(async function* (
    _threadId: string,
    _cursor: number,
    signal?: AbortSignal,
  ) {
    const streamIndex = streamCount++;
    yield row(1);
    if (streamIndex === 0) {
      throw new Error("simulated crash");
    }
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });

  const streams: Response[] = [];
  for (let i = 0; i < MAX_DEVICE_EVENT_WINDOWS_PER_GRANT; i++) {
    const res = await f.call(f.signed(f.input));
    expect(res.status).toBe(200);
    streams.push(res);
  }
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT);

  // 5th fails with 429
  expect((await f.call(f.signed(f.input))).status).toBe(429);

  // Read from stream 0: first read gets row(1), second read triggers the crash in pull()
  const reader = streams[0]!.body!.getReader();
  await reader.read(); // gets row(1)
  const second = await reader.read(); // pull catches throw, finishes with "error"
  expect(new TextDecoder().decode(second.value)).toContain('"reason":"error"');
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT - 1);

  // Opening another window succeeds
  const newStream = await f.call(f.signed(f.input));
  expect(newStream.status).toBe(200);
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(MAX_DEVICE_EVENT_WINDOWS_PER_GRANT);

  // Clean up
  await newStream.body?.cancel();
  for (let i = 1; i < streams.length; i++) {
    await streams[i]!.body?.cancel();
  }
  expect(getOpenDeviceEventWindows(f.grant.id)).toBe(0);
});
