import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ receive: vi.fn(async () => undefined) }));
vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  createMessagingDispatch: () => ({ receive: calls.receive }),
  MessagingInstallationSettings: class {
    load(row: { config: unknown }) {
      return row.config;
    }
  },
}));

import telegram from "../../../packages/adapters/src/messaging/fixtures/telegram.json" with {
  type: "json",
};
import { createLegacyChatDispatch, mountMessagingDispatch } from "./messaging-dispatch.js";

function fixture(webhook = true) {
  calls.receive.mockClear();
  const config = {
    webhookUrl: webhook ? "https://example.test/api/v1/messaging/webhook/telegram" : undefined,
    webhookSecret: "nonfunctional-webhook-placeholder",
  };
  const prisma = {
    chatInstallation: { findMany: vi.fn(async () => [{ id: "installation", config }]) },
  } as unknown as PrismaClient;
  const app = new Hono();
  mountMessagingDispatch(app, {
    prisma,
    secrets: {} as EncryptedSecretStore,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
  });
  const send = (secret?: string, body = JSON.stringify(telegram)) =>
    app.request("/api/v1/messaging/webhook/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      },
      body,
    });
  return { send, config };
}
describe("authenticated Telegram webhook admission", () => {
  it("accepts a verified fixture on the existing webhook URL", async () => {
    const f = fixture();
    expect((await f.send(f.config.webhookSecret)).status).toBe(200);
    expect(calls.receive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "installation" }),
      expect.objectContaining({ senderId: "101", provider: "telegram" }),
      expect.any(Array),
    );
  });
  it("rejects unsigned and wrong-secret fixtures without running anything", async () => {
    const f = fixture();
    expect((await f.send()).status).toBe(401);
    expect((await f.send("wrong-placeholder")).status).toBe(401);
    expect(calls.receive).not.toHaveBeenCalled();
  });
  it("does not expose an unsigned webhook for polling-only installations", async () => {
    const f = fixture(false);
    expect((await f.send(f.config.webhookSecret)).status).toBe(401);
    expect(calls.receive).not.toHaveBeenCalled();
  });
  it("rejects malformed fixtures after authentication", async () => {
    const f = fixture();
    expect((await f.send(f.config.webhookSecret, "{")).status).toBe(400);
    expect((await f.send(f.config.webhookSecret, "{}")).status).toBe(400);
    expect(calls.receive).not.toHaveBeenCalled();
  });
});

it("a legacy Slack webhook for a paired installation uses the same provider event ID and never falls through", async () => {
  calls.receive.mockClear();
  const prisma = {
    chatInstallation: {
      findMany: vi.fn(async () => [{ id: "installation", config: { botToken: "placeholder" } }]),
    },
  } as unknown as PrismaClient;
  const handler = createLegacyChatDispatch(
    {
      prisma,
      secrets: {} as EncryptedSecretStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    },
    "placeholder",
  );
  const event = {
    type: "message" as const,
    provider: "slack",
    handle: "timestamp",
    providerEventId: "provider-event",
    threadId: "opaque-thread",
    isDirect: false,
    from: "sender",
    fromLabel: "Display",
    channelName: "Channel",
    participants: [],
    content: "Question",
    mediaUrl: null,
    workspaceId: "team",
    conversationKey: "channel",
  };
  expect(await handler(event)).toBe(true);
  expect(calls.receive).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ eventId: "provider-event", senderId: "sender", workspaceId: "team" }),
    ["placeholder"],
  );
  calls.receive.mockClear();
  expect(await handler({ ...event, providerEventId: undefined })).toBe(true);
  expect(calls.receive).not.toHaveBeenCalled();
});
