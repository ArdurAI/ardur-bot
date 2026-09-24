import { EventEmitter } from "node:events";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { MessagingInstallationSettings, ReceiverContext } from "@ardurbot/adapters";
import type { Pool, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  receive: vi.fn(),
  consume: vi.fn(async () => undefined),
  deliver: vi.fn(async () => undefined),
  notifications: vi.fn(async () => undefined),
  accept: vi.fn(async () => undefined),
}));
vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  createChatTransport: () => ({ receive: calls.receive }),
  createMessagingDispatch: () => ({ notifications: calls.notifications, receive: calls.accept }),
  drainChatInbox: calls.consume,
  deliverChatOutbox: calls.deliver,
}));

import { createMessagingReceivers } from "./messaging-receivers.js";

function fixture() {
  vi.clearAllMocks();
  calls.receive.mockImplementation(
    (context: ReceiverContext) =>
      new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  let locked = false;
  const clients: Array<
    EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  > = [];
  const pool = {
    connect: vi.fn(async () => {
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(async (query: string) => {
          if (query.includes("unlock")) {
            locked = false;
            return { rows: [] };
          }
          if (locked) return { rows: [{ acquired: false }] };
          locked = true;
          return { rows: [{ acquired: true }] };
        }),
        release: vi.fn(),
      });
      clients.push(client);
      return client;
    }),
  };
  const prisma = {
    chatOutbox: { updateMany: vi.fn() },
    chatInstallation: { findMany: vi.fn(async () => [{ id: "installation", revision: 1 }]) },
    messagingReceiverState: {
      findUnique: vi.fn(async () => ({ state: { offset: 42 } })),
      upsert: vi.fn(),
    },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    pool: pool as unknown as Pool,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    settings: {
      load: () => ({ provider: "telegram", botToken: "placeholder" }),
    } as unknown as MessagingInstallationSettings,
  };
  return { deps, clients, prisma };
}
describe("worker messaging lifecycle", () => {
  it("starts once, restores durable state, and stops all receiver work before releasing leadership", async () => {
    const f = fixture();
    const manager = createMessagingReceivers(f.deps);
    manager.start();
    manager.start();
    await vi.waitFor(() => expect(calls.receive).toHaveBeenCalledOnce());
    const context = calls.receive.mock.calls[0]![0] as ReceiverContext;
    expect(await context.load()).toEqual({ offset: 42 });
    await context.save({ offset: 43 });
    expect(f.prisma.messagingReceiverState.upsert).toHaveBeenCalled();
    await manager.stop();
    await manager.stop();
    expect(context.signal.aborted).toBe(true);
    expect(f.clients[0]?.release).toHaveBeenCalledOnce();
  });
  it("elects only one receiver across two workers", async () => {
    const f = fixture();
    const first = createMessagingReceivers(f.deps);
    const second = createMessagingReceivers(f.deps);
    first.start();
    second.start();
    await vi.waitFor(() => expect(f.clients).toHaveLength(2));
    await vi.waitFor(() => expect(calls.receive).toHaveBeenCalledOnce());
    await Promise.all([first.stop(), second.stop()]);
  });
  it("aborts active sockets immediately if the leadership connection is lost", async () => {
    const f = fixture();
    const manager = createMessagingReceivers(f.deps);
    manager.start();
    await vi.waitFor(() => expect(calls.receive).toHaveBeenCalledOnce());
    const context = calls.receive.mock.calls[0]![0] as ReceiverContext;
    f.clients[0]!.emit("error", new Error("Disconnected"));
    expect(context.signal.aborted).toBe(true);
    await manager.stop();
  });
});
