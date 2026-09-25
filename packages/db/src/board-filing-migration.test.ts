import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../prisma/migrations/20260925180000_board_filing_outcomes/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

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
