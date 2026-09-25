import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { startScoreboardTrace } from "@ardurbot/adapters";
import type { TraceBatch } from "@ardurbot/contracts";
import type { Browser, ElectronApplication, Page } from "@playwright/test";
import { chromium, _electron as electron } from "@playwright/test";
import { contentDigest } from "../manifest.js";
import { startReplayHttp } from "../replay/http.js";
import { isOwnedReplayDatabase } from "../replay/postgres.js";
import type { ProductionApp } from "../replay/production.js";
import { runProductionTask } from "../replay/production.js";
import type { ReplayFixture } from "../replay/protocol.js";
import { DepartmentSandbox, DepartmentServices } from "../replay/services.js";
import { getTask } from "../tasks/catalog.js";
import { calibrateTraceClock, collectTraceEvidence } from "../trace-collector.js";
import {
  electronAuthCookie,
  persistentAuthCookies,
  selectPrimingCookieStore,
} from "./desktop-session.js";
import type { ClientCapture } from "./evidence.js";
import type { PackagedTrial } from "./plan.js";
import { writeImmutableReport } from "./runner.js";

interface RendererScope {
  __ardurTrace?: {
    capacity: number;
    processId?: string;
    points?: TraceBatch["points"];
    dropped?: number;
  };
}

export interface LocalClientOptions {
  client: "desktop" | "web";
  isolatedRunner: boolean;
  executablePath?: string;
  temporaryRoot: string;
  output: string;
  artifactHash: string;
  environmentHash: string;
  fixtureHash: string;
  target: string;
  database: { url: string };
  createApp: (options: {
    services: DepartmentServices;
    sandbox: DepartmentSandbox;
    directory: string;
    modelBaseUrl: string;
  }) => Promise<ProductionApp & { origin: string }>;
}

/** Reuse W0-5's real API/Graphile/Pi task runner, substituting only its submission boundary with the UI. */
export async function runLocalClientTrial(
  options: LocalClientOptions,
  trial: PackagedTrial,
  signal: AbortSignal,
): Promise<ClientCapture> {
  if (options.client === "desktop" && (!options.isolatedRunner || !options.executablePath))
    throw new Error("Desktop collection requires a packaged executable on an isolated runner");
  if (!isOwnedReplayDatabase(options.database.url))
    throw new Error("Client replay requires an owned disposable database");
  if (!["process-cold-os-warm", "chromium-cache-cold", "warm-relaunch"].includes(trial.stratum))
    throw new Error("This startup stratum needs a physical runner reset adapter");
  const task = getTask("task-01");
  const fixture = JSON.parse(
    await readFile(new URL("../replay/fixtures/task-01-long.json", import.meta.url), "utf8"),
  ) as ReplayFixture;
  if (contentDigest(fixture) !== options.fixtureHash)
    throw new Error("Client fixture binding mismatch");
  const directory = await mkdtemp(path.join(options.temporaryRoot, "packaged-trial-"));
  const trace = startScoreboardTrace();
  let provider: Awaited<ReturnType<typeof startReplayHttp>> | undefined;
  let app: ElectronApplication | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let closeTools: (() => Promise<void>) | undefined;
  let started = 0;
  const startup: ClientCapture["startup"] = {
    "first-window": null,
    "usable-shell": null,
    "restored-transcript": null,
    "working-turn": null,
  };
  let clientBatch: TraceBatch | null = null;
  const calibrations: ClientCapture["calibrations"] = [];
  let origin = "";
  const clientProcessId = `client-${contentDigest(trial.resetId).slice(0, 16)}`;
  let stage = "setup";
  let capture: ClientCapture | undefined;
  let failure: { error: unknown } | undefined;
  let cleanupFailed = false;
  try {
    provider = await startReplayHttp(fixture, "fixed-delay");
    const services = new DepartmentServices();
    closeTools = await services.transport("local", "fixed-delay");
    const sandbox = new DepartmentSandbox(path.join(directory, "computers"), task);
    const result = await runProductionTask({
      task,
      databaseUrl: options.database.url,
      dataDir: directory,
      modelBaseUrl: provider.baseUrl,
      services,
      sandbox,
      variant: { history: "long", tools: "local", capacity: 16000 },
      createApp: async () => {
        const handles = await options.createApp({
          services,
          sandbox,
          directory,
          modelBaseUrl: provider!.baseUrl,
        });
        origin = handles.origin;
        return {
          ...handles,
          app: {
            request: async (input, init) => {
              if (input !== "/rpc/threads/send" || !page) return handles.app.request(input, init);
              const body = JSON.parse(String(init?.body)) as { json: { text: string } };
              const response = page.waitForResponse(
                (r) =>
                  new URL(r.url()).pathname === "/rpc/threads/send" &&
                  r.request().method() === "POST",
              );
              const composer = page.getByTestId("composer-bar").locator("textarea");
              await composer.fill(body.json.text);
              await composer.press("Enter");
              const receipt = await response;
              return new Response(await receipt.text(), {
                status: receipt.status(),
                headers: receipt.headers(),
              });
            },
          },
        };
      },
      control: {
        signal,
        configure: async (_handles, cookie, botId) => {
          stage = "client-startup";
          const cookies = persistentAuthCookies(cookie, origin, Date.now());
          const targetUrl = `${origin}/app/${botId}`;
          if (options.client === "desktop") {
            const env = {
              ...process.env,
              ARDURBOT_WEB_URL: targetUrl,
              ARDURBOT_PERFORMANCE_USER_DATA: path.join(directory, "profile"),
              ARDURBOT_DISABLE_AUTO_UPDATE: "1",
            };
            // Persist synthetic auth before measuring, then quit. No owner profile is ever opened.
            const priming = await electron.launch({ executablePath: options.executablePath!, env });
            try {
              const primingPage = await priming.firstWindow();
              // The Playwright context writes the default session. The app window uses its partition.
              const primingWindow = await priming.browserWindow(primingPage);
              await selectPrimingCookieStore({
                browserContext: {
                  kind: "browser-context",
                  set: (records) =>
                    primingPage.context().addCookies(records.map((record) => ({ ...record }))),
                },
                webContentsSession: {
                  kind: "web-contents-session",
                  set: (records) =>
                    primingWindow.evaluate(async (win, details) => {
                      if (win.isDestroyed() || win.webContents.isDestroyed())
                        throw new Error("Priming window has no session");
                      for (const item of details) await win.webContents.session.cookies.set(item);
                      // The next process only sees cookies that have reached the profile.
                      await win.webContents.session.cookies.flushStore();
                    }, records.map(electronAuthCookie)),
                },
              }).set(cookies);
              if (trial.stratum === "warm-relaunch") {
                await primingPage.goto(targetUrl);
                await primingPage
                  .locator('[data-testid="shell-root"][data-ready="true"]')
                  .waitFor();
              }
            } finally {
              await priming.close();
            }
            started = performance.now();
            app = await electron.launch({
              executablePath: options.executablePath!,
              env: {
                ...env,
                ARDURBOT_PERFORMANCE_CLEAR_CACHE:
                  trial.stratum === "chromium-cache-cold" ? "1" : "0",
              },
            });
            const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
            if (!packaged) throw new Error("Development Electron is not a packaged artifact");
            page = await app.firstWindow();
            await page.evaluate((processId) => {
              (globalThis as RendererScope).__ardurTrace ??= { capacity: 8192, processId };
            }, clientProcessId);
          } else {
            // Headless web is its own client stratum; it never supplies native desktop acceptance.
            started = performance.now();
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext();
            await context.addCookies(cookies);
            await context.addInitScript((processId) => {
              (globalThis as RendererScope).__ardurTrace = { capacity: 8192, processId };
            }, clientProcessId);
            await context.route("**/*", (route) => {
              const url = new URL(route.request().url());
              return url.origin === origin ? route.continue() : route.abort("blockedbyclient");
            });
            page = await context.newPage();
          }
          startup["first-window"] = performance.now() - started;
          stage = "shell-ready";
          if (options.client === "web") await page.goto(targetUrl);
          await page
            .locator('[data-testid="shell-root"][data-ready="true"]')
            .waitFor({ timeout: 30_000 });
          startup["usable-shell"] = performance.now() - started;
          stage = "transcript-restored";
          await page.locator('[data-testid="transcript"] [data-message-id]').first().waitFor();
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          startup["restored-transcript"] = performance.now() - started;
          await page.evaluate((processId) => {
            (globalThis as RendererScope).__ardurTrace ??= { capacity: 8192, processId };
          }, clientProcessId);
          const sent = performance.now();
          const remote = await page.evaluate(() => ({
            received: performance.now(),
            sent: performance.now(),
          }));
          calibrations.push(
            calibrateTraceClock({
              processId: clientProcessId,
              referenceProcessId: trace.snapshot().processId,
              referenceSent: sent,
              remoteReceived: remote.received,
              remoteSent: remote.sent,
              referenceReceived: performance.now(),
              validForMs: task.deadlineMs + 60_000,
              maxDriftMs: 2,
            }),
          );
        },
        observed: async () => {
          stage = "terminal-paint";
          if (!page) return;
          try {
            await page.waitForFunction(
              () =>
                (globalThis as RendererScope).__ardurTrace?.points?.some(
                  (p) => p.boundary === "client.terminal.painted",
                ),
              undefined,
              { timeout: 10_000 },
            );
            startup["working-turn"] = performance.now() - started;
          } catch {
            // The task result and partial trace survive a missing paint boundary.
            startup["working-turn"] = null;
          } finally {
            clientBatch = await page.evaluate(() => {
              const state = (globalThis as RendererScope).__ardurTrace;
              if (!state?.processId) return null;
              return {
                version: 1 as const,
                processId: state.processId,
                points: state.points ?? [],
                counters: {
                  recorded: state.points?.length ?? 0,
                  dropped: state.dropped ?? 0,
                  sampledOut: 0,
                  invalid: 0,
                },
              };
            });
          }
        },
      },
    });
    let replayComplete = true;
    try {
      provider.assertComplete();
    } catch {
      replayComplete = false;
    }
    if (!result.grade.passed || !replayComplete) startup["working-turn"] = null;
    await writeImmutableReport(options.output, {
      trial,
      tier: "T2",
      taskId: task.id,
      fixtureHash: options.fixtureHash,
      grade: result.grade,
      terminal: result.terminal,
      replayComplete,
      usage: result.usage,
      requestMeasurements: provider.replay.requests,
      limitations: [
        "api-and-worker-share-runner-process",
        "host-pairing-not-measured",
        "vm-and-database-resources-not-measured",
        "physical-energy-not-measured",
        "task-delivery-is-not-live-quality",
      ],
    });
    capture = {
      version: 1,
      client: options.client,
      target: options.target,
      artifactHash: options.artifactHash,
      environmentHash: options.environmentHash,
      fixtureHash: options.fixtureHash,
      trial,
      reset: {
        id: trial.resetId,
        profileIsolated: true,
        stateRestored: true,
        cache: trial.stratum,
      },
      runtime: "ordinary-replay",
      productionBuild: true,
      physicalDevice: false,
      outcome:
        result.grade.passed && replayComplete
          ? "success"
          : result.terminal === "timed-out"
            ? "timed-out"
            : "failed",
      startup,
      batches: [...(clientBatch ? [clientBatch] : []), trace.snapshot()],
      calibrations,
    };
  } catch (error) {
    failure = { error };
    const partial = collectTraceEvidence([trace.snapshot()], {
      sessionId: trial.sessionId,
      pairId: null,
      requiredBoundaries: [],
    });
    const traceArtifact = await writeImmutableReport(options.output, partial.raw);
    await writeImmutableReport(options.output, {
      trial,
      stage,
      startup,
      traceArtifact,
      status: "incomplete",
      reason: signal.aborted ? "cancelled" : "capture-failed",
    });
  } finally {
    trace.stop();
    const clients = await Promise.allSettled([app?.close(), browser?.close()]);
    const services = await Promise.allSettled([closeTools?.(), provider?.close()]);
    cleanupFailed = [...clients, ...services].some((result) => result.status === "rejected");
    if (!cleanupFailed) await rm(directory, { recursive: true, force: true });
  }
  if (failure) throw failure.error;
  if (cleanupFailed) throw new Error("Client cleanup incomplete; isolated profile retained");
  if (!capture) throw new Error("Client capture unavailable");
  return capture;
}
