import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MemoryAccess, MemoryDocumentStore } from "@ardurbot/adapter-kit";
import { createDb, type Prisma } from "@ardurbot/db";
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
const storePath = option("store")
  ? path.resolve(option("store")!)
  : fileURLToPath(new URL("./postgres-store.ts", import.meta.url));
const sizes = [100, 1_000, 10_000];
type ReadStore = Pick<MemoryDocumentStore, "read" | "list" | "history">;
type StoreConstructor = new (tx: Prisma.TransactionClient) => ReadStore;
type Plan = {
  Plan: { "Actual Rows": number; "Shared Hit Blocks": number; "Shared Read Blocks": number };
};

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const module = (await import(pathToFileURL(storePath).href)) as {
    PostgresDocumentStore: StoreConstructor;
  };
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const uri = container.getConnectionUri();
  const database = createDb(uri);
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
          'document-' || i || '.md', 'revision-20', 20, now(), now()
        FROM generate_series($1::integer, $2::integer) AS i
      `,
        [previous + 1, size, access.spaceId, access.userId, key],
      );
      await database.pool.query(
        `
        INSERT INTO memory_revisions
          (id, "documentId", revision, content, "authorKind", "authorUserId", "createdAt")
        SELECT 'bench-rev-' || i || '-' || r,
          'bench-' || lpad(i::text, 6, '0'), r, 'revision-' || r, 'user', $3, now()
        FROM generate_series($1::integer, $2::integer) AS i
        CROSS JOIN generate_series(1, 20) AS r
      `,
        [previous + 1, size, access.userId],
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
      for (const [name, action] of Object.entries(paths)) {
        await action();
        const samples = [];
        for (let sample = 0; sample < 7; sample++) {
          const start = performance.now();
          await action();
          samples.push(performance.now() - start);
        }
        latencies[name] = { medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
      }
      const plans: Record<string, { rows: number; sharedBuffers: number; file: string }> = {};
      for (const name of ["read", "list"] as const) {
        const headSql =
          name === "read"
            ? `SELECT d.id, r.revision FROM memory_documents d
              LEFT JOIN LATERAL (SELECT revision FROM memory_revisions WHERE "documentId" = d.id
                ORDER BY revision DESC LIMIT 1) r ON true
              WHERE d.id = 'bench-000001' AND d."spaceId" = 'bench-space' AND d."userId" = 'bench-user'`
            : `SELECT d.id, r.revision FROM memory_documents d
              LEFT JOIN LATERAL (SELECT revision FROM memory_revisions WHERE "documentId" = d.id
                ORDER BY revision DESC LIMIT 1) r ON true
              WHERE d."spaceId" = 'bench-space' AND d."userId" = 'bench-user'
                AND d.scope = 'user' AND d."deletedAt" IS NULL ORDER BY d.id LIMIT 51`;
        const oldSql = `SELECT d.id, r.revision FROM memory_documents d
          LEFT JOIN memory_revisions r ON r."documentId" = d.id
          WHERE d."spaceId" = 'bench-space'`;
        const sql = label === "base" ? oldSql : headSql;
        const explained = await database.pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        );
        const plan = (explained.rows[0] as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0]!;
        const file = `explain-${label}-${size}-${name}.json`;
        await writeFile(path.join(outputDirectory, file), JSON.stringify(plan, null, 2));
        plans[name] = {
          rows: plan.Plan["Actual Rows"],
          sharedBuffers: plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"],
          file,
        };
      }
      results.push({ documents: size, revisionsPerDocument: 20, latencies, plans });
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
