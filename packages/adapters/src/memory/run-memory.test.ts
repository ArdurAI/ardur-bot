import type { MemoryService } from "@ardurbot/memory";
import { describe, expect, it, vi } from "vitest";
import { forgetRunMemory, saveRunMemory } from "./run-memory.js";

describe("executor document hooks", () => {
  const context = {
    spaceId: "space",
    userId: "user",
    botId: "bot",
    runId: "run",
    threadId: "thread",
    operationId: "run",
    traceId: "run",
    signal: new AbortController().signal,
  };
  it("saves an authoritative document and reports pending indexing, without a vendor-only path", async () => {
    const save = vi.fn(async () => ({ id: "doc", revision: 1, delivery: { status: "pending" } }));
    const deps = { memory: {} as never, memoryDocuments: { save } as unknown as MemoryService };
    expect(await saveRunMemory(deps, { content: "Safe fact" }, context)).toEqual({
      ok: true,
      documentId: "doc",
      revision: 1,
      status: "Saved; indexing pending",
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "bot", botId: "bot", content: "Safe fact" }),
      context,
    );
    await expect(
      saveRunMemory({ memory: {} as never }, { content: "Safe fact" }, context),
    ).rejects.toThrow("unavailable");
  });
  it("forgets by an authorized document id and ignores model-supplied namespaces", async () => {
    const remove = vi.fn();
    const read = vi.fn(async () => ({ id: "doc", revision: 3 }));
    const service = { read, delete: remove } as unknown as MemoryService;
    await forgetRunMemory(service, "doc", context);
    expect(remove).toHaveBeenCalledWith("doc", 3, context);
    read.mockResolvedValueOnce(null as never);
    expect(await forgetRunMemory(service, "forged", context)).toMatchObject({ ok: false });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
