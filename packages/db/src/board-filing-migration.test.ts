import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const migrations = new URL("../prisma/migrations/", import.meta.url);
const UPKEEP = "20260926010000_board_filing_upkeep";

it("names every Board migration in the operator checklist", () => {
  const docs = readFileSync(new URL("../../../docs/board.md", import.meta.url), "utf8");
  const named = [...docs.matchAll(/`(\d{14}_[a-z_]+)`/g)].map((match) => match[1]);
  for (const name of ["20260925170000_bot_upkeep", UPKEEP]) expect(named).toContain(name);
  for (const name of named)
    expect(existsSync(new URL(`${name}/migration.sql`, migrations)), name).toBe(true);
});
