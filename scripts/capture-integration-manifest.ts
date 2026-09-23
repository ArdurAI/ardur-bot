import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { integrationById } from "../packages/adapters/src/integration-catalog.js";
import type {
  IntegrationDescriptor,
  IntegrationManifest,
} from "../packages/contracts/src/integration-catalog.js";
import { IntegrationManifestSchema } from "../packages/contracts/src/integration-catalog.js";
import { integrationToolKind } from "../packages/core/src/integration-policy.js";
import { createDb } from "../packages/db/src/index.js";

/** Candidates only. A maintainer must review the captured definitions before trusting them. */
export function proposedToolPolicies(
  manifest: IntegrationManifest,
): IntegrationDescriptor["toolPolicies"] {
  return Object.fromEntries(
    manifest.tools
      .filter((tool) => integrationToolKind(tool.id, tool.description) === "read")
      .map((tool) => [tool.id, { risk: "reviewed-read", approval: "allow" }]),
  );
}

// Run with: pnpm exec tsx scripts/capture-integration-manifest.ts <connection-id>
// DATABASE_URL comes from the caller's environment; never print it or credentials.
export async function captureManifest(
  connectionId: string | undefined,
  databaseUrl: string | undefined,
) {
  if (!connectionId || !databaseUrl) {
    throw new Error("Provide a connection id and set DATABASE_URL in your terminal.");
  }
  const { prisma, pool } = createDb(databaseUrl);
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
    console.log(
      "Proposed toolPolicies. Review each captured tool before pasting into the descriptor:",
    );
    console.log(JSON.stringify({ toolPolicies: proposedToolPolicies(manifest) }, null, 2));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await captureManifest(process.argv[2], process.env.DATABASE_URL);
}
