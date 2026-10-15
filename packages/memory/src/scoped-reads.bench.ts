// #199: Use the shared Postgres image override without changing the local default.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MemoryAccess, MemoryDocumentStore } from "@ardurbot/adapter-kit";
import { createDb, type Prisma } from "@ardurbot/db";
import { TEST_POSTGRES_IMAGE } from "@ardurbot/testkit/postgres-image";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { scopeKey } from "./scope.js";

const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDirectory = path.resolve(
  option("out") ??
    process.env.SCOPED_READ_BENCH_OUT ??
    path.join(repositoryRoot, ".context/scoped-reads"),
);
const label = option("label") ?? "tip";
const revisionCount = Number(option("revisions") ?? "20");
if (revisionCount !== 1 && revisionCount !== 20)
  throw new Error("Supported revision counts are 1 and 20");
const storePath = option("store")
  ? path.resolve(option("store")!)
  : fileURLToPath(new URL("./postgres-store.ts", import.meta.url));
const sizes = [100, 1_000, 10_000];
type ReadStore = Pick<MemoryDocumentStore, "read" | "list" | "history">;
type StoreConstructor = new (tx: Prisma.TransactionClient) => ReadStore;
type Plan = {
  Plan: { "Actual Rows": number; "Shared Hit Blocks": number; "Shared Read Blocks": number };
};
type Statement = { query: string; params: unknown[] };

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const module = (await import(pathToFileURL(storePath).href)) as {
    PostgresDocumentStore: StoreConstructor;
  };
  const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale-provider=icu --icu-locale=en-US" })
    .start();
  const uri = container.getConnectionUri();
  let captured: Statement[] | null = null;
  const database = createDb(uri, {
    queryLog: (event) => {
      if (captured && /^\s*SELECT\b/iu.test(event.query))
        captured.push({ query: event.query, params: JSON.parse(event.params) as unknown[] });
    },
  });
  try {
    // The migration child receives only the disposable container URL. An inherited URL is ignored.
    execFileSync("pnpm", ["--filter", "@ardurbot/db", "exec", "prisma", "migrate", "deploy"], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: uri },
      stdio: "inherit",
    });
    await database.prisma.organization.create({
      data: {
        id: "bench-space",
        name: "Benchmark",
        slug: "bench-space",
        createdAt: new Date(),
        spaces: { create: { id: "bench-space", name: "Benchmark" } },
      },
    });
    const access: MemoryAccess = {
      operationId: "bench",
      traceId: "bench",
      spaceId: "bench-space",
      userId: "bench-user",
      botIds: [],
      signal: new AbortController().signal,
    };
    const key = scopeKey({ kind: "user", spaceId: access.spaceId, userId: access.userId });
    const results = [];
    let previous = 0;
    for (const size of sizes) {
      await database.pool.query(
        `
        INSERT INTO memory_documents
          (id, "spaceId", "userId", scope, "scopeKey", path, content, revision, "createdAt", "updatedAt")
        SELECT 'bench-' || lpad(i::text, 6, '0'), $3, $4, 'user', $5,
          'document-' || i || '.md', 'revision-current', 20, now(), now()
        FROM generate_series($1::integer, $2::integer) AS i
      `,
        [previous + 1, size, access.spaceId, access.userId, key],
      );
      await database.pool.query(
        `
        INSERT INTO memory_revisions
          (id, "documentId", revision, content, "authorKind", "authorUserId", "createdAt")
        SELECT 'bench-rev-' || i || '-' || r,
          'bench-' || lpad(i::text, 6, '0'), r,
          CASE WHEN r = 20 THEN 'revision-current' ELSE 'revision-' || r END,
          'user', $3, now()
        FROM generate_series($1::integer, $2::integer) AS i
        CROSS JOIN generate_series(1, 20) AS r
        WHERE $4::integer = 20 OR r = 20
      `,
        [previous + 1, size, access.userId, revisionCount],
      );
      previous = size;
      await database.pool.query("ANALYZE memory_documents");
      await database.pool.query("ANALYZE memory_revisions");
      const paths = {
        read: () =>
          database.prisma.$transaction((tx) =>
            new module.PostgresDocumentStore(tx).read("bench-000001", access),
          ),
        list: () =>
          database.prisma.$transaction((tx) =>
            new module.PostgresDocumentStore(tx).list({ limit: 50 }, access),
          ),
        history: () =>
          database.prisma.$transaction((tx) =>
            new module.PostgresDocumentStore(tx).history("bench-000001", { limit: 20 }, access),
          ),
      };
      const latencies: Record<string, { medianMs: number; p95Ms: number }> = {};
      const statements: Record<string, Statement[]> = {};
      for (const [name, action] of Object.entries(paths)) {
        captured = [];
        await action();
        statements[name] = captured;
        captured = null;
        if (statements[name]!.length === 0) throw new Error(`No SELECT captured for ${name}`);
        const samples = [];
        for (let sample = 0; sample < 7; sample++) {
          const start = performance.now();
          await action();
          samples.push(performance.now() - start);
        }
        latencies[name] = { medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
      }
      const plans: Record<
        string,
        {
          rows: number;
          resultBytes: number;
          sharedBuffers: number;
          statements: Array<{
            rows: number;
            resultBytes: number;
            sharedBuffers: number;
            file: string;
          }>;
        }
      > = {};
      for (const [name, queries] of Object.entries(statements)) {
        const entries = [];
        for (const [index, statement] of queries.entries()) {
          const explained = await database.pool.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
            statement.params,
          );
          const plan = (explained.rows[0] as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0]!;
          // JSON payload size is a stable proxy for rows sent to the client, not wire bytes.
          const returned = await database.pool.query(statement.query, statement.params);
          const resultBytes = Buffer.byteLength(JSON.stringify(returned.rows));
          const file = `explain-${label}-${size}-${name}-${index + 1}.json`;
          await writeFile(
            path.join(outputDirectory, file),
            JSON.stringify({ ...statement, plan }, null, 2),
          );
          entries.push({
            rows: plan.Plan["Actual Rows"],
            resultBytes,
            sharedBuffers: plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"],
            file,
          });
        }
        plans[name] = {
          rows: entries.reduce((sum, entry) => sum + entry.rows, 0),
          resultBytes: entries.reduce((sum, entry) => sum + entry.resultBytes, 0),
          sharedBuffers: entries.reduce((sum, entry) => sum + entry.sharedBuffers, 0),
          statements: entries,
        };
      }
      if (size === 10_000 && label === "tip") {
        // A separate schema diagnostic, never counted as a measured store statement.
        const sql = `SELECT id FROM memory_documents
          WHERE "spaceId" = $1 AND "userId" = $2 AND id COLLATE "C" > $3 COLLATE "C"
          ORDER BY id COLLATE "C" LIMIT 51`;
        const params = [access.spaceId, access.userId, "bench-000001"];
        const explained = await database.pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          params,
        );
        const plan = (explained.rows[0] as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0]!;
        await writeFile(
          path.join(outputDirectory, "explain-c-collation-10000.json"),
          JSON.stringify({ query: sql, params, plan }, null, 2),
        );
      }
      results.push({ documents: size, revisionsPerDocument: revisionCount, latencies, plans });
      process.stdout.write(`${label}: ${size} documents measured\n`);
    }
    await writeFile(
      path.join(outputDirectory, `bench-${label}.json`),
      JSON.stringify({ label, samples: 7, results }, null, 2),
    );
  } finally {
    await database.prisma.$disconnect();
    await database.pool.end();
    await container.stop();
  }
}

await main();
