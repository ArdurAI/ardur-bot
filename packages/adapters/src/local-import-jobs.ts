import type { BackgroundJobHandlers } from "@ardurbot/adapter-kit";
import type { LocalImportResponse } from "@ardurbot/contracts/local-import";
import type { PrismaClient } from "@ardurbot/db";
import { hostWorkerToken } from "@ardurbot/host-runtime/worker-auth";
import type { MemoryService } from "@ardurbot/memory";
import { createImportTransport, LocalImportService, localImportStop } from "./local-import.js";

export type LocalImportJobOptions = {
  apiUrl: string;
  encryptionKey: string;
  packaged: boolean;
  reply?: (id: string, response: LocalImportResponse) => void;
};
export function createLocalImportJobs(
  prisma: PrismaClient,
  documents: MemoryService,
  options: LocalImportJobOptions,
): Pick<BackgroundJobHandlers, "local-import.run" | "local-import.refresh"> {
  const service = new LocalImportService({
    prisma,
    documents,
    transport: createImportTransport(prisma, options),
  });
  return {
    "local-import.refresh": () => service.refresh(),
    "local-import.run": async (job) => {
      let response: LocalImportResponse;
      let failure: unknown;
      try {
        response = await service.run({ spaceId: job.spaceId, userId: job.userId }, job.action);
      } catch (error) {
        failure = error;
        response = { stopped: localImportStop(error) ?? "failed" };
      }
      if (options.reply) options.reply(job.requestId, response);
      else {
        const result = await fetch(new URL("/api/local-import/result", options.apiUrl), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `Bearer ${hostWorkerToken(options.encryptionKey)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requestId: job.requestId, response }),
        }).catch(() => {
          throw new Error("The import result could not reach the API. Check API_INTERNAL_URL.");
        });
        if (!result.ok) throw new Error("The import result could not be delivered.");
      }
      // The page already has its answer; rethrowing logs this job as failed with the error.
      if (failure) throw failure;
    },
  };
}
