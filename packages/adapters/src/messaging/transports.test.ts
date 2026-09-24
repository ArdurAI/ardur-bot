import type { ChatInstallationInput } from "@ardurbot/contracts";
import { ChatInstallationInputSchema } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { discordEvent, discordTransport } from "./discord.js";
import discord from "./fixtures/discord.json" with { type: "json" };
import slack from "./fixtures/slack.json" with { type: "json" };
import telegram from "./fixtures/telegram.json" with { type: "json" };
import { slackEvent, slackSocketTransport } from "./slack-socket.js";
import { telegramEvent, telegramTransport } from "./telegram-polling.js";
import type { ReceiverContext, ReceiverState, TransportIO } from "./transport.js";
import { chatChunks, ProviderResponseError, request, socketSession } from "./transport.js";

const config: ChatInstallationInput = {
  provider: "telegram",
  botToken: "nonfunctional-placeholder",
  workspaceId: "telegram",
  botId: "bot",
};
const destination = { workspaceId: "workspace", channelId: "channel" };
class Socket extends EventTarget {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  send(body: string) {
    this.sent.push(JSON.parse(body));
  }
  message(data: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
  }
  close(code = 4000) {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}
function ioFixture() {
  const sockets: Socket[] = [];
  const io: TransportIO = {
    fetch: vi.fn<typeof fetch>(),
    sleep: vi.fn(async () => undefined),
    socket: vi.fn(() => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    }),
  };
  const abort = new AbortController();
  let state: ReceiverState = {};
  const context: ReceiverContext = {
    signal: abort.signal,
    load: async () => state,
    save: vi.fn(async (next) => {
      state = { ...next };
    }),
    accept: vi.fn(async () => undefined),
  };
  return { io, sockets, context, abort, state: () => state, fetch: vi.mocked(io.fetch) };
}
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });

describe("offline transport fixtures", () => {
  it("normalizes immutable senders and rejects malformed or automated senders", () => {
    expect(telegramEvent(telegram)).toMatchObject({
      eventId: "41",
      senderId: "101",
      private: true,
    });
    expect(discordEvent(discord)).toMatchObject({
      eventId: "message-1",
      workspaceId: "guild-1",
      senderId: "sender-1",
    });
    expect(slackEvent(slack)).toMatchObject({ eventId: "event-1", workspaceId: "team-1" });
    for (const parser of [telegramEvent, discordEvent, slackEvent])
      expect(parser({ broken: true })).toBeNull();
    expect(
      discordEvent({ ...discord, d: { ...discord.d, author: { id: "sender", bot: true } } }),
    ).toBeNull();
  });
  it("requires a secret only for a configured webhook and requires Slack's app token", () => {
    expect(ChatInstallationInputSchema.safeParse(config).success).toBe(true);
    expect(
      ChatInstallationInputSchema.safeParse({
        ...config,
        webhookUrl: "https://example.test/webhook",
      }).success,
    ).toBe(false);
    expect(ChatInstallationInputSchema.safeParse({ ...config, provider: "slack" }).success).toBe(
      false,
    );
  });
  it("persists Telegram offsets after durable acceptance and resumes without replay", async () => {
    const f = ioFixture();
    f.fetch
      .mockResolvedValueOnce(json({ ok: true, result: { url: "" } }))
      .mockResolvedValueOnce(json({ ok: true, result: [telegram] }))
      .mockImplementationOnce(async () => {
        f.abort.abort();
        return json({ ok: true, result: [] });
      });
    await telegramTransport(config, f.io).receive(f.context);
    expect(f.state()).toEqual({ offset: 42 });
    expect(f.context.accept).toHaveBeenCalledOnce();
    const again = new AbortController();
    f.fetch
      .mockResolvedValueOnce(json({ ok: true, result: { url: "" } }))
      .mockImplementationOnce(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).offset).toBe(42);
        again.abort();
        return json({ ok: true, result: [] });
      });
    await telegramTransport(config, f.io).receive({ ...f.context, signal: again.signal });
    expect(f.context.accept).toHaveBeenCalledOnce();
  });
  it("does not consume updates or advance the offset if admission fails", async () => {
    const f = ioFixture();
    f.fetch
      .mockResolvedValueOnce(json({ ok: true, result: { url: "" } }))
      .mockResolvedValueOnce(json({ ok: true, result: [telegram] }));
    f.context.accept = vi.fn(async () => {
      throw new Error("Database unavailable");
    });
    await expect(telegramTransport(config, f.io).receive(f.context)).rejects.toThrow();
    expect(f.context.save).not.toHaveBeenCalled();
  });
  it("never polls when Telegram reports a webhook", async () => {
    const f = ioFixture();
    f.fetch.mockResolvedValue(json({ ok: true, result: { url: "https://example.test/webhook" } }));
    await telegramTransport(config, f.io).receive(f.context);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("falls back to plain text only after an explicit Markdown rejection", async () => {
    const f = ioFixture();
    f.fetch
      .mockResolvedValueOnce(json({ ok: false, description: "Cannot parse entities" }, 400))
      .mockResolvedValueOnce(json({ ok: true, result: { message_id: 10 } }));
    expect(
      await telegramTransport(config, f.io).send(
        destination,
        { text: "An answer." },
        f.abort.signal,
      ),
    ).toBe("10");
    expect(JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body)).parse_mode).toBe("MarkdownV2");
    expect(JSON.parse(String(f.fetch.mock.calls[1]?.[1]?.body)).parse_mode).toBeUndefined();
  });
  it("preserves fenced code in Telegram MarkdownV2 while escaping ordinary punctuation", async () => {
    const f = ioFixture();
    f.fetch.mockResolvedValue(json({ ok: true, result: { message_id: 10 } }));
    await telegramTransport(config, f.io).send(
      destination,
      { text: "Result.\n```ts\nconst value = 1;\n```" },
      f.abort.signal,
    );
    const body = JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body));
    expect(body.text).toBe("Result\\.\n```ts\nconst value = 1;\n```");
  });
  it("resumes Discord after disconnect using the last committed sequence", async () => {
    const f = ioFixture();
    const transport = discordTransport({ ...config, provider: "discord" }, f.io);
    const first = transport.receive(f.context);
    await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
    f.sockets[0]!.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    f.sockets[0]!.message({
      op: 0,
      s: 11,
      t: "READY",
      d: { session_id: "fixture-session", resume_gateway_url: "wss://gateway.discord.gg" },
    });
    f.sockets[0]!.message(discord);
    await vi.waitFor(() => expect(f.state().sequence).toBe(12));
    f.sockets[0]!.close();
    await first;
    const next = transport.receive(f.context);
    await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
    f.sockets[1]!.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await vi.waitFor(() =>
      expect(f.sockets[1]!.sent[0]).toMatchObject({
        op: 6,
        d: { session_id: "fixture-session", seq: 12 },
      }),
    );
    f.abort.abort();
    await next;
  });
  it("clears an invalid Discord session and identifies again", async () => {
    const f = ioFixture();
    const run = discordTransport(config, f.io).receive(f.context);
    await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
    f.sockets[0]!.message({ op: 9, d: false });
    await run;
    expect(f.state()).toEqual({});
  });
  it("acknowledges Slack envelopes only after durable admission", async () => {
    const f = ioFixture();
    f.fetch.mockResolvedValue(json({ ok: true, url: "wss://wss-primary.slack.com/link" }));
    let accept: (() => void) | undefined;
    f.context.accept = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const running = slackSocketTransport({ ...config, appToken: "placeholder" }, f.io).receive(
      f.context,
    );
    await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
    f.sockets[0]!.message(slack);
    await vi.waitFor(() => expect(accept).toBeDefined());
    expect(f.sockets[0]!.sent).toEqual([]);
    accept!();
    await vi.waitFor(() => expect(f.sockets[0]!.sent).toEqual([{ envelope_id: "envelope-1" }]));
    f.abort.abort();
    await running;
  });
  it("closes a WebSocket on queue overflow and drains during shutdown", async () => {
    const f = ioFixture();
    const running = socketSession(
      f.io,
      "wss://example.test",
      f.abort.signal,
      async () => undefined,
    );
    const rejected = expect(running).rejects.toThrow("closed");
    for (let i = 0; i < 65; i++) f.sockets[0]!.message({ i });
    await rejected;
    expect(f.sockets[0]!.closed).toBe(true);
  });
  it.each([2000, 4096])("chunks Unicode and closes/reopens code fences below %i", (limit) => {
    const chunks = chatChunks(
      `Intro\n\`\`\`ts\n${"😀 const x = 1;\n".repeat(1000)}\`\`\`\nEnd`,
      limit,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(Buffer.from(chunk).toString("utf8")).toBe(chunk);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
  it.each([
    { error_code: 429, parameters: { retry_after: 2 } },
    { retry_after: 1.5 },
    { ok: false, error: "ratelimited" },
  ])("obeys provider rate-limit feedback", async (body) => {
    const f = ioFixture();
    f.fetch
      .mockResolvedValueOnce(json(body, 429, { "retry-after": "3" }))
      .mockResolvedValueOnce(json({ ok: true }));
    await request(f.io, "https://example.test", undefined, {}, f.abort.signal);
    expect(f.io.sleep).toHaveBeenCalledWith(
      "parameters" in body ? 2000 : "retry_after" in body ? 1500 : 3000,
      f.abort.signal,
    );
  });
  it("returns long RetryAfter for durable scheduling without retrying early", async () => {
    const f = ioFixture();
    f.fetch.mockResolvedValue(json({ retry_after: 120 }, 429));
    await expect(
      request(f.io, "https://example.test", undefined, {}, f.abort.signal),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    expect(f.io.sleep).not.toHaveBeenCalled();
  });
  it("does not resend acknowledged chunks on an outbox retry", async () => {
    const f = ioFixture();
    f.fetch.mockResolvedValue(json({ id: "second" }));
    const checkpoint = {
      sentChunks: 1,
      firstMessageId: "first",
      sent: vi.fn(async () => undefined),
    };
    expect(
      await discordTransport(config, f.io).send(
        destination,
        { text: "a".repeat(2500) },
        f.abort.signal,
        checkpoint,
      ),
    ).toBe("first");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(checkpoint.sent).toHaveBeenCalledWith(1, "second");
  });
  it("never includes a failed request URL or token in a transport error", async () => {
    const f = ioFixture();
    f.fetch.mockRejectedValue(new Error("sensitive transport URL"));
    await expect(
      request(f.io, "https://example.test", "placeholder", {}, f.abort.signal),
    ).rejects.toEqual(new ProviderResponseError(0));
  });
});
