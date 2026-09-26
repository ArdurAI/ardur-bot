import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const migrations = new URL("../prisma/migrations/", import.meta.url);
const migration = (name: string) =>
  readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8");
const UPKEEP = "20260926010000_board_filing_upkeep";
const sql = migration(UPKEEP);

it("adds every filing column in one migration without rewriting existing rows", () => {
  expect(sql).toContain('ALTER COLUMN "runId" DROP NOT NULL');
  for (const column of [
    '"workspaceId" TEXT',
    '"itemId" TEXT',
    '"botId" TEXT',
    '"learningProposalId" TEXT',
    '"closedAt" TIMESTAMP(3)',
    '"outcome" TEXT',
    '"reused" BOOLEAN NOT NULL DEFAULT false',
    '"titleKey" TEXT',
    '"closePending" TEXT',
    '"closeAttempts" INTEGER',
    '"closeNextAt" TIMESTAMP(3)',
    '"closeUpdatedAt" TEXT',
    '"closeNoticeAt" TIMESTAMP(3)',
    '"closeCommentCount" INTEGER',
  ])
    expect(sql).toContain(`ADD COLUMN ${column}`);
  expect(sql).not.toMatch(/\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE "/);
});

it("keeps one owning filing per item and one filing per proposal", () => {
  expect(sql).toMatch(
    /CREATE UNIQUE INDEX "bot_board_filings_workspaceId_itemId_key"\s+ON "bot_board_filings" \("workspaceId", "itemId"\) WHERE NOT "reused"/,
  );
  expect(sql).toMatch(
    /CREATE UNIQUE INDEX "bot_board_filings_learningProposalId_key"\s+ON "bot_board_filings" \("learningProposalId"\);/,
  );
});

it("lets a failed-close notice name its owner and item instead of a follow", () => {
  expect(sql).toContain('ALTER COLUMN "followId" DROP NOT NULL');
  expect(sql).toContain('ADD COLUMN "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE');
  expect(sql).toContain(
    'ADD COLUMN "workspaceId" TEXT REFERENCES "board_workspaces"("id") ON DELETE CASCADE',
  );
  expect(sql).toMatch(/CHECK \(\s+"followId" IS NOT NULL OR/);
});

it("replaces the unreleased step migrations with the single upkeep migration", () => {
  for (const name of [
    "20260925180000_board_filing_outcomes",
    "20260925190000_board_filing_reuse",
    "20260925200000_board_filing_title_key",
    "20260925210000_board_filing_close_pending",
    "20260925220000_board_filing_close_retry",
    "20260925230000_board_filing_close_updated_at",
    "20260925233000_board_filing_close_notice",
  ])
    expect(existsSync(new URL(`${name}/migration.sql`, migrations)), name).toBe(false);
});

it("names every Board migration in the operator checklist", () => {
  const docs = readFileSync(new URL("../../../docs/board.md", import.meta.url), "utf8");
  const named = [...docs.matchAll(/`(\d{14}_[a-z_]+)`/g)].map((match) => match[1]);
  for (const name of ["20260925170000_bot_upkeep", UPKEEP]) expect(named).toContain(name);
  for (const name of named)
    expect(existsSync(new URL(`${name}/migration.sql`, migrations)), name).toBe(true);
});
