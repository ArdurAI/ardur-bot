import type { ChiefReceipt, ThreadSendResult } from "@ardurbot/contracts";
import { ChiefDispatchSchema, MessageBlock, ThreadSendResultSchema } from "@ardurbot/contracts";
import { applyChiefReceipt } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./dispatch", () => ({
  dispatchClient: { loadHome: vi.fn(async () => null) },
  deviceRpc: vi.fn(),
}));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(),
  stopLiveNotifications: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import type { MobileSnapshot } from "./api";
import { applyMobileThreadEvent } from "./api";
import { chiefDispatchSummary, chiefReceiptText } from "./coordination";
import { activateUiLocale } from "./i18n";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

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
describe("phone chief receipts", () => {
  it("preserves named correction receipts and stop states at the message boundary", () => {
    const block = MessageBlock.parse({
      kind: "chief_receipt",
      requestMessageId: "request",
      key: "exclude-member",
      memberName: "Member",
      text: "Saved acknowledgement",
    });
    expect(block).toMatchObject({ memberName: "Member", key: "exclude-member" });
    const before: MobileSnapshot = {
      threadId: "room",
      messages: [],
      cursor: 0,
      olderCursor: null,
      run: null,
    };
    const after = applyMobileThreadEvent(before, {
      botId: "chief",
      seq: 1,
      type: "thread.message.created",
      payload: { messageId: "receipt", role: "bot", blocks: [block] },
    });
    expect(after?.messages[0]?.blocks).toEqual([block]);
    for (const state of ["requested", "confirmed", "uncertain"] as const) {
      const dispatch = {
        requestMessageId: "request",
        revision: 2,
        memberId: "worker",
        memberName: "Replacement",
        reason: "eligible",
        state: "messaged",
        stop: { revision: 1, memberName: "Member", state },
      };
      expect(ChiefDispatchSchema.parse(dispatch).stop).toEqual(dispatch.stop);
      expect(
        ChiefDispatchSchema.safeParse({
          ...dispatch,
          stop: { ...dispatch.stop, revision: 0 },
        }).success,
      ).toBe(false);
    }
  });

  it.each([RU_MESSAGES, ZH_MESSAGES])(
    "translates all new receipt and dispatch strings",
    (catalog) => {
      for (const message of [
        "Got it — I’ll choose a team member to put this in Notion.",
        "Got it — I’ll check what’s missing and ask before installing it.",
        "Got it — I’ll check the request and choose the next step.",
        "Hi everyone.",
        "Got it — I’ll keep {name} off this task.",
        "Got it — I’ll check this change before the next action.",
        "Told {name} to stand down",
        "Stopping {name}",
        "{name} stood down",
        "The previous action may have finished. I’ll check before retrying.",
        "Messaged {name}",
        "Queued for {name}",
        "Waiting for approval",
      ]) {
        expect(catalog[message]).toBeTruthy();
        if (message.includes("{name}")) expect(catalog[message]).toContain("{name}");
      }
    },
  );
  it("merges a receipt-only response and replay event once without changing pending work", () => {
    const sent: ThreadSendResult = ThreadSendResultSchema.parse({
      kind: "receipt-only",
      seq: 2,
      receipt,
    });
    const before: MobileSnapshot = {
      threadId: "room",
      groupId: "group",
      messages: [],
      cursor: 0,
      olderCursor: null,
      run: { id: "pending", status: "waiting_input" },
    };
    const after = applyChiefReceipt(before, sent.receipt)!;
    const replay = applyMobileThreadEvent(after, {
      botId: "chief",
      seq: 2,
      type: "thread.message.created",
      createdAt: receipt.createdAt,
      payload: { messageId: receipt.id, role: "bot", blocks: after.messages[0]!.blocks },
    })!;
    expect(replay.messages).toHaveLength(1);
    expect(replay.run).toEqual(before.run);
    expect(replay.messages[0]!.runId).toBeUndefined();
    expect(applyChiefReceipt(before)).toBe(before);
  });
  it("uses bounded native copy and committed dispatch state", () => {
    activateUiLocale("en");
    expect(chiefReceiptText("greeting")).toBe("Hi everyone.");
    const dispatch = {
      requestMessageId: "request",
      revision: 1,
      memberId: "worker",
      memberName: "Renamed",
      reason: "saved facts",
      state: "messaged" as const,
    };
    expect(chiefDispatchSummary(dispatch)).toBe("Messaged Renamed");
    expect(chiefDispatchSummary({ ...dispatch, state: "queued" })).toBe("Queued for Renamed");
    expect(chiefDispatchSummary({ ...dispatch, state: "approval-held" })).toBe(
      "Waiting for approval",
    );
  });
});
