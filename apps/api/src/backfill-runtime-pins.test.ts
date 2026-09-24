import { listPiCatalog } from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { redactBindings } from "@ardurbot/logging";
import { describe, expect, it, vi } from "vitest";
import { resolveRunModelPin } from "../../../packages/adapters/src/run-model-pin.js";
import { backfillRuntimePins } from "./backfill-runtime-pins.js";

function fixture() {
  const bot = {
    id: "bot",
    userId: "owner",
    spaceId: "space",
    modelProvider: "xai" as string | null,
    modelId: "grok-4.6",
    modelCredentialId: null as string | null,
    thinkingLevel: null as string | null,
    modelPinRevision: 0,
  };
  const credentials = [
    {
      id: "connection",
      userId: "owner",
      provider: "xai",
      label: "Saved connection",
      secretId: "secret",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ];
  const thread = { id: "thread", botId: bot.id, userId: bot.userId, spaceId: bot.spaceId };
  const matches = (row: object, where: object) =>
    Object.entries(where).every(([key, value]) => {
      const actual = (row as Record<string, unknown>)[key];
      return value && typeof value === "object" && "not" in value
        ? actual !== value.not
        : actual === value;
    });
  const events: object[] = [];
  const messages: object[] = [];
  let seq = 0;
  const tx = {
    bot: {
      findFirst: vi.fn(async ({ where }) => (matches(bot, where) ? { ...bot } : null)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!matches(bot, where)) return { count: 0 };
        Object.assign(bot, data);
        return { count: 1 };
      }),
    },
    userModelCredential: {
      findMany: vi.fn(async ({ where }) => credentials.filter((row) => matches(row, where))),
      findFirst: vi.fn(async ({ where }) => credentials.find((row) => matches(row, where)) ?? null),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
    thread: {
      findFirst: vi.fn(async ({ where }) => (matches(thread, where) ? thread : null)),
      update: vi.fn(async () => ({ nextEventSeq: ++seq, nextMessageSeq: seq })),
    },
    event: {
      create: vi.fn(async ({ data }) => {
        events.push(data);
        return { ...data, id: `event-${seq}` };
      }),
    },
    message: {
      create: vi.fn(async ({ data }) => {
        messages.push(data);
        return { ...data, id: "message" };
      }),
    },
  };
  const findMany = vi.fn(async ({ where }) => (matches(bot, where) ? [{ id: bot.id }] : []));
  const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => {
    const before = { ...bot };
    const eventCount = events.length;
    const messageCount = messages.length;
    try {
      return await run(tx);
    } catch (error) {
      Object.assign(bot, before);
      events.length = eventCount;
      messages.length = messageCount;
      throw error;
    }
  });
  const prisma = {
    ...tx,
    bot: { ...tx.bot, findMany },
    $transaction: transaction,
  } as unknown as PrismaClient;
  const secrets = {
    load: vi.fn(() =>
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://localhost:8080/v1",
        reasoning: true,
        thinkingLevel: "low",
      }),
    ),
  };
  const logger = { info: vi.fn() };
  return { bot, credentials, thread, tx, prisma, secrets, logger, events, messages, transaction };
}

describe("legacy runtime pin backfill", () => {
  it("binds one owner connection, uses catalog effort, and records a visible atomic audit", async () => {
    const f = fixture();
    expect(await backfillRuntimePins(f)).toEqual({
      bound: 1,
      withoutConnection: 0,
      severalConnections: 0,
      skipped: 0,
    });
    expect(f.bot).toMatchObject({
      modelId: "grok-4.6",
      modelCredentialId: "connection",
      thinkingLevel: "medium",
      modelPinRevision: 1,
    });
    expect(f.tx.bot.updateMany).toHaveBeenCalledWith({
      where: {
        id: "bot",
        userId: "owner",
        spaceId: "space",
        modelProvider: "xai",
        modelId: "grok-4.6",
        thinkingLevel: null,
        modelCredentialId: null,
        modelPinRevision: 0,
      },
      data: { modelCredentialId: "connection", thinkingLevel: "medium", modelPinRevision: 1 },
    });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(f.events).toEqual([
      expect.objectContaining({
        type: "bot.pinBackfilled",
        threadId: "thread",
        spaceId: "space",
        payload: {
          pin: {
            provider: "xai",
            modelId: "grok-4.6",
            credentialId: "connection",
            effort: "medium",
            revision: 1,
          },
        },
      }),
      expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ role: "system" }),
      }),
    ]);
    expect(f.messages).toEqual([
      expect.objectContaining({
        role: "system",
        blocks: [
          {
            kind: "text",
            text: "Connection bound to Saved connection for xai · grok-4.6 · medium.",
          },
        ],
      }),
    ]);
    expect(f.secrets.load).not.toHaveBeenCalled();
  });

  it.each(["low", undefined])(
    "recovers custom connection effort %s from owner-scoped metadata",
    async (stored) => {
      const f = fixture();
      f.bot.modelProvider = f.credentials[0]!.provider = "openai-compatible";
      f.bot.modelId = "local-model";
      f.secrets.load.mockReturnValue(
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "http://localhost:8080/v1",
          reasoning: true,
          thinkingLevel: stored,
        }),
      );
      await backfillRuntimePins(f);
      expect(f.bot.thinkingLevel).toBe(stored ?? "medium");
      expect(f.tx.secret.findFirst).toHaveBeenCalledWith({
        where: { id: "secret", userId: "owner", spaceId: null },
      });
      expect(f.tx.spaceModelPreference.findFirst).not.toHaveBeenCalled();
    },
  );

  it("uses off for a non-reasoning catalog model", async () => {
    const f = fixture();
    const entry = listPiCatalog().find((item) => item.reasoning === false)!;
    expect(entry).toBeDefined();
    f.bot.modelProvider = f.credentials[0]!.provider = entry.provider;
    f.bot.modelId = entry.id;
    await backfillRuntimePins(f);
    expect(f.bot.thinkingLevel).toBe("off");
  });

  it("uses the supported catalog default when medium is unavailable", async () => {
    const f = fixture();
    f.bot.modelProvider = f.credentials[0]!.provider = "openrouter";
    f.bot.modelId = "z-ai/glm-5.2";
    await backfillRuntimePins(f);
    expect(f.bot.thinkingLevel).toBe("high");
  });

  it("keeps a saved bot effort even when the connection stores another", async () => {
    const f = fixture();
    f.bot.modelProvider = f.credentials[0]!.provider = "openai-compatible";
    f.bot.thinkingLevel = "high";
    await backfillRuntimePins(f);
    expect(f.bot.thinkingLevel).toBe("high");
    expect(f.secrets.load).not.toHaveBeenCalled();
  });

  it.each([0, 2])("leaves %i-connection rows untouched and counts them", async (count) => {
    const f = fixture();
    if (!count) f.credentials.length = 0;
    else f.credentials.push({ ...f.credentials[0]!, id: "second" });
    const before = { ...f.bot };
    const result = await backfillRuntimePins(f);
    expect(result[count ? "severalConnections" : "withoutConnection"]).toBe(1);
    expect(f.bot).toEqual(before);
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.logger.info).toHaveBeenCalledExactlyOnceWith("runtime pin backfill", result);
    expect(redactBindings(result)).toEqual(result);
  });

  it("does not borrow another user's connection or another space's thread", async () => {
    const f = fixture();
    f.credentials[0]!.userId = "other-owner";
    expect((await backfillRuntimePins(f)).withoutConnection).toBe(1);
    f.credentials.push({ ...f.credentials[0]!, id: "owned", userId: "owner" });
    f.thread.spaceId = "other-space";
    expect((await backfillRuntimePins(f)).skipped).toBe(1);
    f.thread.spaceId = "space";
    await backfillRuntimePins(f);
    expect(f.bot.modelCredentialId).toBe("owned");
  });

  it("is idempotent and competing invocations write one binding and audit", async () => {
    const f = fixture();
    await Promise.all([backfillRuntimePins(f), backfillRuntimePins(f)]);
    await backfillRuntimePins(f);
    expect(f.bot.modelPinRevision).toBe(1);
    expect(f.events).toHaveLength(2);
    expect(f.messages).toHaveLength(1);
  });

  it.each([1, 5])(
    "does not touch revision %i even when its connection is null",
    async (revision) => {
      const f = fixture();
      f.bot.modelPinRevision = revision;
      const before = { ...f.bot };
      await backfillRuntimePins(f);
      expect(f.bot).toEqual(before);
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );

  it("does not touch an already bound connection or a space-default bot", async () => {
    const f = fixture();
    f.bot.modelCredentialId = "chosen";
    await backfillRuntimePins(f);
    f.bot.modelCredentialId = null;
    f.bot.modelProvider = null;
    await backfillRuntimePins(f);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("rechecks eligibility if the owner edits the bot after the scan", async () => {
    const f = fixture();
    f.tx.bot.findFirst.mockImplementationOnce(async () => {
      f.bot.modelPinRevision = 2;
      return null;
    });
    await backfillRuntimePins(f);
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it("leaves no binding when the audit write fails", async () => {
    const f = fixture();
    f.tx.event.create.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(backfillRuntimePins(f)).rejects.toThrow("audit unavailable");
    expect(f.bot).toMatchObject({ modelPinRevision: 0, modelCredentialId: null });
    expect(f.messages).toEqual([]);
    expect((await backfillRuntimePins(f)).bound).toBe(1);
  });

  it("retries a database serialization conflict", async () => {
    const f = fixture();
    f.transaction.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "P2034" }));
    expect((await backfillRuntimePins(f)).bound).toBe(1);
    expect(f.events).toHaveLength(2);
  });

  it("rolls back the binding and audit if its visible message cannot be saved", async () => {
    const f = fixture();
    f.tx.message.create.mockRejectedValueOnce(new Error("message unavailable"));
    await expect(backfillRuntimePins(f)).rejects.toThrow("message unavailable");
    expect(f.bot).toMatchObject({ modelPinRevision: 0, modelCredentialId: null });
    expect(f.events).toEqual([]);
    expect(f.messages).toEqual([]);
  });

  it.each(["queued", "paused"])("resolves a legacy %s run after backfill", async (status) => {
    const f = fixture();
    const run = { status, runtimePin: null, userId: "owner", spaceId: "space" };
    const input = {
      prisma: f.prisma,
      scope: run,
      bot: f.bot,
      snapshot: run.runtimePin,
      scripted: false,
      loadKey: vi.fn(async () => ({ provider: "xai", id: "grok-4.6", apiKey: "test-key" })),
    };
    expect(await resolveRunModelPin(input)).toMatchObject({ code: "pin-incomplete" });
    await backfillRuntimePins(f);
    expect(await resolveRunModelPin(input)).toMatchObject({
      kind: "resolved",
      pin: { credentialId: "connection", effort: "medium", revision: 1 },
    });
    expect(input.loadKey).toHaveBeenCalledOnce();
  });

  it("leaves unknown effort and missing custom metadata blocked", async () => {
    const f = fixture();
    f.bot.modelId = "unknown-model";
    expect((await backfillRuntimePins(f)).skipped).toBe(1);
    f.bot.modelProvider = f.credentials[0]!.provider = "openai-compatible";
    f.tx.secret.findFirst.mockResolvedValue(null!);
    expect((await backfillRuntimePins(f)).skipped).toBe(1);
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
  });
});
