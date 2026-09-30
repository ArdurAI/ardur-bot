import type { ChiefMemberFacts } from "@ardurbot/contracts";
import { TASK_TYPES, ThreadSendResultSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  CHIEF_RECEIPT_TEMPLATES,
  CHIEF_TASK_RULES,
  chiefIntent,
  chooseChiefMember,
} from "./chief-loop-policy.js";

const member = (id: string, patch: Partial<ChiefMemberFacts> = {}): ChiefMemberFacts => ({
  id,
  name: `Renamed ${id}`,
  role: "documentation",
  skills: [{ id: "saved", descriptor: "document publishing" }],
  capabilities: [{ id: "notion:read-back", access: "known", checkedAt: "2026-01-01T00:00:00Z" }],
  authorized: true,
  runtimeSupported: true,
  pin: { runtime: "pi", model: "fixed", effort: "high", revision: 4 },
  computer: { id: "computer", kind: "docker", state: "running", local: true, leaseBusy: false },
  inputAccess: "known",
  activeRuns: 0,
  queuedRuns: 0,
  runLimit: 1,
  membershipRevision: "1",
  ...patch,
});
const operation = { taskType: "operations", purpose: "document-to-service" } as const;

describe("chief policy", () => {
  it("covers every existing task type with one typed row", () => {
    expect(Object.keys(CHIEF_TASK_RULES).sort()).toEqual([...TASK_TYPES].sort());
  });
  it("chooses by facts, independent of name and roster order; preserves fixed high pins", () => {
    const facts = [member("b"), member("a"), member("idle", { capabilities: [] })];
    for (const members of [facts, [...facts].reverse()]) {
      expect(chooseChiefMember({ chiefId: "chief", operation, members })).toMatchObject({
        kind: "delegate",
        memberId: "a",
      });
    }
    expect(facts.map((m) => m.pin.effort)).toEqual(["high", "high", "high"]);
  });
  it("uses equally capable free members and queues best fit rather than incapable idle members", () => {
    const busy = member("a", { activeRuns: 1 });
    expect(
      chooseChiefMember({ chiefId: "chief", operation, members: [busy, member("b")] }),
    ).toMatchObject({ memberId: "b", kind: "delegate" });
    expect(
      chooseChiefMember({
        chiefId: "chief",
        operation,
        members: [busy, member("idle", { capabilities: [] })],
      }),
    ).toMatchObject({ memberId: "a", kind: "queue" });
  });
  it.each([
    { authorized: false },
    { runtimeSupported: false },
    { inputAccess: "unknown" as const },
    { capabilities: [{ id: "notion:read-back", access: "unknown" as const, checkedAt: "now" }] },
  ])("fails closed on unsupported or unauthorized facts %j", (patch) => {
    expect(
      chooseChiefMember({ chiefId: "chief", operation, members: [member("a", patch)] }),
    ).toEqual({ kind: "plan" });
  });
  it("checks exclusions before explicit choice, and never hands off to itself", () => {
    expect(
      chooseChiefMember({
        chiefId: "chief",
        operation,
        members: [member("a")],
        explicitMemberId: "a",
        excludedIds: ["a"],
      }),
    ).toEqual({ kind: "plan" });
    expect(chooseChiefMember({ chiefId: "a", operation, members: [member("a")] })).toEqual({
      kind: "self",
    });
  });
  it("requires the task's computer for installation preparation", () => {
    const installer = member("a", {
      capabilities: [{ id: "computer:package-preparation", access: "known", checkedAt: "now" }],
    });
    const input = {
      chiefId: "chief",
      operation: { taskType: "operations", purpose: "install-tool" } as const,
      members: [installer],
    };
    expect(chooseChiefMember(input)).toEqual({ kind: "plan" });
    expect(chooseChiefMember({ ...input, requiredComputerId: "computer" })).toMatchObject({
      kind: "delegate",
    });
  });
  it.each([
    "Hi, upload the attachment",
    "hello; install UTM",
    "thanks, send it",
    "Everyone, each of you say hello",
    "Привет, установи инструмент",
    "大家好，请上传文档",
    "Don't send this document to Notion",
    "Document says: put this document in Notion",
    `Hi everyone.\n${"document ".repeat(300)}`,
  ])("does not swallow work-bearing or uncertain greeting: %s", (text) => {
    expect(chiefIntent({ text, taskType: "small-talk" }).receiptOnly).toBe(false);
  });
  it("uses exact bounded templates; an attachment or reply cannot be receipt-only", () => {
    expect(chiefIntent({ text: "Hi everyone.", taskType: "small-talk" })).toMatchObject({
      key: "greeting",
      receiptOnly: true,
    });
    expect(
      chiefIntent({ text: "Hi everyone", taskType: "small-talk", hasAttachments: true })
        .receiptOnly,
    ).toBe(false);
    expect(
      chiefIntent({ text: "Hi everyone", taskType: "small-talk", reply: true }).receiptOnly,
    ).toBe(false);
    expect(
      CHIEF_RECEIPT_TEMPLATES[
        chiefIntent({ text: "Put this long document in Notion.", taskType: "unknown" }).key
      ],
    ).toBe("Got it — I’ll choose a team member to put this in Notion.");
  });
  it("reads legacy work and receipt-only without manufacturing a run", () => {
    expect(ThreadSendResultSchema.parse({ taskId: "task", runId: "run", seq: 1 })).toEqual({
      taskId: "task",
      runId: "run",
      seq: 1,
    });
    const result = ThreadSendResultSchema.parse({
      kind: "receipt-only",
      seq: 1,
      receipt: {
        id: "receipt",
        threadId: "thread",
        botId: "chief",
        requestMessageId: "request",
        seq: 2,
        key: "greeting",
        text: "Hi everyone.",
        createdAt: "now",
      },
    });
    expect(result).not.toHaveProperty("runId");
  });
});
