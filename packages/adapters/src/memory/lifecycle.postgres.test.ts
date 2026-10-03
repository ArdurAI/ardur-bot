import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { RuntimePinSchema } from "@ardurbot/contracts/runtime-pins";
import {
  clearThread,
  createDb,
  createThreadMessage,
  resetBriefRetriesForConnection,
} from "@ardurbot/db";
import { maintainBriefs, markBriefPending } from "@ardurbot/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryLifecycle } from "./lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!hasDb)("brief authorization and history clearing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id: { in: users } } });
    await db.prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  async function fixture(group = false) {
    const prisma = db.prisma;
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "fixture-color" },
    });
    const chat = group
      ? await prisma.chatGroup.create({
          data: {
            spaceId: id,
            userId: id,
            name: "Fixture",
            members: { create: { botId: bot.id } },
          },
        })
      : null;
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, ...(chat ? { groupId: chat.id } : { botId: bot.id }) },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Review",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    const { service } = createMemoryLifecycle({
      prisma,
      dataDir: tmpdir(),
      secrets: { load: vi.fn() } as never,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: async () => undefined,
        close: async () => undefined,
      },
    });
    const context = {
      spaceId: id,
      userId: id,
      botId: bot.id,
      threadId: thread.id,
      groupId: chat?.id ?? "direct",
      briefGeneration: 0,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    };
    return { prisma, bot, thread, run, service, context, chat };
  }

  it.each([false, true])(
    "serializes a checked brief commit with clearing and rejects the old generation afterward (group: %s)",
    async (group) => {
      const f = await fixture(group);
      const checked = deferred();
      const release = deferred();
      const open = f.service.dependencies.open;
      f.service.dependencies.open = (context, action) =>
        open(context, async (session) => {
          checked.resolve();
          await release.promise;
          return action(session);
        });
      const input = {
        scope: "group" as const,
        botId: f.bot.id,
        groupId: f.chat?.id ?? "direct",
        path: `briefs/${f.chat?.id ?? "direct"}.md`,
        content: "Old generation",
        expectedRevision: 0,
      };
      const committing = f.service.commit(input, f.context);
      await checked.promise;
      let cleared = false;
      const clearing = clearThread(f.prisma, {
        ...(f.chat ? { groupId: f.chat.id } : {}),
        spaceId: f.context.spaceId,
        botId: f.bot.id,
        threadId: f.thread.id,
      }).then(() => {
        cleared = true;
      });
      try {
        // Observe the actual database interleaving; no timing-based sleep decides the outcome.
        await expect
          .poll(
            async () =>
              cleared ||
              (
                await db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND (query LIKE '%threads%' OR query LIKE '%bots%' OR query LIKE '%chat_groups%')",
                )
              ).rowCount! > 0,
          )
          .toBe(true);
        expect(cleared).toBe(false);
      } finally {
        release.resolve();
        await Promise.all([committing, clearing]);
      }
      await expect(
        f.service.commit({ ...input, expectedRevision: 1 }, f.context),
      ).rejects.toMatchObject({ code: "MEMORY_ACCESS" });
    },
  );

  it("connection saves reset provider-default room briefs but not unset or differently pinned briefs", async () => {
    const f = await fixture(true);
    await f.prisma.bot.update({ where: { id: f.bot.id }, data: { modelProvider: "other" } });
    const unsetBot = await f.prisma.bot.create({
      data: {
        spaceId: f.context.spaceId,
        userId: f.context.userId,
        name: "Unset",
        color: "fixture-color",
      },
    });
    const unsetThread = await f.prisma.thread.create({
      data: { spaceId: f.context.spaceId, userId: f.context.userId, botId: unsetBot.id },
    });
    const retry = { failureCount: 4, nextAttemptAt: new Date(Date.now() + 86_400_000) };
    await markBriefPending(f.prisma, f.run.id);
    const where = { botId_threadId: { botId: f.bot.id, threadId: f.thread.id } };
    const unset = await f.prisma.botBrief.create({
      data: {
        ...retry,
        botId: unsetBot.id,
        threadId: unsetThread.id,
        spaceId: f.context.spaceId,
        userId: f.context.userId,
        groupKey: "direct",
      },
    });
    for (const [credentialId, provider, shouldReset] of [
      [null, "fixture", true],
      ["different", "fixture", false],
      [null, "other", false],
    ] as const) {
      await f.prisma.chatGroupMember.update({
        where: { groupId_botId: { groupId: f.chat!.id, botId: f.bot.id } },
        data: {
          modelPinRevision: 1,
          runtimePin: RuntimePinSchema.parse({
            runtimeKind: "pi",
            provider,
            modelId: "fixture-model",
            effort: "off",
            credentialId,
            revision: 1,
          }),
        },
      });
      await f.prisma.botBrief.update({ where, data: retry });
      await resetBriefRetriesForConnection(f.prisma, {
        userId: f.context.userId,
        credentialId: "saved-connection",
        provider: "fixture",
      });
      const room = await f.prisma.botBrief.findUniqueOrThrow({ where });
      expect(room.failureCount).toBe(shouldReset ? 0 : 4);
      expect(room.nextAttemptAt).toEqual(shouldReset ? null : retry.nextAttemptAt);
      expect(await f.prisma.botBrief.findUniqueOrThrow({ where: { id: unset.id } })).toMatchObject(
        retry,
      );
    }
  });

  it("skips dirty briefs before retry eligibility and admits them after the deadline", async () => {
    const f = await fixture();
    await createThreadMessage(f.prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "A new release decision" }],
    });
    await markBriefPending(f.prisma, f.run.id);
    const where = { botId_threadId: { botId: f.bot.id, threadId: f.thread.id } };
    await f.prisma.botBrief.update({
      where,
      data: {
        failureCount: 4,
        nextAttemptAt: new Date(Date.now() + 86_400_000),
      },
    });
    const refresh = vi.fn(async () => undefined);
    await maintainBriefs(f.prisma, refresh);
    expect(refresh).not.toHaveBeenCalledWith(f.run.id);
    await f.prisma.botBrief.update({ where, data: { nextAttemptAt: new Date(0) } });
    await maintainBriefs(f.prisma, refresh);
    expect(refresh).toHaveBeenCalledWith(f.run.id);
  });

  it("excludes removed group members from the periodic drain", async () => {
    const f = await fixture(true);
    await createThreadMessage(f.prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "New group decision" }],
    });
    await markBriefPending(f.prisma, f.run.id);
    const refresh = vi.fn(async () => undefined);
    await maintainBriefs(f.prisma, refresh);
    expect(refresh).toHaveBeenCalledWith(f.run.id);
    refresh.mockClear();
    await f.prisma.chatGroupMember.deleteMany({ where: { botId: f.bot.id, groupId: f.chat!.id } });
    await maintainBriefs(f.prisma, refresh);
    expect(refresh).not.toHaveBeenCalledWith(f.run.id);
  });

  it("excludes legacy shared-channel pending briefs from the periodic drain", async () => {
    const f = await fixture();
    const source = await createThreadMessage(f.prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [
        {
          kind: "channel_message",
          provider: "fake",
          channelId: "shared-channel",
          fromAddress: "sender",
          fromLabel: "Sender",
          text: "Shared request",
          hop: 0,
        },
      ],
    });
    await markBriefPending(f.prisma, f.run.id);
    await f.prisma.run.update({
      where: { id: f.run.id },
      data: { trigger: "messaging", sourceMessageId: source.id },
    });
    const refresh = vi.fn(async () => undefined);
    await maintainBriefs(f.prisma, refresh);
    expect(refresh).not.toHaveBeenCalledWith(f.run.id);
  });
});
