import type { ChiefMemberFacts } from "@ardurbot/contracts";
import { TASK_TYPES, ThreadSendResultSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  CHIEF_RECEIPT_TEMPLATES,
  CHIEF_TASK_RULES,
  chiefIntent,
  chiefRule,
  chooseChiefMember,
} from "./chief-loop-policy.js";
import { approvalFor } from "./integration-policy.js";

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
  it("returns needs-owner blocker for create-issue when capability is missing or unknown", () => {
    const input = {
      chiefId: "chief",
      operation: { taskType: "operations", purpose: "create-issue" } as const,
      members: [
        member("a", {
          capabilities: [{ id: "linear:read-back", access: "missing", checkedAt: "now" }],
        }),
        member("b", {
          capabilities: [{ id: "linear:read-back", access: "unknown", checkedAt: "now" }],
        }),
        member("c", { capabilities: [] }),
      ],
    };
    expect(chooseChiefMember(input)).toEqual({
      kind: "needs-owner",
      blockerKey: "connect-linear",
      blocker: "Connect Linear or grant a team member permission to read and write.",
    });

    // Test tie-breaking for equal members
    const capable = member("d", {
      capabilities: [
        { id: "linear:read-back", access: "known", checkedAt: "now" },
        { id: "linear:write", access: "known", checkedAt: "now" },
      ],
    });
    const capable2 = member("e", {
      capabilities: [
        { id: "linear:read-back", access: "known", checkedAt: "now" },
        { id: "linear:write", access: "known", checkedAt: "now" },
      ],
    });
    expect(chooseChiefMember({ ...input, members: [capable2, capable] })).toMatchObject({
      kind: "delegate",
      memberId: "d", // 'd' comes before 'e' in tie-break by ID
    });
  });
  describe.each([
    ["linear", { taskType: "operations", purpose: "create-issue" }],
    ["github", { taskType: "code-change", purpose: "manage-repository" }],
  ] as const)("%s selection matrix", (app, operation) => {
    const capable = (id: string, patch: Partial<ChiefMemberFacts> = {}) =>
      member(id, {
        capabilities: [
          { id: `${app}:read-back`, access: "known", checkedAt: "now" },
          { id: `${app}:write`, access: "known", checkedAt: "now" },
        ],
        ...patch,
      });
    const choose = (members: ChiefMemberFacts[]) =>
      chooseChiefMember({ chiefId: "chief", operation, members });
    it.each(["missing", "unknown"] as const)(
      "blocks a disconnected or uncertain app (%s)",
      (access) => {
        expect(
          choose([
            capable("a", {
              capabilities: [
                { id: `${app}:read-back`, access, checkedAt: "now" },
                { id: `${app}:write`, access, checkedAt: "now" },
              ],
            }),
          ]),
        ).toMatchObject({ kind: "needs-owner", blockerKey: `connect-${app}` });
      },
    );
    it("rejects read-only access for a write task and chooses a writer", () => {
      const reader = capable("a", {
        capabilities: [{ id: `${app}:read-back`, access: "known", checkedAt: "now" }],
      });
      expect(choose([reader])).toMatchObject({ kind: "needs-owner" });
      expect(choose([reader, capable("b")])).toMatchObject({ kind: "delegate", memberId: "b" });
    });
    it("selects preparation without approving the write", () => {
      expect(choose([capable("a")])).toMatchObject({ kind: "delegate", memberId: "a" });
      expect(chiefRule(operation).effect).toBe("approval-required");
      expect(
        approvalFor(
          {
            available: true,
            toolPolicies: { create_item: { approval: "allow", risk: "reviewed-read" } },
          },
          "create_item",
          {},
        ),
      ).toBe("ask-first");
    });
    it("blocks when write permission changes since planning", () => {
      const writer = capable("a");
      expect(choose([writer])).toMatchObject({ kind: "delegate", memberId: "a" });
      expect(
        choose([
          {
            ...writer,
            capabilities: writer.capabilities.filter((fact) => fact.id !== `${app}:write`),
          },
        ]),
      ).toMatchObject({ kind: "needs-owner" });
    });
    it("avoids a busy computer when an equally capable member is ready and queues otherwise", () => {
      const busy = capable("a", {
        computer: { id: "busy", kind: "docker", state: "running", local: true, leaseBusy: true },
      });
      expect(choose([busy, capable("b")])).toMatchObject({ kind: "delegate", memberId: "b" });
      expect(choose([busy])).toMatchObject({ kind: "queue", memberId: "a" });
    });
    it("breaks equal ties by id regardless of roster order", () => {
      for (const members of [
        [capable("b"), capable("a")],
        [capable("a"), capable("b")],
      ])
        expect(choose(members)).toMatchObject({ kind: "delegate", memberId: "a" });
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
  describe("chiefIntent app templates", () => {
    it.each([
      "create an issue in linear",
      "Create an issue in Linear.",
      "please file a ticket on linear!",
      "open ticket on linear",
      "file issue in linear",
      "please open an issue on linear",
    ])("identifies create-issue intent for Linear: %s", (text) => {
      const intent = chiefIntent({ text, taskType: "unknown" });
      expect(intent).toEqual({
        key: "create-issue",
        operation: {
          taskType: "operations",
          purpose: "create-issue",
        },
        receiptOnly: false,
      });
      expect(CHIEF_RECEIPT_TEMPLATES[intent.key]).toBe(
        "Got it — I’ll choose a team member to file this issue in Linear.",
      );
    });

    it.each([
      "manage repository on github",
      "Manage the repository on GitHub.",
      "please push the code to github!",
      "push repo to github",
      "manage the repo on github.",
      "push code on github",
    ])("identifies manage-repository intent for GitHub: %s", (text) => {
      const intent = chiefIntent({ text, taskType: "unknown" });
      expect(intent).toEqual({
        key: "manage-repository",
        operation: {
          taskType: "code-change",
          purpose: "manage-repository",
        },
        receiptOnly: false,
      });
      expect(CHIEF_RECEIPT_TEMPLATES[intent.key]).toBe(
        "Got it — I’ll choose a team member to manage the GitHub repository.",
      );
    });

    it.each([
      "create an issue in jira",
      "file a ticket on gitlab",
      "manage repository on bitbucket",
      "push code to sourceforge",
      "create issue",
      "manage repository",
      "please put this long document in linear",
      `create an issue in linear ${"extra ".repeat(200)}`,
    ])("does not match unrelated, other-service, or oversized requests: %s", (text) => {
      const intent = chiefIntent({ text, taskType: "unknown" });
      expect(intent.key).not.toBe("create-issue");
      expect(intent.key).not.toBe("manage-repository");
      expect(intent.operation.purpose).not.toBe("create-issue");
      expect(intent.operation.purpose).not.toBe("manage-repository");
    });
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
