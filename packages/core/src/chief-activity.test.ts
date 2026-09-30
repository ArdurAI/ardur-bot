import type { ChiefActivity, ChiefDispatch } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  CHIEF_ACTIVITY_TEXT,
  chiefActivityKey,
  chiefActivityShouldPublish,
  chiefResult,
  chiefToolActivity,
  staleChiefActivity,
  withChiefActivity,
} from "./chief-activity.js";

const activity: ChiefActivity = {
  revision: 1,
  runId: "worker-run",
  delegationId: "assignment",
  attempt: 2,
  sourceSeq: 1,
  key: "read-input",
  state: "active",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const dispatch: ChiefDispatch = {
  requestMessageId: "request",
  revision: 1,
  memberId: "worker",
  memberName: "Member",
  state: "messaged",
  reason: "eligible",
  runId: activity.runId,
  delegationId: activity.delegationId,
};
describe("chief activity policy", () => {
  it("maps only instrumented identities and trusted capabilities", () => {
    expect(chiefToolActivity({ name: "read_file" })).toBe("read-input");
    for (const [capability, key] of [
      ["notion-connect", "connect-notion"],
      ["notion-write", "write-notion"],
      ["notion-read-back", "verify-notion"],
      ["package-check", "check-tool"],
    ] as const)
      expect(chiefToolActivity({ name: "adapter-tool", capability })).toBe(key);
    for (const name of [
      "shell",
      "mcp__notion__create_page",
      "connect https://private.invalid",
      "secret-token",
      "message_user",
    ])
      expect(CHIEF_ACTIVITY_TEXT[chiefToolActivity({ name })]).toBe("Working on the task");
  });
  it("ignores arguments, tool output, private URLs and message text", () => {
    const tool = {
      name: "shell",
      args: { command: "upload secret-token https://private.invalid" },
      text: "Done",
      output: "Connecting to Notion",
    };
    expect(chiefToolActivity(tool)).toBe("working");
  });
  it("rejects stale revisions, unrelated runs, attempts and duplicate cursors", () => {
    const current = withChiefActivity(dispatch, activity);
    for (const stale of [
      { ...activity, revision: 2 },
      { ...activity, runId: "other" },
      { ...activity, delegationId: "other" },
      { ...activity, attempt: 1, sourceSeq: 100 },
      activity,
    ])
      expect(withChiefActivity(current, stale)).toBe(current);
    expect(
      withChiefActivity(current, { ...activity, attempt: 3, sourceSeq: 0 }).activity?.attempt,
    ).toBe(3);
  });
  it("coalesces repeated starts to twice a second and immediately publishes changes", () => {
    const next = { ...activity, sourceSeq: 2, updatedAt: "2026-01-01T00:00:00.499Z" };
    expect(chiefActivityShouldPublish(activity, next)).toBe(false);
    expect(
      chiefActivityShouldPublish(activity, { ...next, updatedAt: "2026-01-01T00:00:00.500Z" }),
    ).toBe(true);
    expect(chiefActivityShouldPublish(activity, { ...next, key: "write-notion" })).toBe(true);
    expect(chiefActivityShouldPublish(activity, { ...next, state: "completed" })).toBe(true);
  });
  it("waits only for a still-active tool and gives terminals precedence", () => {
    expect(staleChiefActivity(activity, new Date("2026-01-01T00:00:14.999Z"))).toBeUndefined();
    expect(staleChiefActivity(activity, new Date("2026-01-01T00:00:15.000Z"))?.key).toBe(
      "waiting-tool",
    );
    const terminal = { ...activity, sourceSeq: 2, state: "completed" as const };
    const current = withChiefActivity(withChiefActivity(dispatch, activity), terminal);
    expect(chiefActivityKey(current)).toBeUndefined();
    expect(withChiefActivity(current, { ...activity, sourceSeq: 3 })).toBe(current);
    expect(staleChiefActivity(terminal, new Date("2026-01-01T00:01:00Z"))).toBeUndefined();
    expect(chiefActivityKey(dispatch)).toBe("working");
    expect(chiefActivityKey({ ...dispatch, state: "approval-held" })).toBeUndefined();
  });
  it("reload and replay produce the same durable one-line state", () => {
    const events = [
      activity,
      activity,
      { ...activity, sourceSeq: 2, key: "verify-notion" as const },
    ];
    const live = events.reduce(withChiefActivity, dispatch);
    const reloaded = JSON.parse(JSON.stringify(live)) as ChiefDispatch;
    expect(events.reduce(withChiefActivity, reloaded)).toEqual(live);
  });
});
describe("chief linked result", () => {
  const input = {
    requestMessageId: "request",
    revision: 1,
    artifactId: "draft",
    href: "https://www.notion.so/fixture-page",
  };
  const verification = {
    verdict: "pass" as const,
    independent: true,
    artifactId: "draft",
    revision: 1,
    destination: input.href,
    contentDigest: "digest",
    expectedContentDigest: "digest",
    effectReceiptId: "effect",
    pendingEffects: false,
  };
  it("requires an exact independent pass, not a link or a worker claim", () => {
    expect(chiefResult(input)?.state).toBe("draft");
    expect(chiefResult({ ...input, verification })?.state).toBe("verified-notion");
    for (const mismatch of [
      { independent: false },
      { verdict: "fail" as const },
      { revision: 2 },
      { artifactId: "other" },
      { destination: "https://www.notion.so/other" },
      { contentDigest: "wrong" },
      { effectReceiptId: "" },
      { pendingEffects: true },
    ])
      expect(chiefResult({ ...input, verification: { ...verification, ...mismatch } })?.state).toBe(
        "draft",
      );
  });
  it("rejects private destinations, credentials, query strings and non-artifact routes", () => {
    for (const href of [
      "https://private.invalid/page",
      "http://localhost/page",
      "javascript:alert(1)",
      "https://user:password@notion.so/page",
      "https://notion.so/page?token=fake",
      "artifact:other",
    ])
      expect(chiefResult({ ...input, href })).toBeUndefined();
    expect(chiefResult({ ...input, href: "artifact:draft" })?.state).toBe("draft");
  });
  it("keeps result copy to one sentence without automatic follow-up", () => {
    const copy = ["Done — added the document to Notion.", "The draft is ready."];
    for (const text of copy) {
      expect(text.match(/[.!]/g)).toHaveLength(1);
      expect(text).not.toContain("?");
    }
  });
});
