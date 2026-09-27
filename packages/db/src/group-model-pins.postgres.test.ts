import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import {
  clearGroupMemberPin,
  createGroupRepos,
  getGroupMemberPinStates,
  setGroupMemberPin,
} from "./groups.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260927130000_group_member_model_pins/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControllablePrisma(
  base: PrismaClient,
  hooks: {
    onBeforeUpdate?: () => Promise<void> | void;
  },
): PrismaClient {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return async (
          fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>,
          options?: unknown,
        ) => {
          return (target as any).$transaction(async (tx: any) => {
            const wrappedTx = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "chatGroupMember") {
                  const memberTarget = txTarget.chatGroupMember;
                  return new Proxy(memberTarget, {
                    get(mTarget, mProp, mReceiver) {
                      if (mProp === "update") {
                        return async (...args: unknown[]) => {
                          if (hooks.onBeforeUpdate) await hooks.onBeforeUpdate();
                          return (mTarget.update as any)(...args);
                        };
                      }
                      return Reflect.get(mTarget, mProp, mReceiver);
                    },
                  });
                }
                return Reflect.get(txTarget, txProp, txReceiver);
              },
            });
            return fn(wrappedTx);
          }, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function waitForBlockedLock(
  pool: ReturnType<typeof createDb>["pool"],
  timeoutMs = 250,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_locks WHERE NOT granted",
    );
    if (Number(res.rows[0]?.count) > 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describePostgres("group member pins (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `g1-user-${suffix}`;
  const organizationId = `g1-org-${suffix}`;
  const spaceId = `g1-space-${suffix}`;
  const actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
  const choice = {
    runtimeKind: "pi" as const,
    provider: "fixture",
    modelId: "fixture",
    effort: "low",
    credentialId: "connection",
  };
  let prisma: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let bots: string[];

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    pool = db.pool;
    await prisma.user.create({ data: { id: userId, name: "Fixture", email: actor.email } });
    await prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await prisma.member.create({
      data: {
        id: `g1-member-${suffix}`,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Fixture", createdByUserId: userId },
    });
    await prisma.spaceMember.create({
      data: {
        id: `g1-space-member-${suffix}`,
        spaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    bots = await Promise.all(
      [1, 2, 3].map(async (number) => {
        const bot = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: `Bot ${number}`,
            color: "ink",
            modelProvider: choice.provider,
            modelId: choice.modelId,
            thinkingLevel: choice.effort,
            modelCredentialId: choice.credentialId,
          },
        });
        return bot.id;
      }),
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await pool.end();
  });

  it.each([false, true])("migrates an existing schema with populated=%s", async (populated) => {
    const schema = `g1_migration_${process.pid}_${Date.now()}_${populated ? 1 : 0}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query("CREATE TABLE chat_group_members (id TEXT PRIMARY KEY)");
      await client.query("CREATE TABLE runs (id TEXT PRIMARY KEY)");
      await client.query(
        'CREATE TABLE usage_records (id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL)',
      );
      if (populated) {
        await client.query("INSERT INTO chat_group_members (id) VALUES ('member')");
        await client.query("INSERT INTO runs (id) VALUES ('run')");
        await client.query(
          "INSERT INTO usage_records (id, \"spaceId\", \"userId\", \"createdAt\") VALUES ('usage', 'space', 'user', NOW())",
        );
      }
      await client.query(migration);
      await client.query("COMMIT");
      await client.query(`SET search_path TO "${schema}"`);
      if (populated) {
        const member = await client.query(
          'SELECT "runtimePin", "modelPinRevision" FROM chat_group_members',
        );
        expect(member.rows).toEqual([{ runtimePin: null, modelPinRevision: 0 }]);
        const run = await client.query('SELECT "runtimePinSource", "usageGroupId" FROM runs');
        expect(run.rows).toEqual([{ runtimePinSource: null, usageGroupId: null }]);
        const usage = await client.query(
          'SELECT "groupId", "threadId", "runtimePinSource" FROM usage_records',
        );
        expect(usage.rows).toEqual([{ groupId: null, threadId: null, runtimePinSource: null }]);
      }
      await expect(
        client.query(
          'INSERT INTO chat_group_members (id, "runtimePin", "modelPinRevision") VALUES ($1, $2::jsonb, 1)',
          ["partial", JSON.stringify({ provider: "fixture", revision: 1 })],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query('INSERT INTO chat_group_members (id, "runtimePin") VALUES ($1, $2::jsonb)', [
          "json-null",
          "null",
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query(
          'INSERT INTO chat_group_members (id, "runtimePin", "modelPinRevision") VALUES ($1, $2::jsonb, 2)',
          ["mismatch", JSON.stringify({ ...choice, revision: 1 })],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query('INSERT INTO chat_group_members (id, "modelPinRevision") VALUES ($1, -1)', [
          "negative",
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      try {
        await client.query("ROLLBACK").catch(() => {});
        await client.query("RESET search_path").catch(() => {});
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      } finally {
        client.release();
      }
    }
  });

  it("rolls back unfinished transaction and releases client when migration statement fails", async () => {
    const schema = `g1_migration_fault_${process.pid}_${Date.now()}`;
    const initialCheckedOut = pool.totalCount - pool.idleCount;
    const client = await pool.connect();
    let caught: unknown;
    try {
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query("THIS IS INVALID SQL STATEMENT TO FORCE ABORT");
        await client.query(migration);
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await client.query("RESET search_path").catch(() => {});
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      }
    } catch (error) {
      caught = error;
    } finally {
      client.release();
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("42601");
    expect(pool.totalCount - pool.idleCount).toBe(initialCheckedOut);
    const remaining = await pool.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      [schema],
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it("increments only changed choices and preserves surviving memberships", async () => {
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup(actor, { name: "First", botIds: bots.slice(0, 2) });
    const other = await repos.createGroup(actor, { name: "Second", botIds: bots.slice(0, 2) });
    const initial = await getGroupMemberPinStates(prisma, actor, group.id);
    expect(initial).toHaveLength(2);
    expect(initial.find((state) => state.botId === bots[0])).toMatchObject({
      botId: bots[0],
      runtimePin: null,
      modelPinRevision: 0,
    });
    const member = await prisma.chatGroupMember.findUniqueOrThrow({
      where: { groupId_botId: { groupId: group.id, botId: bots[0]! } },
    });
    const otherSurvivor = await prisma.chatGroupMember.findUniqueOrThrow({
      where: { groupId_botId: { groupId: group.id, botId: bots[1]! } },
    });
    const first = await setGroupMemberPin(prisma, actor, group.id, bots[0]!, choice);
    expect(first).toMatchObject({
      memberId: member.id,
      modelPinRevision: 1,
      runtimePin: { ...choice, revision: 1 },
    });
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: bots[0]! } })).toMatchObject({
      modelProvider: choice.provider,
      modelId: choice.modelId,
      modelPinRevision: 0,
    });
    expect(await setGroupMemberPin(prisma, actor, group.id, bots[0]!, choice)).toEqual(first);
    expect(
      (await getGroupMemberPinStates(prisma, actor, other.id)).find(
        (state) => state.botId === bots[0],
      ),
    ).toMatchObject({
      runtimePin: null,
      modelPinRevision: 0,
    });
    await repos.updateGroup(actor, { groupId: group.id, botIds: bots });
    const survivor = await prisma.chatGroupMember.findUniqueOrThrow({
      where: { groupId_botId: { groupId: group.id, botId: bots[0]! } },
    });
    expect(survivor).toMatchObject({
      id: member.id,
      createdAt: member.createdAt,
      runtimePin: first.runtimePin,
      modelPinRevision: 1,
    });
    await repos.archiveGroup(actor, group.id);
    await repos.restoreGroup(actor, group.id);
    expect(
      (await getGroupMemberPinStates(prisma, actor, group.id)).find(
        (state) => state.botId === bots[0],
      )?.runtimePin,
    ).toEqual(first.runtimePin);
    const duplicate = await repos.createGroup(actor, {
      name: "Copy",
      botIds: bots,
      copyPinsFromGroupId: group.id,
    });
    expect(
      (await getGroupMemberPinStates(prisma, actor, duplicate.id)).find(
        (state) => state.botId === bots[0],
      ),
    ).toMatchObject({
      runtimePin: { ...choice, revision: 1 },
      modelPinRevision: 1,
    });
    const cleared = await clearGroupMemberPin(prisma, actor, group.id, bots[0]!);
    expect(cleared).toMatchObject({ runtimePin: null, modelPinRevision: 2 });
    expect(await clearGroupMemberPin(prisma, actor, group.id, bots[0]!)).toEqual(cleared);
    await setGroupMemberPin(prisma, actor, group.id, bots[0]!, choice);
    await repos.updateGroup(actor, { groupId: group.id, botIds: bots.slice(1) });
    expect(
      await prisma.chatGroupMember.findUniqueOrThrow({
        where: { groupId_botId: { groupId: group.id, botId: bots[1]! } },
      }),
    ).toMatchObject({ id: otherSurvivor.id, createdAt: otherSurvivor.createdAt });
    expect(
      await prisma.chatGroupMember.findUnique({
        where: { groupId_botId: { groupId: group.id, botId: bots[0]! } },
      }),
    ).toBeNull();
    await repos.updateGroup(actor, { groupId: group.id, botIds: bots });
    const rejoined = await prisma.chatGroupMember.findUniqueOrThrow({
      where: { groupId_botId: { groupId: group.id, botId: bots[0]! } },
    });
    expect(rejoined).toMatchObject({ runtimePin: null, modelPinRevision: 0 });
    expect(rejoined.id).not.toBe(member.id);
    const changed = await setGroupMemberPin(prisma, actor, group.id, bots[0]!, {
      ...choice,
      effort: "high",
    });
    expect(changed).toMatchObject({
      memberId: rejoined.id,
      modelPinRevision: 1,
      runtimePin: { ...choice, effort: "high", revision: 1 },
    });
    expect(await setGroupMemberPin(prisma, actor, group.id, bots[0]!, choice)).toMatchObject({
      memberId: rejoined.id,
      modelPinRevision: 2,
      runtimePin: { ...choice, revision: 2 },
    });
    expect(
      (await getGroupMemberPinStates(prisma, actor, other.id)).find(
        (state) => state.botId === bots[0],
      ),
    ).toMatchObject({
      runtimePin: null,
      modelPinRevision: 0,
    });
    await repos.removeGroup(actor, duplicate.id);
    expect(await prisma.chatGroupMember.count({ where: { groupId: duplicate.id } })).toBe(0);
  });

  it("serializes concurrent setGroupMemberPin calls with distinct choices", async () => {
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup(actor, {
      name: "Concurrent Set",
      botIds: bots.slice(0, 2),
    });
    const botId = bots[0]!;

    const choiceA = {
      runtimeKind: "pi" as const,
      provider: "fixture-a",
      modelId: "model-a",
      effort: "low",
      credentialId: "connection-a",
    };
    const choiceB = {
      runtimeKind: "pi" as const,
      provider: "fixture-b",
      modelId: "model-b",
      effort: "high",
      credentialId: "connection-b",
    };

    const firstHoldingLock = createDeferred();
    const releaseFirst = createDeferred();

    const client1 = createControllablePrisma(prisma, {
      onBeforeUpdate: async () => {
        firstHoldingLock.resolve();
        await releaseFirst.promise;
      },
    });

    const p1 = setGroupMemberPin(client1, actor, group.id, botId, choiceA);
    await firstHoldingLock.promise;

    const p2 = setGroupMemberPin(prisma, actor, group.id, botId, choiceB);
    await waitForBlockedLock(pool);
    releaseFirst.resolve();

    const [first, second] = await Promise.all([p1, p2]);

    expect(first.modelPinRevision).toBe(1);
    expect(second.modelPinRevision).toBe(2);
    expect(first.modelPinRevision).not.toBe(second.modelPinRevision);
    expect(first.runtimePin).toEqual({ ...choiceA, revision: 1 });
    expect(second.runtimePin).toEqual({ ...choiceB, revision: 2 });

    const states = await getGroupMemberPinStates(prisma, actor, group.id);
    const memberState = states.find((s) => s.botId === botId)!;
    expect(memberState.modelPinRevision).toBe(2);
    expect(memberState.runtimePin).toEqual({ ...choiceB, revision: 2 });
    expect(memberState.runtimePin?.revision).toBe(memberState.modelPinRevision);
  });

  it("serializes setGroupMemberPin racing clearGroupMemberPin", async () => {
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup(actor, {
      name: "Concurrent Clear",
      botIds: bots.slice(0, 2),
    });
    const botId = bots[0]!;

    const firstHoldingLock = createDeferred();
    const releaseFirst = createDeferred();

    const client1 = createControllablePrisma(prisma, {
      onBeforeUpdate: async () => {
        firstHoldingLock.resolve();
        await releaseFirst.promise;
      },
    });

    const p1 = setGroupMemberPin(client1, actor, group.id, botId, choice);
    await firstHoldingLock.promise;

    const p2 = clearGroupMemberPin(prisma, actor, group.id, botId);
    await waitForBlockedLock(pool);
    releaseFirst.resolve();

    const [first, second] = await Promise.all([p1, p2]);

    expect(first.modelPinRevision).toBe(1);
    expect(second.modelPinRevision).toBe(2);
    expect(first.modelPinRevision).not.toBe(second.modelPinRevision);
    expect(first.runtimePin).toEqual({ ...choice, revision: 1 });
    expect(second.runtimePin).toBeNull();

    const states = await getGroupMemberPinStates(prisma, actor, group.id);
    const memberState = states.find((s) => s.botId === botId)!;
    expect(memberState.modelPinRevision).toBe(2);
    expect(memberState.runtimePin).toBeNull();
  });
});
