import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");
const sql = migration("20260925180000_board_filing_outcomes");

it("keeps existing filing rows valid while adding item outcomes and proposal attribution", () => {
  expect(sql).toContain('ALTER COLUMN "runId" DROP NOT NULL');
  for (const column of [
    "workspaceId",
    "itemId",
    "botId",
    "learningProposalId",
    "closedAt",
    "outcome",
  ])
    expect(sql).toContain(`ADD COLUMN "${column}"`);
  expect(sql).toContain('"bot_board_filings_workspaceId_itemId_key"');
  expect(sql).not.toMatch(/\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("lets a proposal reuse an item another filing already owns, once per proposal", () => {
  const reuse = migration("20260925190000_board_filing_reuse");
  expect(reuse).toContain('ADD COLUMN "reused" BOOLEAN NOT NULL DEFAULT false');
  expect(reuse).toMatch(
    /CREATE UNIQUE INDEX "bot_board_filings_workspaceId_itemId_key"\s+ON "bot_board_filings" \("workspaceId", "itemId"\)\s+WHERE NOT "reused"/,
  );
  expect(reuse).toMatch(
    /CREATE UNIQUE INDEX "bot_board_filings_learningProposalId_key"\s+ON "bot_board_filings" \("learningProposalId"\);/,
  );
  expect(reuse).not.toMatch(/\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("records the normalized title on a filing without rewriting existing rows", () => {
  const titled = migration("20260925200000_board_filing_title_key");
  expect(titled).toContain('ADD COLUMN "titleKey" TEXT');
  expect(titled).not.toMatch(/\bNOT NULL\b|\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("records a pending close without rewriting existing filing rows", () => {
  const pending = migration("20260925210000_board_filing_close_pending");
  expect(pending).toContain('ADD COLUMN "closePending" TEXT');
  expect(pending).not.toMatch(/\bNOT NULL\b|\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("records close retries without rewriting existing filing rows", () => {
  const retry = migration("20260925220000_board_filing_close_retry");
  expect(retry).toContain('ADD COLUMN "closeAttempts" INTEGER');
  expect(retry).toContain('ADD COLUMN "closeNextAt" TIMESTAMP(3)');
  expect(retry).not.toMatch(/\bNOT NULL\b|\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("records the item timestamp a pending close must still match", () => {
  const updated = migration("20260925230000_board_filing_close_updated_at");
  expect(updated).toContain('ADD COLUMN "closeUpdatedAt" TEXT');
  expect(updated).not.toMatch(/\bNOT NULL\b|\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("records when the failed-close notice was stored", () => {
  const notice = migration("20260925233000_board_filing_close_notice");
  expect(notice).toContain('ADD COLUMN "closeNoticeAt" TIMESTAMP(3)');
  expect(notice).not.toMatch(/\bNOT NULL\b|\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b/);
});

it("names every Board migration in the operator checklist", () => {
  const docs = readFileSync(new URL("../../../docs/board.md", import.meta.url), "utf8");
  const named = [...docs.matchAll(/`(\d{14}_[a-z_]+)`/g)].map((match) => match[1]);
  for (const name of [
    "20260925170000_bot_upkeep",
    "20260925180000_board_filing_outcomes",
    "20260925190000_board_filing_reuse",
    "20260925200000_board_filing_title_key",
    "20260925210000_board_filing_close_pending",
    "20260925220000_board_filing_close_retry",
    "20260925230000_board_filing_close_updated_at",
    "20260925233000_board_filing_close_notice",
  ])
    expect(named).toContain(name);
  for (const name of named)
    expect(
      existsSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)),
      name,
    ).toBe(true);
});
