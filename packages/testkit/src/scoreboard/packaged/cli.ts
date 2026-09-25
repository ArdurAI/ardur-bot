import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentDigest } from "../manifest.js";
import { credentialFreeEnvironment, denyExternalTcp } from "../replay/offline.js";
import type { ProductionApp } from "../replay/production.js";
import { collectPackagedArtifacts, inventoryArtifact } from "../resources/artifacts.js";
import { exactKeys } from "../resources/contracts.js";
import type { ClientCapture } from "./evidence.js";
import { ingestClientCapture } from "./evidence.js";
import { createPackagedPlan, packagedCoverage } from "./plan.js";
import { runPackagedPlan, writeImmutableReport } from "./runner.js";
import { readSourceBinding } from "./source.js";

/** No canonical action loads owner dotenv files, installs packages, or silently falls back to Electron dev. */
export async function runPackagedCli(argv: string[]): Promise<number> {
  const args = new Map<string, string>();
  for (const value of argv.filter((v) => v !== "--canonical" && v !== "--")) {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    if (!match || args.has(match[1]!)) throw new Error("Use unique explicit --key=value arguments");
    args.set(match[1]!, match[2]!);
  }
  const allowed = [
    "action",
    "output",
    "mode",
    "samples",
    "renderer",
    "main",
    "preload",
    "host",
    "asar",
    "native-modules",
    "installer",
    "download",
    "installed",
    "capture",
    "binding",
    "isolated-runner",
    "executable",
    "temporary-root",
    "processes",
    "profile",
    "idle-control",
  ];
  if ([...args.keys()].some((key) => !allowed.includes(key)))
    throw new Error("Unknown canonical argument");
  const output = args.get("output");
  if (!output) throw new Error("Canonical collection requires an explicit output directory");
  const action = args.get("action") ?? "plan";
  const root = path.resolve(import.meta.dirname, "../../../../..");
  const emit = async (value: unknown) => {
    const artifact = await writeImmutableReport(output, value);
    console.log(JSON.stringify(artifact));
    return artifact;
  };
  if (action === "source") {
    await emit(await readSourceBinding(root));
    return 0;
  }
  if (action === "plan") {
    const mode = args.get("mode") ?? "commit";
    if (mode !== "commit" && mode !== "release") throw new Error("Unknown sample mode");
    await emit({
      version: 1,
      plan: createPackagedPlan({
        mode,
        samples: args.has("samples") ? Number(args.get("samples")) : undefined,
      }),
      coverage: packagedCoverage([]),
    });
    return 0;
  }
  if (action === "assets") {
    const roots = Object.fromEntries(
      [
        "main",
        "preload",
        "host",
        "asar",
        "native-modules",
        "installer",
        "download",
        "installed",
      ].flatMap((key) => (args.has(key) ? [[key, args.get(key)!]] : [])),
    );
    const result = await collectPackagedArtifacts({ renderer: args.get("renderer"), roots });
    await emit(JSON.parse(result.raw));
    return Object.values(result.categories).some((r) => r.value === null) ? 2 : 0;
  }
  if (action === "ingest") {
    if (!args.get("capture") || !args.get("binding"))
      throw new Error("Ingestion requires capture and expected binding");
    const capture = JSON.parse(await readFile(args.get("capture")!, "utf8")) as ClientCapture;
    const binding = JSON.parse(await readFile(args.get("binding")!, "utf8")) as Parameters<
      typeof ingestClientCapture
    >[1];
    const result = ingestClientCapture(capture, binding);
    await emit(result.trace.raw);
    await emit(JSON.parse(result.raw));
    return result.complete ? 0 : 2;
  }
  if (action === "ingest-energy") {
    if (!args.get("capture") || !args.get("binding") || !args.get("idle-control"))
      throw new Error("Energy ingestion requires capture, binding and measured idle control");
    const { ingestPhysicalEnergy } = await import("../resources/energy.js");
    const capture = JSON.parse(await readFile(args.get("capture")!, "utf8"));
    const binding = JSON.parse(await readFile(args.get("binding")!, "utf8"));
    const idle = JSON.parse(await readFile(args.get("idle-control")!, "utf8"));
    const result = ingestPhysicalEnergy(capture, binding, idle);
    await emit(idle);
    await emit(capture);
    await emit(result);
    return result.systemEnergy.value === null ? 2 : 0;
  }
  if (action === "resources") {
    if (args.get("isolated-runner") !== "true" || !args.get("binding") || !args.get("processes"))
      throw new Error(
        "Long resource collection requires an isolated runner, binding and owned process inventory",
      );
    const { captureStackResources } = await import("../resources/collector.js");
    const profile = args.get("profile") ?? "stabilized-idle";
    if (profile !== "stabilized-idle" && profile !== "quiet-extension")
      throw new Error("Use captureStackResources with a declared workload for mixed soak");
    const binding = JSON.parse(await readFile(args.get("binding")!, "utf8"));
    const targets = JSON.parse(await readFile(args.get("processes")!, "utf8"));
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await captureStackResources({
        binding,
        inventory: targets.inventory,
        processes: targets.processes,
        profile,
        output,
        signal: abort.signal,
      });
      console.log(JSON.stringify(result.artifact));
      return result.coverage.complete ? 0 : 2;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  if (action !== "run-web" && action !== "run-desktop") throw new Error("Unknown canonical action");
  if (action === "run-desktop" && args.get("isolated-runner") !== "true")
    throw new Error("Desktop measurements require an explicitly isolated runner");
  if (!args.get("binding") || !args.get("renderer"))
    throw new Error("Run requires a build binding and production renderer");
  const { provisionReplayPostgres } = await import("../replay/postgres.js");
  const { FIXTURE_ENCRYPTION_KEY } = await import("../replay/production.js");
  // The build binding is supplied by the build owner. Its bytes are retained with every attempt.
  const binding = JSON.parse(await readFile(args.get("binding")!, "utf8")) as {
    build: { commit: string; diffDigest: string | null };
    environmentHash: string;
    role: "parent" | "candidate" | "fixed-release";
  };
  exactKeys(binding, ["build", "environmentHash", "role"]);
  exactKeys(binding.build, ["commit", "diffDigest"]);
  if (
    !/^[a-f0-9]{40}$/.test(binding.build.commit) ||
    !/^[a-f0-9]{64}$/.test(binding.environmentHash) ||
    (binding.build.diffDigest !== null && !/^[a-f0-9]{64}$/.test(binding.build.diffDigest)) ||
    !["parent", "candidate", "fixed-release"].includes(binding.role)
  )
    throw new Error("Invalid build binding");
  const source = await readSourceBinding(root);
  if (source.commit !== binding.build.commit || source.diffDigest !== binding.build.diffDigest)
    throw new Error("Build binding does not match current source");
  const renderer = await realpath(args.get("renderer")!);
  const packageRoot = action === "run-desktop" ? args.get("installed") : renderer;
  if (!packageRoot) throw new Error("Desktop run requires installed artifact root");
  const artifact = await inventoryArtifact(packageRoot);
  const executable = args.get("executable");
  if (action === "run-desktop") {
    if (
      !executable ||
      !(await realpath(executable)).startsWith(`${await realpath(packageRoot)}${path.sep}`)
    )
      throw new Error("Packaged executable must belong to measured artifact");
  }
  // Inspect only cached images. Do not ask Testcontainers to provision an absent image.
  for (const image of ["postgres:16-alpine", "testcontainers/ryuk:0.14.0"])
    execFileSync("docker", ["image", "inspect", image, "--format", "{{.Size}}"], { stdio: "pipe" });
  const mode = args.get("mode") ?? "commit";
  if (mode !== "commit" && mode !== "release") throw new Error("Unknown sample mode");
  const client = action === "run-web" ? "web" : "desktop";
  const target = client === "web" ? "web-chromium" : `desktop-${process.platform}-${process.arch}`;
  const fixture = JSON.parse(
    await readFile(new URL("../replay/fixtures/task-01-long.json", import.meta.url), "utf8"),
  );
  const expected = {
    client,
    target,
    artifactHash: artifact.sha256,
    environmentHash: binding.environmentHash,
    fixtureHash: contentDigest(fixture),
  } as const;
  const plan = createPackagedPlan({
    mode,
    samples: args.has("samples") ? Number(args.get("samples")) : undefined,
    strata:
      client === "web"
        ? ["chromium-cache-cold"]
        : ["process-cold-os-warm", "chromium-cache-cold", "warm-relaunch"],
  }).filter((t) => t.build === binding.role);
  await emit({ version: 1, binding, artifact, expected, plan, coverage: packagedCoverage([]) });
  // Keeps the virtual display. Every other inherited variable is a credential or harness input.
  const clean = credentialFreeEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "off";
  const temporaryRoot = args.get("temporary-root") ?? path.join(output, "temporary");
  await mkdir(temporaryRoot, { recursive: true });
  const postgres = await provisionReplayPostgres();
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let postgresClosed = false;
  const closePostgres = async () => {
    if (!postgresClosed) {
      await postgres.close();
      postgresClosed = true;
    }
  };
  try {
    const { runLocalClientTrial } = await import("./local-stack.js");
    const { serve } = await import("@hono/node-server");
    type HttpApp = ProductionApp & {
      app: ProductionApp["app"] & { fetch(request: Request): Promise<Response> };
    };
    const { createApp } = (await import(
      pathToFileURL(path.join(root, "apps/api/src/app.ts")).href
    )) as { createApp(options: Record<string, unknown>): Promise<HttpApp> };
    const result = await runPackagedPlan({
      plan,
      expected: { parent: expected, candidate: expected, "fixed-release": expected },
      output,
      signal: shutdown.signal,
      driver: {
        async run(trial, signal) {
          const database = await postgres.fresh();
          let restore: (() => void) | undefined;
          try {
            process.env.DATABASE_URL = database.url;
            restore = denyExternalTcp();
            return await runLocalClientTrial(
              {
                ...expected,
                isolatedRunner: args.get("isolated-runner") === "true",
                executablePath: executable,
                temporaryRoot,
                output,
                database,
                createApp: async ({ services, sandbox, directory }) => {
                  let handles: HttpApp | undefined;
                  const server = serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    fetch: async (request) => {
                      const url = new URL(request.url);
                      if (/^\/(rpc|api|health)(\/|$)/.test(url.pathname))
                        return handles
                          ? handles.app.fetch(request)
                          : new Response(null, { status: 503 });
                      const relative = url.pathname.startsWith("/assets/")
                        ? url.pathname.slice(1)
                        : "index.html";
                      try {
                        const file = await realpath(path.join(renderer, relative));
                        if (!file.startsWith(`${renderer}${path.sep}`))
                          return new Response(null, { status: 404 });
                        const contentType = file.endsWith(".js")
                          ? "text/javascript"
                          : file.endsWith(".css")
                            ? "text/css"
                            : file.endsWith(".html")
                              ? "text/html"
                              : "application/octet-stream";
                        return new Response(await readFile(file), {
                          headers: { "content-type": contentType },
                        });
                      } catch {
                        return new Response(null, { status: 404 });
                      }
                    },
                  });
                  await new Promise<void>((resolve, reject) => {
                    if (server.listening) resolve();
                    else {
                      server.once("listening", resolve);
                      server.once("error", reject);
                    }
                  });
                  const address = server.address();
                  if (!address || typeof address === "string")
                    throw new Error("No isolated listener");
                  const origin = `http://127.0.0.1:${address.port}`;
                  try {
                    handles = await createApp({
                      databaseUrl: database.url,
                      realtimeDatabaseUrl: database.url,
                      dataDir: directory,
                      authUrl: origin,
                      webOrigin: origin,
                      authSecret: "synthetic-scoreboard-auth-secret-32",
                      encryptionKey: FIXTURE_ENCRYPTION_KEY,
                      sandbox,
                      sandboxProvider: "fake",
                      agentRuntime: "pi",
                      wakeupDriver: "graphile",
                      composio: services,
                      signupsEnabled: "true",
                      signupAllowlist: "",
                      cloudAgentProvider: "emulator",
                      piSessionRecording: false,
                    });
                  } catch (error) {
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                    throw error;
                  }
                  const active = handles;
                  return {
                    ...active,
                    origin,
                    app: {
                      request: (input, init) => {
                        // W0-5's synthetic HTTP caller uses a fixed origin. Bind that caller to this fresh server.
                        const headers = new Headers(init?.headers);
                        headers.set("origin", origin);
                        return fetch(`${origin}${input}`, { ...init, headers });
                      },
                    },
                    stop: async () => {
                      if ("closeAllConnections" in server) server.closeAllConnections();
                      await new Promise<void>((resolve) => server.close(() => resolve()));
                      await active.stop();
                    },
                  };
                },
              },
              trial,
              signal,
            );
          } finally {
            restore?.();
            await database.close();
          }
        },
        async close() {
          await closePostgres();
        },
      },
    });
    const unchanged =
      (await inventoryArtifact(packageRoot)).sha256 === artifact.sha256 &&
      contentDigest(await readSourceBinding(root)) === contentDigest(source);
    await emit({ ...result, sourceArtifactUnchanged: unchanged });
    return unchanged &&
      result.cleanup === "complete" &&
      result.results.every((r) => "status" in r && r.status === "complete")
      ? 0
      : 2;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await closePostgres();
  }
}
