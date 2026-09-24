import { describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));

import {
  loadMemoryDocuments,
  loadMemoryHistory,
  loadMemorySyncState,
  memoryAttribution,
} from "./memory.js";

describe("native read-only memory contracts", () => {
  it("pages documents and history using shared schemas and no mutation endpoints", async () => {
    request
      .mockResolvedValueOnce({ items: [], nextCursor: "document-next" })
      .mockResolvedValueOnce({ items: [], nextCursor: 2 });
    expect(await loadMemoryDocuments("document-before")).toEqual({
      items: [],
      nextCursor: "document-next",
    });
    expect(await loadMemoryHistory("document", 4)).toEqual({ items: [], nextCursor: 2 });
    expect(request.mock.calls).toEqual([
      ["memory/list", { cursor: "document-before", limit: 50, includeDeleted: true }],
      ["memory/history", { documentId: "document", cursor: 4, limit: 50 }],
    ]);
  });
  it("rejects malformed server history and preserves author, bot, run and model labels", async () => {
    request.mockResolvedValueOnce({ items: [{}], nextCursor: null });
    await expect(loadMemoryHistory("document")).rejects.toThrow();
    expect(
      memoryAttribution({
        author: { kind: "bot", userId: "user", botId: "bot" },
        runId: "run",
        model: { provider: "local", modelId: "fixture", effort: "high" },
      } as never),
    ).toBe("bot · user · bot · run · local · fixture · high");
  });
  it("loads read-only Git status without a repository credential or mutation", async () => {
    request.mockClear();
    const state = { host: "github.com", branch: "main", proposalBranch: null, status: "last-copy" };
    request.mockResolvedValueOnce(state);
    expect(await loadMemorySyncState()).toEqual(state);
    expect(request).toHaveBeenCalledWith("memory/syncState", {});
  });
});
