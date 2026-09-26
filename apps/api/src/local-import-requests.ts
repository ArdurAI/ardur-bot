import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { ImportOwner } from "@ardurbot/adapters";
import type { LocalImportAction, LocalImportResponse } from "@ardurbot/contracts/local-import";
import { LocalImportResponseSchema } from "@ardurbot/contracts/local-import";

/** Bodies used only for Preview remain in request memory, never in jobs or the database. */
export class LocalImportRequests {
  private pending = new Map<
    string,
    { resolve(response: LocalImportResponse): void; reject(error: Error): void }
  >();
  constructor(private readonly jobs: JobPublisher) {}
  async run(owner: ImportOwner, action: LocalImportAction) {
    if (this.pending.size >= 4) throw new Error("Import is busy. Try again shortly.");
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<LocalImportResponse>((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Import did not finish. Re-scan and try again."));
      }, 10 * 60_000);
      timer.unref();
      this.pending.set(requestId, { resolve, reject });
    });
    // Observe the promise immediately even if enqueue itself fails or takes time.
    void result.catch(() => undefined);
    try {
      await this.jobs.enqueue({
        name: "local-import.run",
        payload: { requestId, spaceId: owner.spaceId, userId: owner.userId, action },
        replaceKey: `local-import:${requestId}`,
      });
      return await result;
    } finally {
      clearTimeout(timer!);
      this.pending.delete(requestId);
    }
  }
  complete(requestId: string, response: unknown) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    // A stopped run is a typed answer; only an unreadable reply becomes an error.
    const parsed = LocalImportResponseSchema.safeParse(response);
    if (parsed.success) pending.resolve(parsed.data);
    else pending.reject(new Error("Import could not finish. Re-scan and try again."));
  }
}
