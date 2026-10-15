import type { ChiefReceipt, ThreadMessage } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { applyChiefReceipt } from "./chief-receipts.js";

const receipt: ChiefReceipt = {
  id: "receipt",
  threadId: "room",
  seq: 2,
  botId: "chief",
  requestMessageId: "request",
  key: "greeting",
  text: "Hi everyone.",
  createdAt: "2026-01-01T00:00:00Z",
};
describe("shared chief receipt response handling", () => {
  it("does not create or replace runs, consume a cursor, or duplicate an event-first receipt", () => {
    const before = {
      threadId: "room",
      cursor: 1,
      run: { id: "active", status: "waiting_input" },
      messages: [] as ThreadMessage[],
    };
    const after = applyChiefReceipt(before, receipt)!;
    expect(after.run).toBe(before.run);
    expect(after.cursor).toBe(1);
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.runId).toBeUndefined();
    expect(applyChiefReceipt(after, receipt)).toBe(after);
  });
  it("keeps a blocked selection in the immediate response and event replay", () => {
    const blocked: ChiefReceipt = {
      ...receipt,
      key: "needs-owner",
      text: "Got it — this task needs you before I can assign it.",
      chiefDispatch: {
        requestMessageId: receipt.requestMessageId,
        revision: 1,
        memberId: "chief",
        memberName: "Chief",
        state: "needs-owner",
        blockerKey: "connect-linear",
        reason: "Connect Linear or grant a team member permission to read and write.",
      },
    };
    const snapshot = applyChiefReceipt(
      { threadId: "room", messages: [] as ThreadMessage[] },
      blocked,
    )!;
    expect(snapshot.messages[0]?.blocks[0]).toMatchObject({
      kind: "chief_receipt",
      key: "needs-owner",
      chiefDispatch: blocked.chiefDispatch,
    });
    expect(applyChiefReceipt(snapshot, blocked)).toBe(snapshot);
  });
  it("ignores old servers, unloaded or other rooms", () => {
    const before = { threadId: "another", messages: [] as ThreadMessage[] };
    expect(applyChiefReceipt(before, receipt)).toBe(before);
    expect(applyChiefReceipt(before)).toBe(before);
    expect(applyChiefReceipt(null, receipt)).toBeNull();
  });
});
