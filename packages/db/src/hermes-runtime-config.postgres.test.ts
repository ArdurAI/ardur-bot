import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const postgres = databaseUrl ? describe.sequential : describe.skip;
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260927190000_hermes_bot_runtime_config/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

postgres("Hermes Bot configuration migration on disposable PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("initializes a nullable JSON column without a credential or token table", async () => {
    const columns = await db.pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bots' AND column_name = 'runtimeConfig'`,
    );
    expect(columns.rows).toEqual([
      { column_name: "runtimeConfig", data_type: "jsonb", is_nullable: "YES" },
    ]);
    expect(migration).toMatch(/^ALTER TABLE "bots" ADD COLUMN "runtimeConfig" JSONB;\n$/);
  });

  it("upgrades the preceding Bot shape and keeps old rows null", async () => {
    const schema = `hermes_migration_${randomUUID().replaceAll("-", "")}`;
    const client = await db.pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query('CREATE TABLE "bots" (id TEXT PRIMARY KEY)');
      await client.query('INSERT INTO "bots" (id) VALUES ($1)', ["old-bot"]);
      await client.query(migration);
      expect((await client.query('SELECT id, "runtimeConfig" FROM "bots"')).rows).toEqual([
        { id: "old-bot", runtimeConfig: null },
      ]);
      const config = { version: 1, maxProviderRequests: 16, timeoutMs: 180_000 };
      await client.query('UPDATE "bots" SET "runtimeConfig" = $1::jsonb WHERE id = $2', [
        JSON.stringify(config),
        "old-bot",
      ]);
      expect(
        (await client.query('SELECT "runtimeConfig" FROM "bots" WHERE id = $1', ["old-bot"])).rows,
      ).toEqual([{ runtimeConfig: config }]);
      expect(
        (
          await client.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
            [schema],
          )
        ).rows,
      ).toEqual([{ table_name: "bots" }]);
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  });
});

const v2Migration = readFileSync(
  new URL(
    "../prisma/migrations/20260927200000_runtime_config_v2/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

postgres("Hermes Bot configuration v2 migration on disposable PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("migrates version 1 to version 2 and initializes missing configs", async () => {
    const schema = `hermes_migration_v2_${randomUUID().replaceAll("-", "")}`;
    const client = await db.pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query('CREATE TABLE "bots" (id TEXT PRIMARY KEY, "runtimeKind" TEXT, "runtimeConfig" JSONB)');
      
      const v1Config = { version: 1, maxProviderRequests: 20, timeoutMs: 300_000 };
      await client.query('INSERT INTO "bots" (id, "runtimeKind", "runtimeConfig") VALUES ($1, $2, $3::jsonb)', ["v1-bot", "hermes", JSON.stringify(v1Config)]);
      await client.query('INSERT INTO "bots" (id, "runtimeKind", "runtimeConfig") VALUES ($1, $2, $3::jsonb)', ["null-hermes", "hermes", null]);
      await client.query('INSERT INTO "bots" (id, "runtimeKind", "runtimeConfig") VALUES ($1, $2, $3::jsonb)', ["null-other", "pi", null]);
      
      await client.query(v2Migration);
      
      const v1Bot = await client.query('SELECT "runtimeConfig" FROM "bots" WHERE id = $1', ["v1-bot"]);
      expect(v1Bot.rows[0].runtimeConfig).toEqual({
        version: 2,
        runtimeKind: "hermes",
        limits: { maxProviderRequests: 20, timeoutMs: 300_000 },
        context: { maxInputBytes: 16384, overflow: "trim" },
        harness: { agent: { api_max_retries: 1 } }
      });
      
      const nullHermesBot = await client.query('SELECT "runtimeConfig" FROM "bots" WHERE id = $1', ["null-hermes"]);
      expect(nullHermesBot.rows[0].runtimeConfig).toEqual({
        version: 2,
        runtimeKind: "hermes",
        limits: { maxProviderRequests: 16, timeoutMs: 180000 },
        context: { maxInputBytes: 16384, overflow: "trim" },
        harness: { agent: { api_max_retries: 1 } }
      });
      
      const nullOtherBot = await client.query('SELECT "runtimeConfig" FROM "bots" WHERE id = $1', ["null-other"]);
      expect(nullOtherBot.rows[0].runtimeConfig).toBeNull();
      
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  });
});
