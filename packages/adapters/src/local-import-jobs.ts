import type { BackgroundJobHandlers } from "@ardurbot/adapter-kit";
import type { LocalImportResponse, LocalImportStop } from "@ardurbot/contracts/local-import";
import type { PrismaClient } from "@ardurbot/db";
import { LocalImportRescanError } from "@ardurbot/host-runtime/import/scanner";
import { hostWorkerToken } from "@ardurbot/host-runtime/worker-auth";
import type { MemoryService } from "@ardurbot/memory";
import {
  createImportTransport,
  LocalImportHostError,
  LocalImportService,
  localImportStop,
} from "./local-import.js";

/** The mirror of `localImportStop`: a returned stop needs an error to fail the job with. */
function stopError(stopped: LocalImportStop): Error {
  if (stopped === "host") return new LocalImportHostError();
  if (stopped === "rescan") return new LocalImportRescanError();
  return new Error("Import stopped because of an unexpected error.");
}

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
        // A run can stop partway through without throwing, but it still made no more
        // progress than a thrown error would have; the job must log it the same way.
        if (response.stopped) failure = stopError(response.stopped);
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
