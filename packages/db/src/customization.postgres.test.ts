import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";

const url = process.env.CUSTOMIZATION_TEST_DATABASE_URL;

it.skipIf(!url)(
  "removes legacy orphans and cascades only the deleted user's customization records in PostgreSQL",
  async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`
      CREATE TEMP TABLE "user" ("id" TEXT PRIMARY KEY);
      CREATE TEMP TABLE "customization_marketplaces" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "spaceId" TEXT NOT NULL);
      CREATE TEMP TABLE "plugin_installs" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "spaceId" TEXT NOT NULL);
      INSERT INTO "user" VALUES ('removed'), ('retained');
    `);
      const tables = ["customization_marketplaces", "plugin_installs"];
      for (const table of tables)
        await client.query(
          `INSERT INTO "${table}" VALUES ('first', 'removed', 'shared'), ('second', 'retained', 'shared'), ('orphan', 'missing', 'shared')`,
        );
      const migration = new URL(
        "../prisma/migrations/20260925030000_customization_user_cascade/migration.sql",
        import.meta.url,
      );
      if (existsSync(migration)) await client.query(readFileSync(migration, "utf8"));
      for (const table of tables) {
        expect((await client.query(`SELECT "id" FROM "${table}" ORDER BY "id"`)).rows).toEqual([
          { id: "first" },
          { id: "second" },
        ]);
        await expect(
          client.query(`INSERT INTO "${table}" VALUES ('invalid', 'missing', 'shared')`),
        ).rejects.toMatchObject({ code: "23503" });
      }
      await client.query(`DELETE FROM "user" WHERE "id" = 'removed'`);
      for (const table of tables)
        expect(
          (await client.query(`SELECT "id", "userId", "spaceId" FROM "${table}"`)).rows,
        ).toEqual([{ id: "second", userId: "retained", spaceId: "shared" }]);
    } finally {
      await client.end();
    }
  },
);
