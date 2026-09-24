import { CHAT_COPY } from "@ardurbot/contracts";
import type { ChatInstallation, PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { deliverChatOutbox } from "./delivery.js";
import type { ChatTransport } from "./transport.js";
import { ProviderResponseError } from "./transport.js";

const installation = { id: "installation" } as ChatInstallation;
function fixture() {
  const row = {
    id: "outbox",
    key: "summary:task",
    installationId: "installation",
    taskId: "task",
    card: { text: "A final result" },
    destination: { workspaceId: "telegram", channelId: "channel" },
    state: "pending",
    sentChunks: 0,
    providerMessageId: null as string | null,
  };
  const tx = {
    chatOutbox: {
      findMany: vi.fn(async () => (row.state === "pending" ? [row] : [])),
      updateMany: vi.fn(async ({ data }) => {
        if (row.state !== "pending") return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => Object.assign(row, data)),
    },
    messagingTaskOrigin: { findUnique: vi.fn(async () => ({ grantId: "grant" })) },
    deviceGrant: {
      findFirst: vi.fn(async () => ({
        id: "grant",
        userId: "owner",
        spaceId: "space",
        scopes: ["read"],
      })),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member" })) },
    dispatchSummary: { updateMany: vi.fn() },
  };
  const send = vi.fn(async () => "receipt");
  const deliver = () =>
    deliverChatOutbox(
      tx as unknown as PrismaClient,
      installation,
      { send } as unknown as ChatTransport,
      new AbortController().signal,
      ["known-placeholder"],
    );
  return { tx, row, send, deliver };
}
describe("durable quiet delivery", () => {
  it("sends a completed summary once and acknowledges it durably", async () => {
    const f = fixture();
    await f.deliver();
    await f.deliver();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.row.state).toBe("sent");
    expect(f.tx.dispatchSummary.updateMany).toHaveBeenCalledOnce();
  });
  it("keeps network ambiguity uncertain across restarts instead of duplicating a result", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new ProviderResponseError(0));
    await f.deliver();
    await f.deliver();
    expect(f.row.state).toBe("uncertain");
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("schedules an explicit rate-limit rejection and keeps durable chunk progress", async () => {
    const f = fixture();
    f.row.sentChunks = 1;
    f.row.providerMessageId = "first";
    f.send.mockRejectedValue(new ProviderResponseError(429, 120_000));
    await f.deliver();
    expect(f.row.state).toBe("pending");
    expect(f.row.sentChunks).toBe(1);
    expect(f.tx.chatOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox" },
      data: { state: "pending", retryAt: expect.any(Date) },
    });
  });
  it("suppresses pending results after grant revocation", async () => {
    const f = fixture();
    f.tx.deviceGrant.findFirst.mockResolvedValueOnce(null as never);
    await f.deliver();
    expect(f.row.state).toBe("suppressed");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not send known credentials in a result", async () => {
    const f = fixture();
    f.row.card.text = "known-placeholder";
    await f.deliver();
    expect(f.send).toHaveBeenCalledWith(
      expect.anything(),
      { text: CHAT_COPY.secrets },
      expect.anything(),
      expect.anything(),
    );
  });
});
