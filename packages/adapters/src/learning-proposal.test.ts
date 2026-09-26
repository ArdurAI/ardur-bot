import { describe, expect, it } from "vitest";
import { proposalFingerprint } from "./learning-proposal.js";

// Pinned by hashing each candidate with the fingerprint code that shipped before the
// board-item field existed (the version still on dev). A non-board proposal must keep
// hashing to the same value after the board-item field is added, or every existing
// learning_suppressions row and stored proposal fingerprint goes stale on deploy.
describe("proposalFingerprint pins existing hashes", () => {
  it("memory", () => {
    expect(
      proposalFingerprint({
        type: "memory",
        scope: { spaceId: "space-1", userId: "user-1" },
        target: { documentId: "doc-1" },
        proposedContent: "Remember the customer's timezone is PST.",
        rationale: "The user stated it directly.",
        evidenceIds: ["evidence-1"],
      }),
    ).toBe("0bb4395ed1ffd0ebb15a35b9acdd482942805fcef1776b64cc340395c505dc21");
  });
  it("skill", () => {
    expect(
      proposalFingerprint({
        type: "skill",
        scope: { spaceId: "space-1", botId: "bot-1" },
        target: { documentId: "skill-doc-1" },
        proposedContent: "When exporting CSV, quote fields containing commas.",
        rationale: "The user corrected this twice.",
        evidenceIds: ["evidence-1"],
      }),
    ).toBe("88bfa50b66e9a2e08510cea2e7ea11bbd05c4f485161572384c3c91cc691802c");
  });
  it("preference", () => {
    expect(
      proposalFingerprint({
        type: "preference",
        scope: { spaceId: "space-1", userId: "user-1" },
        target: { settingKey: "notifyOnFinish" },
        typedDelta: { key: "notifyOnFinish", value: true },
        rationale: "The user asked for a notification every time.",
        evidenceIds: ["evidence-1"],
      }),
    ).toBe("698f9d5cfb5e7b05268db9bff6fdd57968c85b6333fb409e10fe0f2092d4c450");
  });
  it("policy", () => {
    expect(
      proposalFingerprint({
        type: "policy-suggestion",
        scope: { spaceId: "space-1", botId: "bot-1" },
        target: { settingKey: "policy.tool.email" },
        typedDelta: { key: "policy.tool.email", value: "ask" },
        rationale: "Email sends should be confirmed.",
        evidenceIds: ["evidence-1"],
      }),
    ).toBe("ef15890e7eef52a85136fbff6de0f64aea419c05104a2ad60fcfe44b21b70503");
  });
  it("curator (a memory revision with an operation)", () => {
    expect(
      proposalFingerprint({
        type: "memory",
        scope: { spaceId: "space-1", userId: "user-1" },
        target: { documentId: "doc-1" },
        proposedContent: "Consolidated memory text.",
        operation: "consolidation",
        participatingRevisions: [{ documentId: "doc-1", revision: 3 }],
        rationale: "These revisions say the same thing.",
        evidenceIds: ["evidence-1"],
      }),
    ).toBe("fa7e4fd57b4fb88e07f7e30d25203a016d85764285f1074c07a94fb4f53d18f8");
  });
});

it("a board-item proposal fingerprints differently from the same proposal without it", () => {
  const withoutBoardItem = proposalFingerprint({
    type: "memory",
    scope: { spaceId: "space-1", userId: "user-1" },
    target: {},
    proposedContent: "Fix the export bug",
    rationale: "The user asked for this fix.",
    evidenceIds: ["evidence-1"],
  });
  const withBoardItem = proposalFingerprint({
    type: "board-item",
    scope: { spaceId: "space-1", userId: "user-1" },
    target: {},
    boardItem: {
      title: "Fix the export bug",
      description: "Exports drop the last row.",
      acceptanceCriteria: "Export includes every row.",
      workspaceId: "workspace-1",
    },
    rationale: "The user asked for this fix.",
    evidenceIds: ["evidence-1"],
  });
  expect(withBoardItem).not.toBe(withoutBoardItem);
});
