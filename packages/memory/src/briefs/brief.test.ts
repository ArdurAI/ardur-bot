import type { MemoryAccess } from "@ardurbot/adapter-kit";
import { MemoryConflictError } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { JournalDocument } from "../journal.js";
import { JournalDocumentStore } from "../journal.js";
import { scopeKey } from "../scope.js";
import { MemoryService } from "../service.js";
import { appendBrief, BRIEF_SECTIONS, normalizeBrief, readBrief, rewriteBrief } from "./brief.js";

function fixture() {
  let records: JournalDocument[] = [];
  let now = new Date("2026-09-24T12:00:00Z");
  let tail: Promise<unknown> = Promise.resolve();
  const context: MemoryAccess = {
    operationId: "test",
    traceId: "test",
    spaceId: "space",
    userId: "owner",
    botId: "chief",
    botIds: ["chief"],
    groupIds: ["alpha", "beta"],
    groupId: "alpha",
    runId: "run",
    signal: new AbortController().signal,
  };
  const store = new JournalDocumentStore(
    {
      transaction: async (_access, action) => {
        const copy = structuredClone(records);
        const result = await action(copy);
        records = copy;
        return result;
      },
    },
    "test",
    () => now,
  );
  const service = new MemoryService({
    enqueue: vi.fn(),
    open: (ctx, action) => {
      const work = tail.then(() =>
        action({ access: { ...context, ...ctx }, store, generation: 0, semantic: null }),
      );
      tail = work.catch(() => undefined);
      return work;
    },
  });
  const rewrite = (text: string) =>
    rewriteBrief({
      service,
      botId: "chief",
      groupId: "alpha",
      context,
      summarize: async () => text,
      now,
    });
  return {
    context,
    service,
    rewrite,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
describe("group brief journal", () => {
  it("rewrites one structured document per bot and group, capped by section", async () => {
    const f = fixture();
    const text = BRIEF_SECTIONS.map((section) => `## ${section}\n${section.repeat(4000)}`).join(
      "\n",
    );
    const first = await f.rewrite(text);
    expect(first.document?.content.length).toBeLessThanOrEqual(6000);
    expect(first.document?.content.match(/^## /gm)).toHaveLength(5);
    expect(scopeKey(first.document!.scopeKey)).toBe("chief:alpha");
    expect((await f.rewrite("## Goal\nNew goal")).document?.revision).toBe(2);
    const second = await rewriteBrief({
      service: f.service,
      context: { ...f.context, groupId: "beta" },
      botId: "chief",
      groupId: "beta",
      summarize: async () => "## Goal\nOther project",
    });
    expect(second.document?.id).not.toBe(first.document?.id);
    expect(await readBrief(f.service, "chief", "beta", f.context)).toBeNull();
    const direct = await rewriteBrief({
      service: f.service,
      context: { ...f.context, groupId: "direct" },
      botId: "chief",
      groupId: null,
      summarize: async () => "## Goal\nPersonal work",
    });
    expect(scopeKey(direct.document!.scopeKey)).toBe("chief:direct");
  });
  it("preserves a recent owner edit and appends only open items", async () => {
    const f = fixture();
    const first = await f.rewrite("## Goal\nOriginal");
    const edited = normalizeBrief("## Goal\nOwner goal\n## Last decisions\nKeep this decision");
    await f.service.update(first.document!.id, edited, 1, { ...f.context, runId: undefined });
    f.advance(10_000);
    const result = await f.rewrite("## Goal\nModel goal\n## Open items\nCheck the deadline");
    expect(result.document?.content).toContain("Owner goal");
    expect(result.document?.content).toContain("Keep this decision");
    expect(result.document?.content).toContain("Check the deadline");
    expect(result.document?.content).not.toContain("Model goal");
    expect(result.reason).toBeNull();
    f.advance(3_600_000);
    expect((await f.rewrite("## Goal\nNext goal")).document?.content).toContain("Next goal");
  });
  it("retries one stale revision as an append while keeping the concurrent edit", async () => {
    const f = fixture();
    const first = await f.rewrite("## Goal\nOriginal");
    const result = await rewriteBrief({
      service: f.service,
      context: f.context,
      botId: "chief",
      groupId: "alpha",
      summarize: async () => {
        await f.service.update(
          first.document!.id,
          normalizeBrief("## Goal\nConcurrent owner goal"),
          1,
          { ...f.context, runId: undefined },
        );
        return "## Goal\nStale goal\n## Open items\nFollow up";
      },
    });
    expect(result.document?.revision).toBe(3);
    expect(result.document?.content).toContain("Concurrent owner goal");
    expect(result.document?.content).toContain("Follow up");
    expect(result.document?.content).not.toContain("Stale goal");
  });
  it("finds a recent owner edit beyond the first page of automatic revisions", async () => {
    const f = fixture();
    const first = await f.rewrite("## Goal\nOriginal");
    const human = normalizeBrief("## Goal\nOwner goal");
    await f.service.update(first.document!.id, human, 1, { ...f.context, runId: undefined });
    for (let index = 0; index < 105; index++)
      await f.service.update(first.document!.id, `${human}\n${index}`, index + 2, f.context);
    const result = await f.rewrite("## Goal\nReplacement\n## Open items\nFollow up");
    expect(result.document?.content).toContain("Owner goal");
    expect(result.document?.content).not.toContain("Replacement");
    expect(result.document?.content).toContain("Follow up");
  });
  it("retries a concurrent memory creation as an append", async () => {
    const f = fixture();
    const commit = f.service.commit.bind(f.service);
    vi.spyOn(f.service, "commit").mockImplementationOnce(async (input, context) => {
      await commit({ ...input, content: "Concurrent fact" }, context);
      return commit(input, context);
    });
    const result = await f.service.save(
      { scope: "bot", path: "shared.md", content: "New fact" },
      f.context,
    );
    expect(result.revision).toBe(2);
    expect(result.content).toBe("Concurrent fact\n\nNew fact");
  });
  it("reapplies only the addition from an explicitly observed stale revision", async () => {
    const f = fixture();
    const first = await f.service.save(
      { scope: "bot", path: "shared.md", content: "Original" },
      f.context,
    );
    await f.service.update(first.id, "Original\n\nOther group", 1, {
      ...f.context,
      runId: undefined,
    });
    const result = await f.service.save(
      { scope: "bot", path: "shared.md", content: "Original\n\nNew fact", expectedRevision: 1 },
      f.context,
    );
    expect(result.revision).toBe(3);
    expect(result.content).toBe("Original\n\nOther group\n\nNew fact");
  });
  it("leaves the document unchanged without a usable model and never exceeds its cap when appending", async () => {
    const f = fixture();
    const first = await f.rewrite("## Goal\nOriginal");
    const result = await rewriteBrief({
      service: f.service,
      context: f.context,
      botId: "chief",
      groupId: "alpha",
      summarize: async () => null,
    });
    expect(result.reason).toBe("Model unavailable");
    expect(result.document?.revision).toBe(first.document?.revision);
    expect(appendBrief("x".repeat(6000), "addition")).toHaveLength(6000);
  });
  it("retries an automatic memory save once as an append and refuses a second conflict", async () => {
    const f = fixture();
    const first = await f.service.save(
      { scope: "bot", path: "facts.md", content: "Original" },
      f.context,
    );
    const commit = f.service.commit.bind(f.service);
    const spy = vi.spyOn(f.service, "commit").mockImplementationOnce(async (input, context) => {
      await f.service.update(first.id, "Concurrent fact", 1, { ...context, runId: undefined });
      return commit(input, context);
    });
    const result = await f.service.save(
      { scope: "bot", path: "facts.md", content: "New fact" },
      f.context,
    );
    expect(result.content).toBe("Concurrent fact\n\nNew fact");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRejectedValue(new MemoryConflictError());
    await expect(
      f.service.save({ scope: "bot", path: "facts.md", content: "Another" }, f.context),
    ).rejects.toThrow(MemoryConflictError);
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
