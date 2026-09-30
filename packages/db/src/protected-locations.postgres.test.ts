import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  readProtectedLocations,
  updateBotProtectedLocationGrants,
  updateSpaceProtectedLocations,
} from "./protected-locations.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const custom = {
  id: "fixture-vpn",
  label: "Fixture VPN",
  kind: "credentials" as const,
  paths: ["~/fixture-vpn"],
};
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260930002000_protected_locations_store/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { resolve, promise };
}

function controlledClient(
  base: PrismaClient,
  hooks: { started: (pid: number) => void; locked?: () => Promise<void> },
): PrismaClient {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            hooks.started(row!.pid);
            return callback(
              new Proxy(tx, {
                get(client, property, clientReceiver) {
                  if (property !== "$queryRaw")
                    return Reflect.get(client, property, clientReceiver);
                  return async (sql: TemplateStringsArray, ...values: unknown[]) => {
                    const result = await client.$queryRaw(sql, ...values);
                    if (sql.join("?").includes("FROM bots") && sql.join("?").includes("FOR UPDATE"))
                      await hooks.locked?.();
                    return result;
                  };
                },
              }),
            );
          },
          { timeout: 10_000 },
        );
    },
  });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Transaction did not reach the test barrier")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describePostgres("protected locations (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `protected-user-${suffix}`;
  const organizationId = `protected-org-${suffix}`;
  const spaceId = `protected-space-${suffix}`;
  let prisma: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let botId: string;
  let secondBotId: string;

  beforeAll(async () => {
    ({ prisma, pool } = createDb(databaseUrl!));
    await prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Fixture", createdByUserId: userId },
    });
    const createBot = () =>
      prisma.bot.create({ data: { spaceId, userId, name: "Fixture", color: "ink" } });
    botId = (await createBot()).id;
    secondBotId = (await createBot()).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("migrates populated tables with null defaults", async () => {
    const client = await pool.connect();
    const schema = `protected_migration_${process.pid}_${Date.now()}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(
        "CREATE TABLE bots (id TEXT PRIMARY KEY); CREATE TABLE spaces (id TEXT PRIMARY KEY)",
      );
      await client.query("INSERT INTO bots VALUES ('bot'); INSERT INTO spaces VALUES ('space')");
      await client.query(migration);
      expect((await client.query('SELECT "protectedLocationGrants" FROM bots')).rows).toEqual([
        { protectedLocationGrants: null },
      ]);
      expect((await client.query('SELECT "protectedLocations" FROM spaces')).rows).toEqual([
        { protectedLocations: null },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps both simultaneous patches to one bot under its row lock", async () => {
    const locked = deferred();
    const release = deferred();
    const firstPid = deferred<number>();
    const secondPid = deferred<number>();
    const firstClient = controlledClient(prisma, {
      started: firstPid.resolve,
      locked: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    const secondClient = controlledClient(prisma, { started: secondPid.resolve });
    const first = updateBotProtectedLocationGrants(firstClient, {
      spaceId,
      userId,
      botId,
      patch: { grant: ["ssh"] },
    });
    let second: Promise<unknown> | undefined;
    try {
      await bounded(locked.promise);
      second = updateBotProtectedLocationGrants(secondClient, {
        spaceId,
        userId,
        botId,
        patch: { grant: ["aws"] },
      });
      // Observe an actual database lock wait rather than relying on a scheduling delay.
      const waitingPid = await bounded(secondPid.promise);
      const blockingPid = await bounded(firstPid.promise);
      let blocked = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked",
          [waitingPid, blockingPid],
        );
        if (result.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled(second ? [first, second] : [first]);
    }
    await first;
    await second;
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(bot.protectedLocationGrants).toEqual(["ssh", "aws"]);
  });

  it("removes every bot's custom grant and does not restore it after re-addition", async () => {
    await updateSpaceProtectedLocations(prisma, { spaceId, patch: { add: [custom] } });
    for (const id of [botId, secondBotId])
      await updateBotProtectedLocationGrants(prisma, {
        spaceId,
        userId,
        botId: id,
        patch: { grant: [custom.id] },
      });
    await updateSpaceProtectedLocations(prisma, { spaceId, patch: { remove: [custom.id] } });
    for (const id of [botId, secondBotId]) {
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id } });
      expect(bot.protectedLocationGrants).not.toContain(custom.id);
    }
    await updateSpaceProtectedLocations(prisma, { spaceId, patch: { add: [custom] } });
    for (const id of [botId, secondBotId])
      expect((await readProtectedLocations(prisma, { spaceId, botId: id })).at(-1)).toMatchObject({
        id: custom.id,
        granted: false,
      });
  });
});
