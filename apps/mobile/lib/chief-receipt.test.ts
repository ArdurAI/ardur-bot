import type { ChiefReceipt, ThreadSendResult } from "@ardurbot/contracts";
import { ThreadSendResultSchema } from "@ardurbot/contracts";
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
  it.each([RU_MESSAGES, ZH_MESSAGES])(
    "translates all new receipt and dispatch strings",
    (catalog) => {
      for (const message of [
        "Got it — I’ll choose a team member to put this in Notion.",
        "Got it — I’ll check what’s missing and ask before installing it.",
        "Got it — I’ll check the request and choose the next step.",
        "Hi everyone.",
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
