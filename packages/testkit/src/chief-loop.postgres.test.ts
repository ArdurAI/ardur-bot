import { randomUUID } from "node:crypto";
import { handoffToGroupBot } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { DELEGATION_LIMITS } from "@ardurbot/contracts";
import { createDb, lockOwnedGroup, provisionMessagingIdentity } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage } from "../../../apps/api/src/thread-target.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
// CI only: scheduling is deliberately stalled; no external service, computer or model runs.
describe.skipIf(!enabled).sequential("chief receipt Postgres journey", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function room() {
    const mine = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: `fixture-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const scope = { spaceId: mine.spaceId, userId: mine.userId };
    const chief = await db.prisma.bot.findUniqueOrThrow({ where: { id: mine.botId } });
    const computer = await db.prisma.computer.create({
      data: {
        ...scope,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "docker",
        state: "running",
      },
    });
    const worker = await db.prisma.bot.create({
      data: {
        ...scope,
        name: "Renamed member",
        title: "documentation",
        color: chief.color,
        computerId: computer.id,
        modelProvider: "fixture",
        modelId: "fixed",
        thinkingLevel: "high",
        modelPinRevision: 3,
      },
    });
    const wrong = await db.prisma.bot.create({
      data: { ...scope, name: "Available member", color: chief.color, computerId: computer.id },
    });
    const group = await db.prisma.chatGroup.create({
      data: {
        ...scope,
        name: "Receipt fixture",
        coordinatorBotId: chief.id,
        members: { create: [wrong, worker, chief].map((bot) => ({ botId: bot.id })) },
        thread: { create: scope },
      },
      include: { thread: true },
    });
    await db.prisma.mcpServer.create({
      data: {
        ...scope,
        slug: "fixture-notion",
        name: "Fake Notion",
        transport: "streamable_http",
        catalogId: "notion",
        connectionState: "connected",
        lastCheckedAt: new Date(),
        manifest: {
          capturedAt: new Date().toISOString(),
          serverVersion: "fixture",
          account: null,
          tools: [
            { id: "fetch_page", description: "Read a page", inputSchemaDigest: "a".repeat(64) },
          ],
        },
        spaceAllowedTools: ["fetch_page"],
        assignments: {
          create: [
            { ...scope, botId: worker.id, access: "custom", allowedTools: ["fetch_page"] },
            { ...scope, botId: wrong.id, access: "custom", allowedTools: [] },
            { ...scope, botId: chief.id, access: "custom", allowedTools: [] },
          ],
        },
      },
    });
    const actor = scope as Actor;
    const target = await resolveThreadTarget(db.prisma, actor, { groupId: group.id });
    const deps = {
      prisma: db.prisma,
      events: { notify: vi.fn(async () => undefined) } as never,
      jobs: { enqueue: vi.fn(async () => undefined) } as never,
    };
    return { scope, actor, target, deps, chief, worker, group };
  }
  it("replays one receipt before runtime scheduling, admits the selected member once and preserves pins/budget on reload", async () => {
    const f = await room();
    const start = performance.now();
    const sent = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: "Put this long document in Notion.",
      clientNonce: "document",
    });
    const sendToReceiptMs = performance.now() - start;
    console.log(
      JSON.stringify({
        measurement: "server-send-to-returned-chief-receipt",
        sendToReceiptMs,
        clickToPaint: "measured separately in CI browser journey",
      }),
    );
    expect(sendToReceiptMs).toBeLessThan(2000);
    expect(sent.kind).toBe("work");
    if (sent.kind === "receipt-only") throw new Error("Work requires a run");
    expect(sent.receipt?.key).toBe("document-to-service");
    const replay = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: "Put this long document in Notion.",
      clientNonce: "document",
    });
    expect(replay).toEqual(sent);
    const queued = await db.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
    expect(queued.status).toBe("queued");
    const plan = await db.prisma.chiefPlan.findUniqueOrThrow({
      where: { sourceMessageId: queued.sourceMessageId! },
    });
    expect(plan.decision).toMatchObject({ kind: "delegate", memberId: f.worker.id });
    await db.prisma.run.update({ where: { id: queued.id }, data: { status: "running" } });
    const pin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "fixed",
      credentialId: "fake-connection",
      effort: "high" as const,
      revision: 3,
    };
    const deps = {
      ...f.deps,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixed",
          thinkingLevel: "high",
          contextWindow: 32768,
          maxTokens: 4096,
          destination: { host: "localhost", local: true },
        }) as never,
    };
    const run = { id: queued.id, ...f.scope, botId: f.chief.id, threadId: f.target.threadId };
    const dispatch = await handoffToGroupBot(deps, run, f.group.id, {
      bot_id: f.worker.id,
      message: "Prepare the document; request exact approval before any service write.",
    });
    expect(dispatch).toMatchObject({ ok: true, botId: f.worker.id });
    const root = await db.prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: queued.taskId },
    });
    expect(root.tokenLimit).toBe(DELEGATION_LIMITS.tokens);
    const repeated = await handoffToGroupBot(deps, run, f.group.id, {
      bot_id: f.worker.id,
      message: "Prepare the document; request exact approval before any service write.",
    });
    expect(repeated).toMatchObject({
      ok: true,
      runId: "runId" in dispatch ? dispatch.runId : undefined,
    });
    expect(
      (await db.prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: queued.taskId } }))
        .reservedTokens,
    ).toBe(root.reservedTokens);
    const messages = await db.prisma.message.findMany({
      where: { threadId: f.target.threadId },
      orderBy: { seq: "asc" },
    });
    expect(
      messages.filter((message) =>
        (message.blocks as any[]).some((block) => block.kind === "chief_receipt"),
      ),
    ).toHaveLength(1);
    expect(
      messages.filter((message) =>
        (message.blocks as any[]).some((block) => block.chiefDispatch?.memberId === f.worker.id),
      ),
    ).toHaveLength(1);
    const admittedRun = await db.prisma.run.findUniqueOrThrow({
      where: { id: "runId" in dispatch ? dispatch.runId : "missing" },
    });
    expect(admittedRun.botId).toBe(f.worker.id);
    expect(admittedRun.runtimePin).toMatchObject({ effort: "high", modelId: "fixed" });
    expect(
      (await db.prisma.bot.findUniqueOrThrow({ where: { id: f.worker.id } })).thinkingLevel,
    ).toBe("high");
    const before = await db.prisma.run.count({ where: { threadId: f.target.threadId } });
    const greeting = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: "Hi everyone.",
      clientNonce: "greeting",
    });
    expect(greeting.kind).toBe("receipt-only");
    expect(await db.prisma.run.count({ where: { threadId: f.target.threadId } })).toBe(before);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
      "running",
    );
  });
  it("serializes removal against dispatch and never chooses an unauthorized replacement", async () => {
    const f = await room();
    const sent = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: "Put this document in Notion.",
      clientNonce: "remove",
    });
    if (sent.kind === "receipt-only") throw new Error("Work requires a run");
    await db.prisma.run.update({ where: { id: sent.runId }, data: { status: "running" } });
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const removal = db.prisma.$transaction(async (tx) => {
      await lockOwnedGroup(tx, f.scope, f.group.id);
      await tx.chatGroupMember.delete({
        where: { groupId_botId: { groupId: f.group.id, botId: f.worker.id } },
      });
      locked();
      await held;
    });
    await acquired;
    const dispatch = handoffToGroupBot(
      f.deps,
      { id: sent.runId, ...f.scope, botId: f.chief.id, threadId: f.target.threadId },
      f.group.id,
      { bot_id: f.worker.id, message: "Prepare the document" },
    );
    release();
    await removal;
    expect(await dispatch).toEqual({ error: "handoff target is not a group member" });
    expect(await db.prisma.delegation.count({ where: { parentRunId: sent.runId } })).toBe(0);
  });
});
