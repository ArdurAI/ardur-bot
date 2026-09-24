import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemorySearchRequest,
  MemoryStore,
  PortableFile,
} from "@ardurbot/adapter-kit";
import type { MemoryService } from "./service.js";

/** Keeps runtimes using MemoryStore on the same authorized lifecycle as Settings. */
export class LifecycleMemoryStore implements MemoryStore {
  constructor(readonly service: MemoryService) {}
  describe() {
    return {
      id: "documents",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }
  async read(input: MemoryReadRequest, context: AdapterContext) {
    const documents = (
      await this.service.exportBundle({ ...context, memoryRecall: true })
    ).documents
      .map((doc) => doc.revisions.at(-1)!)
      .filter(
        (r) =>
          !r.deletedAt &&
          (r.scopeKey.kind === input.scope ||
            (input.scope === "user" && r.scopeKey.kind === "space-shared")) &&
          (!input.botId || (r.scopeKey.kind === "bot" && r.scopeKey.botId === input.botId)) &&
          (!input.path || r.path === input.path),
      );
    return {
      documents: documents.map((r) => ({
        id: r.documentId,
        path: r.path,
        content: r.content,
        revision: r.revision,
        updatedAt: r.createdAt,
      })),
    };
  }
  async search(input: MemorySearchRequest, context: AdapterContext) {
    const docs = (
      await this.service.exportBundle({ ...context, memoryRecall: true })
    ).documents.map((d) => d.revisions.at(-1)!);
    return docs
      .filter(
        (d) =>
          !d.deletedAt &&
          (input.scope === "all" || d.scopeKey.kind === input.scope) &&
          (!input.botId || (d.scopeKey.kind === "bot" && d.scopeKey.botId === input.botId)) &&
          `${d.path}\n${d.content}`.toLowerCase().includes(input.query.toLowerCase()),
      )
      .map((d) => ({ path: d.path, snippet: d.content.slice(0, 240), score: 1 }));
  }
  async commit(input: MemoryCommitRequest, context: AdapterContext) {
    return this.service.save(input, {
      ...context,
      threadId: input.sourceThreadId,
      runId: input.sourceRunId ?? context.runId,
    });
  }
  async *exportMarkdown(
    input: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const bundle = await this.service.exportBundle(context);
    for (const doc of bundle.documents) {
      const r = doc.revisions.at(-1)!;
      if (
        r.deletedAt ||
        (input.scope !== "all" && input.scope !== r.scopeKey.kind) ||
        (input.botId && (r.scopeKey.kind !== "bot" || r.scopeKey.botId !== input.botId))
      )
        continue;
      yield { path: r.path, content: new TextEncoder().encode(r.content) };
    }
  }
  async importMarkdown(files: AsyncIterable<PortableFile>, context: AdapterContext) {
    let last: Awaited<ReturnType<MemoryService["save"]>> | undefined;
    for await (const file of files)
      last = await this.service.save(
        { scope: "user", path: file.path, content: new TextDecoder().decode(file.content) },
        context,
      );
    if (!last) throw new Error("No memory files to import.");
    return last;
  }
}
