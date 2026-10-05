import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRootEnv } from "@ardurbot/core/node/load-root-env";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp } from "../../../../apps/api/src/app.ts";
import { createDeploymentOwnerFixture } from "./deployment-owner.js";
import { runIntegrationSuites } from "./integration.js";
import { runProcess } from "./process.js";

if (process.env.TESTKIT_SKIP_ROOT_ENV !== "1") loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const workersArg = process.argv.find((arg) => arg.startsWith("--workers="));
const shardArg = process.argv.find((arg) => arg.startsWith("--shard="));
const repeatEachArg = process.argv.find((arg) => arg.startsWith("--repeat-each="));
const integrationRepeats = Number(repeatEachArg?.slice("--repeat-each=".length) ?? "1");
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpec = specArg?.slice("--spec=".length);
const e2eGrep = grepArg?.slice("--grep=".length);
const e2eWorkers = workersArg?.slice("--workers=".length);
const e2eShard = shardArg?.slice("--shard=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";
const productDemo = path.basename(e2eSpec ?? "") === "product-demo.spec.ts";

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!Number.isSafeInteger(integrationRepeats) || integrationRepeats < 1) {
  throw new Error("--repeat-each must be a positive integer");
}
if (!["fake", "e2b", "daytona", "box"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake", "e2b", "daytona", or "box"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "pi" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "pi" or "scripted"');
}
if (productDemo && (!e2e || sandboxProvider !== "fake" || agentRuntime !== "scripted")) {
  throw new Error("Product demo requires --e2e --sandbox=fake --runtime=scripted");
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "box" && !process.env.BOX_API_KEY) {
  throw new Error("BOX_API_KEY is required when --sandbox=box");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve(process.env.TEST_REPORT_DIR ?? "test-report", mode);
  await mkdir(reportDir, { recursive: true });
  const productDemoDirectory = productDemo ? path.join("product-demo", randomUUID()) : null;
  if (productDemoDirectory) {
    process.env.PRODUCT_DEMO_REPORT_DIR = path.join(reportDir, productDemoDirectory);
    process.env.PRODUCT_DEMO_BUILD_REVISION = execSync("git rev-parse HEAD", {
      encoding: "utf8",
    }).trim();
    process.env.PRODUCT_DEMO_BUILD_DIRTY = execSync("git status --porcelain", {
      encoding: "utf8",
    }).trim()
      ? "1"
      : "0";
  }
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  try {
    const databaseUrl = container.getConnectionUri();
    if (new URL(databaseUrl).port === "5433")
      throw new Error("The reserved database port cannot be used by integration tests.");
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    // Playwright/E2E force the offline cloud-agent emulator; clear Cursor keys so cards never hit a live VM.
    process.env.CLOUD_AGENT_PROVIDER = "emulator";
    delete process.env.CURSOR_API_KEY;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    process.env.CI = "1";
    if (e2e) process.env.TESTKIT_E2E_OWNER_TOKEN = randomUUID();

    execSync("pnpm --filter @ardurbot/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm db:migrate", {
      stdio: "inherit",
      env: process.env,
    });

    if (integration) {
      const suites = [
        "packages/testkit/src/cli-device.postgres.test.ts",
        "packages/testkit/src/pi-offline.postgres.test.ts",
        "packages/testkit/src/capabilities-memory.postgres.test.ts",
        "packages/testkit/src/computer-approval.postgres.test.ts",
        "packages/testkit/src/eval-history.postgres.test.ts",
        "packages/testkit/src/eval-customer-support.postgres.test.ts",
        "packages/testkit/src/context.postgres.test.ts",
        "packages/testkit/src/qa-regressions.postgres.test.ts",
        "packages/testkit/src/journeys.test.ts",
        "packages/testkit/src/authorization.test.ts",
        "packages/testkit/src/attachments.test.ts",
        "packages/testkit/src/voice.test.ts",
        "packages/testkit/src/search.test.ts",
        "packages/testkit/src/executor-lifecycle.test.ts",
        "packages/testkit/src/executor-evidence.postgres.test.ts",
        "packages/testkit/src/connections.test.ts",
        "packages/testkit/src/bot-secrets.test.ts",
        "packages/db/src/space-membership.postgres.test.ts",
        "packages/db/src/evidence.postgres.test.ts",
        "packages/db/src/customization.postgres.test.ts",
        "packages/db/src/group-model-pins.postgres.test.ts",
        "packages/db/src/protected-locations.postgres.test.ts",
        "packages/db/src/hermes-runtime-config.postgres.test.ts",
        "packages/testkit/src/group-model-visible.postgres.test.ts",
        "packages/testkit/src/chief-loop.postgres.test.ts",
        "packages/testkit/src/chief-corrections.postgres.test.ts",
        "packages/db/src/messaging.postgres.test.ts",
        "packages/db/src/bot-presence.postgres.test.ts",
        "packages/db/src/learning.postgres.test.ts",
        "packages/adapters/src/learning-insights.postgres.test.ts",
        "packages/adapters/src/bot-comms.postgres.test.ts",
        "packages/adapters/src/delegation-lock-timeout.postgres.test.ts",
        "packages/db/src/command-blocks.postgres.test.ts",
        "packages/adapters/src/board/filing.postgres.test.ts",
        "packages/adapters/src/board/delivery.postgres.test.ts",
        "packages/memory/src/commit.postgres.test.ts",
        "packages/memory/src/scoped-reads.postgres.test.ts",
        "packages/adapters/src/memory/scoped-reads-wrapper.postgres.test.ts",
        "packages/adapters/src/memory/lifecycle.postgres.test.ts",
        "packages/adapters/src/wakeup.postgres.test.ts",
        "packages/adapters/src/realtime.postgres.test.ts",
        "packages/adapters/src/run-usage.postgres.test.ts",
        "packages/adapters/src/job-reconciler.postgres.test.ts",
        "packages/adapters/src/cloud-agent.postgres.test.ts",
        "apps/api/src/local-import.postgres.test.ts",
        "apps/api/src/evidence.postgres.test.ts",
        "apps/api/src/scratchpad.postgres.test.ts",
      ];
      // Each app reconciles all durable work in its database, including intentionally
      // unfinished fixture runs. Clone the pristine migrated schema so one suite
      // cannot execute another suite's backlog or wait for it during shutdown.
      const databaseCommand = async (statement: string) => {
        const result = await container.exec([
          "psql",
          "-U",
          container.getUsername(),
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ]);
        if (result.exitCode !== 0)
          throw new Error("Isolated integration database operation failed");
      };
      const selectedSuites = e2eSpec ? suites.filter((suite) => suite === e2eSpec) : suites;
      if (selectedSuites.length === 0) throw new Error(`Unknown integration suite: ${e2eSpec}`);
      const result = await runIntegrationSuites({
        suites: Array.from({ length: integrationRepeats }, () => selectedSuites).flat(),
        databaseUrl,
        template: container.getDatabase(),
        databaseCommand,
        env: process.env,
        testNamePattern: e2eGrep,
      });
      await writeSummary(reportDir, {
        ...result,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const [
      {
        ComposioEmulator,
        EmailEmulator,
        PipedreamConnector,
        ScriptedAgentRuntime,
        ThirdPartyConnectorEmulator,
      },
      { createApp },
    ] = await Promise.all([
      import("@ardurbot/adapters"),
      import("../../../../apps/api/src/app.ts"),
    ]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const email = new EmailEmulator();
    let receiptGate:
      | {
          botId: string;
          before: Promise<void>;
          after: Promise<void>;
          accept: () => void;
          reply: () => void;
        }
      | undefined;
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      pipedream,
      email,
      runtime:
        e2e && agentRuntime === "scripted"
          ? new ScriptedAgentRuntime({
              beforeAcknowledge: async (request) => {
                const gate = receiptGate;
                if (gate?.botId === request.botId) await gate.before;
              },
              afterAcknowledge: async (request) => {
                const gate = receiptGate;
                if (gate?.botId === request.botId) await gate.after;
              },
            })
          : undefined,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      integrationsCatalogUrl: "https://catalog.example.test/",
    });
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const deploymentOwner = createDeploymentOwnerFixture({
      authenticate: async (request) => {
        const headers = new Headers(request.headers);
        headers.set("content-type", "application/json");
        const sessionResponse = await handles.app.fetch(
          new Request(new URL("/rpc/me", request.url), {
            method: "POST",
            headers,
            body: JSON.stringify({ json: {} }),
          }),
        );
        if (!sessionResponse.ok) return null;
        const me = (await sessionResponse.json()) as { json?: { userId?: string } };
        const sessionId =
          request.headers
            .get("cookie")
            ?.split(";")
            .map((cookie) => cookie.trim())
            .find((cookie) => cookie.startsWith("better-auth.session_token=")) ??
          request.headers.get("authorization");
        if (!me.json?.userId || !sessionId) return null;
        return { userId: me.json.userId, sessionId };
      },
      setOwner: async (userId) => {
        await handles.prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { ownerUserId: userId },
        });
      },
    });
    const server = serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        if (e2e && url.pathname === "/__e2e/receipt-gate") {
          if (
            request.method !== "POST" ||
            request.headers.get("x-e2e-owner-token") !== process.env.TESTKIT_E2E_OWNER_TOKEN
          )
            return new Response("Forbidden", { status: 403 });
          const input = (await request.json()) as {
            action?: "arm" | "accept" | "reply";
            botId?: string;
          };
          if (input.action === "arm" && input.botId && !receiptGate) {
            let accept!: () => void;
            let reply!: () => void;
            const before = new Promise<void>((resolve) => {
              accept = resolve;
            });
            const after = new Promise<void>((resolve) => {
              reply = resolve;
            });
            receiptGate = { botId: input.botId, before, after, accept, reply };
          } else if (input.action === "accept" && receiptGate) {
            receiptGate.accept();
          } else if (input.action === "reply" && receiptGate) {
            receiptGate.accept();
            receiptGate.reply();
            receiptGate = undefined;
          } else {
            return new Response("Bad receipt gate request", { status: 400 });
          }
          return Response.json({ ok: true });
        }
        if (e2e && url.pathname === "/__e2e/receipt-timeline") {
          if (
            request.method !== "GET" ||
            request.headers.get("x-e2e-owner-token") !== process.env.TESTKIT_E2E_OWNER_TOKEN
          )
            return new Response("Forbidden", { status: 403 });
          const outboundMessageId = url.searchParams.get("outboundMessageId");
          const inboundMessageId = url.searchParams.get("inboundMessageId");
          if (!outboundMessageId || !inboundMessageId)
            return new Response("Bad receipt timeline request", { status: 400 });
          const delivery = await handles.prisma.botMessageDelivery.findFirst({
            where: { outboundMessageId, inboundMessageId },
            select: { state: true, readAt: true, repliedAt: true },
          });
          if (!delivery) return new Response("Unknown delivery", { status: 404 });
          return Response.json(delivery, { headers: { "cache-control": "no-store" } });
        }
        if (url.pathname === "/__e2e/deployment-owner") {
          return deploymentOwner(request);
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@ardurbot/web",
            "exec",
            "playwright",
            "test",
            ...(e2eSpec ? [e2eSpec] : []),
            ...(e2eGrep ? ["--grep", e2eGrep] : []),
            ...(e2eWorkers ? ["--workers", e2eWorkers] : []),
            ...(e2eShard ? ["--shard", e2eShard] : []),
            ...(repeatEachArg ? [repeatEachArg] : []),
          ],
          {
            ...process.env,
            CI: "1",
            // Pin English so e2e selectors match source messages regardless of runner locale.
            VITE_DEFAULT_UI_LOCALE: "en",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        ...(productDemoDirectory
          ? {
              productDemo: {
                file: path.join(productDemoDirectory, "product-demo.json"),
                evidenceMode: "scripted",
              },
            }
          : {}),
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      receiptGate?.accept();
      receiptGate?.reply();
      receiptGate = undefined;
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "daytona" | "box",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<ReturnType<typeof createApp>>;

async function managedComputers(handles: AppHandles) {
  if (!["e2b", "daytona", "box"].includes(sandboxProvider)) return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
