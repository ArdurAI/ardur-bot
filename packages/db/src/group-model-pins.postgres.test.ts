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
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
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
});
