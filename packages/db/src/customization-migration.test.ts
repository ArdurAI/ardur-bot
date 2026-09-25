import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const migrations = new URL("../prisma/migrations/", import.meta.url);

it.each([
  ["CustomizationMarketplace", "customization_marketplaces"],
  ["PluginInstall", "plugin_installs"],
])("cascades user deletion to %s in both the schema and a forward migration", (model, table) => {
  const definition = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  expect(definition).toMatch(
    /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
  );
  expect(definition).toContain(`@@map("${table}")`);
  const sql = readdirSync(migrations)
    .filter((name) => /^\d{14}_/.test(name) && name.slice(0, 14) > "20260925020000")
    .map((name) => readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"))
    .join("\n");
  expect(sql).toContain(
    `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
});
