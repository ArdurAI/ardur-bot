import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

vi.mock("@playwright/test", () => ({ expect }));

import { rpc } from "./helpers";

function fixture(status: number, text: string) {
  const post = vi.fn().mockResolvedValue({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  return { page: { request: { post } } as unknown as Page, post };
}

describe("e2e RPC helper", () => {
  it("keeps the POST envelope and unwraps a successful JSON reply", async () => {
    const { page, post } = fixture(200, '{"json":{"threadId":"thread"}}');

    await expect(rpc(page, "threads/get", { groupId: "room" })).resolves.toEqual({
      threadId: "thread",
    });
    expect(post).toHaveBeenCalledExactlyOnceWith("/rpc/threads/get", {
      data: { json: { groupId: "room" } },
    });
  });

  it.each([
    [404, "404 Not Found"],
    [502, "<html><body>Bad Gateway</body></html>"],
    [200, "invalid JSON"],
  ])("reports a non-JSON reply with status %s and its first bytes", async (status, text) => {
    const { page } = fixture(status, text);

    await expect(rpc(page, "runs/get", { runId: "run" })).rejects.toThrow(
      `runs/get ${status}: expected JSON, received ${JSON.stringify(text)}`,
    );
  });

  it("bounds the response excerpt", async () => {
    const { page } = fixture(502, `${"x".repeat(200)}omitted-tail`);

    await expect(rpc(page, "threads/get", { groupId: "room" })).rejects.toEqual(
      new Error(`threads/get 502: expected JSON, received ${JSON.stringify("x".repeat(200))}`),
    );
  });

  it("preserves JSON error messages", async () => {
    const { page } = fixture(403, '{"error":{"message":"Forbidden"}}');

    await expect(rpc(page, "threads/get", { groupId: "room" })).rejects.toThrow(
      "threads/get 403: Forbidden",
    );
  });

  it("still rejects an unsuccessful HTTP status with a JSON reply", async () => {
    const { page } = fixture(500, '{"json":null}');

    await expect(rpc(page, "threads/get", { groupId: "room" })).rejects.toThrow(
      "threads/get 500: failed",
    );
  });
});
