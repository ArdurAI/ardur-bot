import type { Prisma } from "@ardurbot/db";
import { createDb } from "@ardurbot/db";
import { PostgresDocumentStore } from "@ardurbot/memory";
import { lockMemorySpace } from "../../../../adapters/src/memory/lifecycle.js";
import { isOwnedReplayDatabase } from "../replay/postgres.js";
import type { MatrixResult } from "./catalog.js";
import { MATRIX_PARAMETERS } from "./catalog.js";
import { seedScope } from "./durable.js";

export function classifyMemoryScale(
  loaded: readonly { documents: number; revisions: number }[],
  headOk: boolean,
  scopeOk: boolean,
) {
  const checks = {
    headContent: headOk,
    scopePreserved: scopeOk,
    // A point read of the current document must not materialize the space's history.
    historicalRevisionsNotMaterialized: loaded.every(
      (row) => row.documents <= 1 && row.revisions <= 1,
    ),
  };
  return {
    checks,
    status: (Object.values(checks).every(Boolean) ? "passed" : "finding") as MatrixResult["status"],
  };
}

export async function runMemoryScale(
  databaseUrl: string,
  documents: number,
  revisions: number,
): Promise<MatrixResult> {
  if (!isOwnedReplayDatabase(databaseUrl)) throw new Error("Unowned matrix database");
  if (![100, 1000, 10000].includes(documents) || ![1, 20].includes(revisions))
    throw new Error("Invalid memory dimensions");
  const db = createDb(databaseUrl);
  try {
    const scope = await seedScope(db.prisma);
    const content = "m".repeat(MATRIX_PARAMETERS.documentBytes);
    for (let offset = 0; offset < documents; offset += 100) {
      const batch = Array.from({ length: Math.min(100, documents - offset) }, (_, j) => ({
        id: `matrix-doc-${offset + j}`,
        spaceId: scope.spaceId,
        userId: (offset + j) % 2 ? "other-synthetic-user" : scope.userId,
        scope: "user",
        path: `document-${offset + j}.md`,
        content,
        revision: revisions,
      }));
      await db.prisma.memoryDocument.createMany({ data: batch });
      for (let revision = 1; revision <= revisions; revision++)
        await db.prisma.memoryRevision.createMany({
          data: batch.map((document) => ({
            documentId: document.id,
            revision,
            content,
            authorKind: "user",
            authorUserId: document.userId,
          })),
        });
    }
    const loaded: Array<{ documents: number; revisions: number; bytes: number }> = [];
    const observed = db.prisma.$extends({
      query: {
        memoryDocument: {
          async findMany({ args, query }) {
            const rows = await query(args);
            loaded.push({
              documents: rows.length,
              revisions: rows.reduce(
                (n, row) =>
                  n + ((row as unknown as { revisions?: unknown[] }).revisions?.length ?? 0),
                0,
              ),
              bytes: Buffer.byteLength(JSON.stringify(rows)),
            });
            return rows;
          },
        },
      },
    });
    const access = { ...scope, botIds: [scope.botId] };
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = await observed.$transaction(async (tx) => {
      // A query-only extension leaves the transaction API unchanged at runtime.
      const transaction = tx as unknown as Prisma.TransactionClient;
      await lockMemorySpace(transaction, scope.spaceId);
      return new PostgresDocumentStore(transaction).read("matrix-doc-0", access);
    });
    const elapsedMs = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    const denied = await db.prisma.$transaction(async (tx) =>
      new PostgresDocumentStore(tx).read("matrix-doc-1", access),
    );
    const plan = await db.pool.query(
      'EXPLAIN (FORMAT JSON) SELECT * FROM memory_documents WHERE "spaceId" = $1',
      [scope.spaceId],
    );
    const locks = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    const verdict = classifyMemoryScale(
      loaded,
      result?.content === content && result.revision === revisions,
      denied === null,
    );
    return {
      id: `O5-${documents}-${revisions}`,
      experiment: "O5",
      tier: "T1",
      status: verdict.status,
      checks: verdict.checks,
      measurements: {
        documents,
        revisions,
        documentBytes: MATRIX_PARAMETERS.documentBytes,
        elapsedMs,
        materializedReads: loaded,
        heapBefore,
        heapAfter,
        peakHeap: null,
        queryPlan: plan.rows,
        planScope: "head selection only; ORM revision relation plan not captured",
        sampledDatabaseLocks: Number(locks.rows[0]!.count),
        sqlQueryCount: null,
      },
      coverage: [
        "production-PostgresDocumentStore",
        "real-postgresql",
        "scoped-read-negative-control",
        "materialized-row-and-byte-counts",
      ],
      gaps: [
        "One diagnostic sample; query count, relation query plan, lock wait sampling and peak heap require expanded instrumentation.",
        "The current store loads every document and revision in the space for one head read. That scaling failure is a finding, not a pass.",
      ],
    };
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
