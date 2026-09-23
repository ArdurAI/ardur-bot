import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { integrationById } from "../packages/adapters/src/integration-catalog.js";
import { IntegrationManifestSchema } from "../packages/contracts/src/integration-catalog.js";
import { createDb } from "../packages/db/src/index.js";

// Run with: pnpm exec tsx scripts/capture-integration-manifest.ts <connection-id>
// DATABASE_URL comes from the caller's environment; never print it or credentials.
const connectionId = process.argv[2];
if (!connectionId || !process.env.DATABASE_URL) {
  throw new Error("Provide a connection id and set DATABASE_URL in your terminal.");
}
const { prisma, pool } = createDb(process.env.DATABASE_URL);
try {
  const connection = await prisma.mcpServer.findUnique({ where: { id: connectionId } });
  const descriptor = connection?.catalogId ? integrationById(connection.catalogId) : undefined;
  if (
    !connection?.enabled ||
    connection.connectionState !== "connected" ||
    !descriptor?.available
  ) {
    throw new Error("The connection must be connected and have a captured manifest.");
  }
  const manifest = IntegrationManifestSchema.parse(connection.manifest);
  // Deliberately omit identity, endpoint, connection id, credentials and raw schemas.
  const fixture = {
    vendor: descriptor.vendor,
    capturedAt: manifest.capturedAt,
    serverVersion: manifest.serverVersion,
    tools: manifest.tools,
  };
  const directory = fileURLToPath(
    new URL("../packages/adapters/src/__fixtures__/integrations/", import.meta.url),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}${descriptor.vendor}-${manifest.capturedAt.slice(0, 10)}.json`,
    `${JSON.stringify(fixture, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("Saved the sanitized manifest fixture.");
} finally {
  await prisma.$disconnect();
  await pool.end();
}
