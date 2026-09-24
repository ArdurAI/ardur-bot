import type { DocumentRevision } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { learningJourney } from "./learning-journey.js";

it("uses revision provenance and audit dates, deduplicates applies, and retains grant and curator events", () => {
  const revision = {
    documentId: "doc",
    revision: 2,
    scopeKey: { kind: "bot", botId: "bot" },
    author: { kind: "learning-loop" },
    learning: { proposalId: "proposal", action: "apply" },
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00Z",
  } as unknown as DocumentRevision;
  const audit = {
    id: "approve",
    action: "approve",
    createdAt: new Date("2026-09-10Z"),
    scopeKey: "bot:bot",
    proposalId: "proposal",
    grantId: null,
    beforeRevisionId: "doc:1",
    afterRevisionId: "doc:2",
  };
  const entries = learningJourney(
    [revision],
    [
      audit,
      {
        ...audit,
        id: "grant",
        action: "grant-created",
        createdAt: new Date("2026-09-11Z"),
        afterRevisionId: null,
        beforeRevisionId: null,
        proposalId: null,
        grantId: "grant",
      },
      {
        ...audit,
        id: "flag",
        action: "curator-regression",
        afterRevisionId: null,
        beforeRevisionId: "doc:2",
        createdAt: new Date("2026-09-12Z"),
      },
    ],
  );
  expect(entries).toHaveLength(3);
  expect(entries.map((e) => e.action)).toEqual(["curator-regression", "grant-created", "applied"]);
  expect(entries[2]).toMatchObject({
    at: revision.createdAt,
    proposalId: "proposal",
    revisionId: "doc:2",
  });
  expect(JSON.stringify(entries)).not.toContain("2099");
  expect(
    learningJourney(
      [{ ...revision, learning: { ...revision.learning!, action: "revert" } }],
      [],
    )[0]!.action,
  ).toBe("revert");
});
