import type { PrismaClient } from "@ardurbot/db";
import { createEvidenceStore } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { EncryptedSecretStore } from "../secrets.js";
import { createEvidenceRecorder } from "./recorder.js";

export function createRunEvidenceRecorder(deps: {
  prisma: PrismaClient;
  secretStore: Pick<EncryptedSecretStore, "put" | "load">;
}) {
  return createEvidenceRecorder({
    store: createEvidenceStore(deps.prisma),
    secretStore: deps.secretStore,
    logFailure: (codes) => getLogger().warn("evidence verification failed", { codes }),
  });
}
