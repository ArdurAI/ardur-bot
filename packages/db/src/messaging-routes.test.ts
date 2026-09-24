import type { ChatEvent } from "@ardurbot/contracts";
import { CHAT_COPY } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { acceptChatEvent, enqueueChat, findChatReplyTask } from "./messaging-routes.js";

const event: ChatEvent = {
  provider: "telegram",
  workspaceId: "telegram",
  senderId: "sender",
  channelId: "channel",
  messageId: "message",
  eventId: "event",
  private: true,
  text: "Do the work",
  attachmentBytes: 0,
  attachmentCount: 0,
};
function fixture() {
  const inbox = new Map<string, { fingerprint: string }>();
  const tx = {
    $queryRaw: vi.fn(),
    chatInbox: {
      findUnique: vi.fn(
        async ({ where }) => inbox.get(where.installationId_eventId.eventId) ?? null,
      ),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => inbox.set(data.eventId, data)),
    },
    chatOutbox: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: vi.fn(),
      findMany: vi.fn(async () => [{ taskId: "task" }]),
    },
    messagingTaskOrigin: { findFirst: vi.fn(async () => ({ taskId: "task" })) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return { db, tx };
}
describe("durable chat ingress and routes", () => {
  it("deduplicates provider events across receiver restarts and rejects changed payloads", async () => {
    const f = fixture();
    await acceptChatEvent(f.db, "installation", event);
    await acceptChatEvent(f.db, "installation", { ...event });
    expect(f.tx.chatInbox.create).toHaveBeenCalledOnce();
    await expect(
      acceptChatEvent(f.db, "installation", { ...event, text: "Different" }),
    ).rejects.toThrow("changed");
  });
  it("never persists credential-like content, even through the rejection destination", async () => {
    const f = fixture();
    const pasted = "password=not-a-real-secret";
    await acceptChatEvent(f.db, "installation", { ...event, text: pasted });
    expect(f.tx.chatInbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: {}, consumedAt: expect.any(Date) }),
    });
    expect(JSON.stringify(f.tx.chatInbox.create.mock.calls)).not.toContain(pasted);
    expect(JSON.stringify(f.tx.chatOutbox.upsert.mock.calls)).not.toContain(pasted);
    expect(f.tx.chatOutbox.upsert.mock.calls[0]?.[0].create.card).toEqual({
      text: CHAT_COPY.secrets,
    });
  });
  it("rejects attachments before storing content and bounds pending admission", async () => {
    const f = fixture();
    await acceptChatEvent(f.db, "installation", {
      ...event,
      attachmentCount: 1,
      attachmentBytes: 100_000_000,
    });
    expect(f.tx.chatInbox.create.mock.calls[0]?.[0].data.event).toEqual({});
    f.tx.chatInbox.count.mockResolvedValueOnce(256);
    await expect(
      acceptChatEvent(f.db, "installation", { ...event, eventId: "next" }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it("redacts a secret-bearing result before it enters the outbox", async () => {
    const f = fixture();
    await enqueueChat(f.db, {
      key: "summary",
      installationId: "installation",
      destination: event,
      card: { text: "api_key=not-a-real-key" },
    });
    expect(f.tx.chatOutbox.upsert.mock.calls[0]?.[0].create.card).toEqual({
      text: CHAT_COPY.secrets,
    });
  });
  it("reply mapping requires the original sender, channel and workspace", async () => {
    const f = fixture();
    await findChatReplyTask(f.db, "installation", "grant", { ...event, replyTo: "receipt" });
    expect(f.tx.messagingTaskOrigin.findFirst).toHaveBeenCalledWith({
      where: {
        installationId: "installation",
        grantId: "grant",
        taskId: { in: ["task"] },
        channelId: "channel",
        workspaceId: "telegram",
      },
    });
  });
});
