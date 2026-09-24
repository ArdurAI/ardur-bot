import type { Actor } from "@ardurbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function fixture() {
  const commit = vi.fn();
  const findFirst = vi.fn().mockResolvedValue({ id: "bot", thread: { id: "thread" } });
  const handler = new RPCHandler(
    createRouter({
      env: { webOrigin: "http://example.test" },
      prisma: { bot: { findFirst } },
      memory: { commit },
    } as unknown as RouterDeps),
  );
  async function request(input: unknown) {
    const result = await handler.handle(
      new Request("http://example.test/rpc/memory/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: { spaceId: "space", userId: "owner" } as Actor } },
    );
    return result.response;
  }
  return { commit, findFirst, request };
}
describe("composer memory", () => {
  it("uses the existing scoped memory store and a separate note per submission", async () => {
    const f = fixture();
    expect(
      (await f.request({ botId: "bot", text: "Keep citations", nonce: "note-1" })).status,
    ).toBe(200);
    expect(f.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      id: "bot",
      spaceId: "space",
      userId: "owner",
    });
    expect(f.commit.mock.calls[0]?.[0]).toEqual({
      scope: "bot",
      botId: "bot",
      path: "notes/note-1.md",
      content: "Keep citations",
      sourceThreadId: "thread",
    });
  });
  it("rejects empty notes, unsafe names and unowned bots", async () => {
    const f = fixture();
    expect((await f.request({ botId: "bot", text: " ", nonce: "note" })).status).toBe(400);
    expect((await f.request({ botId: "bot", text: "note", nonce: "../other" })).status).toBe(400);
    f.findFirst.mockResolvedValueOnce(null);
    expect((await f.request({ botId: "other", text: "note", nonce: "note" })).status).not.toBe(200);
    expect(f.commit).not.toHaveBeenCalled();
  });
});
