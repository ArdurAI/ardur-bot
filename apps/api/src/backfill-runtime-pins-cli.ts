import { EncryptedSecretStore } from "@ardurbot/adapters";
import { resolveEncryptionKey } from "@ardurbot/core";
import { loadRootEnv } from "@ardurbot/core/node/load-root-env";
import { createDb } from "@ardurbot/db";
import { createServiceLogger, SERVICE_NAMES } from "@ardurbot/logging";
import { backfillRuntimePins } from "./backfill-runtime-pins.js";

loadRootEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
const { prisma, pool } = createDb(databaseUrl);
try {
  await backfillRuntimePins({
    prisma,
    secrets,
    logger: createServiceLogger({ service: SERVICE_NAMES.api }),
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
