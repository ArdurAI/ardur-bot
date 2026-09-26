import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalStackState } from "@ardurbot/contracts";
import { HOST_ROOTS_FILE } from "./host-service.js";
import { writeServiceLog } from "./local-logs.js";
import {
  DATABASE_NAME,
  type EmbeddedPostgresLike,
  type EmbeddedPostgresOptions,
  FORBIDDEN_PORTS,
  legacyStackEnvExists,
  livePostmaster,
  MissingDatabaseBinariesError,
  POSTGRES_USER,
  pidIsAlive,
  readPersistedPort,
  stopPostmaster,
  writePersistedPort,
} from "./local-postgres.js";
import { isArdurBotHealth } from "./setup-config.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const STOP_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 8_000;
const READY_BUDGET_MS = 60_000;
const RESTART_WINDOW_MS = 5 * 60_000;
/** The worker's structured log line once its job host is running. */
const WORKER_READY = '"message":"worker ready"';
const SECRET_KEYS = {
  POSTGRES_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
  SCREEN_PROXY_SECRET: 32,
  SANDBOX_SUPERVISOR_TOKEN: 32,
} as const;

type SecretKey = keyof typeof SECRET_KEYS;
type ServiceName = "api" | "worker";

export interface LocalModeDependencies {
  userDataDir: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  execPath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  openApp: (url: string) => Promise<boolean>;
  migrate: (databaseUrl: string) => Promise<void>;
  /** May load the embedded binaries first; a missing package rejects with its name. */
  postgresFactory: (
    options: EmbeddedPostgresOptions,
  ) => EmbeddedPostgresLike | Promise<EmbeddedPostgresLike>;
  allocatePort: () => Promise<number>;
  portAvailable: (port: number) => Promise<boolean>;
  randomHex: (bytes: number) => string;
  now: () => number;
  /** Delay before the next restart of a crashed service; doubles from one second by default. */
  restartDelayMs?: (restarts: number) => number;
  postmasterAlive?: (pid: number) => boolean;
  stopPostmaster?: (pid: number) => Promise<void>;
  onState?: (state: DesktopLocalStackState) => void;
  onFailed?: (message: string) => void;
}

export async function launchDesktopServices(input: {
  userDataDir: string;
  local: { start: () => Promise<unknown> };
  compose: { start: () => Promise<unknown> };
}): Promise<"local" | "compose"> {
  if (await legacyStackEnvExists(input.userDataDir)) {
    await input.compose.start();
    return "compose";
  }
  await input.local.start();
  return "local";
}

export function migrationsDir(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, "migrations");
  return path.resolve(input.appPath, "..", "..", "packages", "db", "prisma", "migrations");
}

export function localServiceLaunch(input: {
  service: ServiceName;
  packaged: boolean;
  execPath: string;
  resourcesPath: string;
  appPath: string;
}) {
  const entry = input.service === "api" ? "api" : "worker";
  if (!input.packaged) {
    return {
      command: input.execPath,
      args: [
        "--import",
        path.join(input.appPath, "../../node_modules/tsx/dist/loader.mjs"),
        path.join(input.appPath, "..", entry, "src", "index.ts"),
      ],
      nodePath: undefined,
    };
  }
  // The bundles are ESM so top-level await in the API entry can stay. Prisma's
  // WASM and native addons are real files next to the bundles. electron-builder
  // drops a copied directory named node_modules, so those files live in
  // `modules`. The loader resolves ESM imports from there. NODE_PATH covers
  // CommonJS require().
  const services = path.join(input.resourcesPath, "services");
  return {
    command: input.execPath,
    args: [
      "--import",
      path.join(services, "services-loader.mjs"),
      path.join(services, `${entry}.mjs`),
    ],
    nodePath: path.join(services, "modules"),
  };
}

export class LocalModeController {
  private current: DesktopLocalStackState = idleState();
  private inflight: Promise<DesktopLocalStackState> | null = null;
  private postgres: EmbeddedPostgresLike | undefined;
  private postgresPort = 0;
  private apiPort = 0;
  private originUrl = "";
  private databaseUrl = "";
  private secrets: Record<SecretKey, string> | null = null;
  private readonly children = new Map<ServiceName, ChildProcess>();
  private readonly restartMarks = new Map<ServiceName, number[]>();
  private readonly restartTimers = new Map<ServiceName, ReturnType<typeof setTimeout>>();
  private workerOutput = "";
  private workerReady = false;
  private stopped = true;
  private databaseReported = false;

  constructor(private readonly deps: LocalModeDependencies) {}

  state(): DesktopLocalStackState {
    return this.current;
  }

  origin(): string {
    return this.originUrl;
  }

  running(): boolean {
    return this.postgres !== undefined || (this.inflight !== null && !this.stopped);
  }

  start(): Promise<DesktopLocalStackState> {
    if (this.current.phase === "ready" && this.running()) return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    this.stopped = false;
    this.databaseReported = false;
    // Retry gives every service a fresh restart budget; run() starts whatever is not running.
    this.restartMarks.clear();
    this.clearRestartTimers();
    const run = this.run().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Postgres is not restarted. The window shows one sentence; Retry calls start(). */
  reportDatabaseDown(): Promise<void> {
    if (this.databaseReported || this.stopped) return Promise.resolve();
    this.databaseReported = true;
    const postgres = this.postgres;
    this.postgres = undefined;
    this.publish("failed", "The database stopped.");
    this.deps.onFailed?.("The database stopped.");
    return postgres
      ? postgres.stop().then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRestartTimers();
    await this.stopChild("worker");
    await this.stopChild("api");
    const postgres = this.postgres;
    this.postgres = undefined;
    if (postgres) await postgres.stop();
  }

  private async run(): Promise<DesktopLocalStackState> {
    try {
      this.publish("database", null);
      await this.ensurePostgres();
      if (this.stopped) return this.current;
      this.publish("migrations", null);
      await this.deps.migrate(this.databaseUrl);
      if (this.stopped) return this.current;
      this.publish("services", null);
      if (!this.children.has("api")) this.spawn("api");
      if (!this.children.has("worker")) this.spawn("worker");
      if (!(await this.waitForServices())) return this.current;
      this.originUrl = `http://127.0.0.1:${this.apiPort}`;
      const opened = await this.deps.openApp(this.originUrl);
      if (this.stopped || this.failed()) return this.current;
      if (!opened) {
        this.failService("api");
        return this.current;
      }
      this.publish("ready", null);
      return this.current;
    } catch (error) {
      if (this.stopped || this.databaseReported) return this.current;
      if (error instanceof MissingDatabaseBinariesError) {
        this.fail(error.message);
      } else if (this.current.phase === "migrations" && (await this.databaseAlive())) {
        await this.releaseDatabase();
        if (!this.stopped) this.fail(migrationFailureSentence(error));
      } else {
        await this.reportDatabaseDown();
      }
      return this.current;
    }
  }

  private async ensurePostgres(): Promise<void> {
    const secrets = await this.loadSecrets();
    this.secrets = secrets;
    this.postgresPort = await this.choosePort(path.join(this.deps.userDataDir, "postgres.port"));
    // A Retry after the worker stopped keeps the running API, and with it the open window's origin.
    if (!this.children.has("api")) {
      this.apiPort = await this.choosePort(path.join(this.deps.userDataDir, "api.port"));
    }
    this.originUrl = `http://127.0.0.1:${this.apiPort}`;
    this.databaseUrl = databaseUrl(secrets.POSTGRES_PASSWORD, this.postgresPort);
    const databaseDir = path.join(this.deps.userDataDir, "postgres");
    await mkdir(databaseDir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.deps.userDataDir, "data"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.deps.userDataDir, "logs"), { recursive: true, mode: 0o700 });
    const live = await livePostmaster(databaseDir, this.deps.postmasterAlive ?? pidIsAlive);
    if (live) {
      if (live.port >= 1024 && live.port !== this.postgresPort && !FORBIDDEN_PORTS.has(live.port)) {
        this.postgresPort = live.port;
        await writePersistedPort(path.join(this.deps.userDataDir, "postgres.port"), live.port);
      }
      this.databaseUrl = databaseUrl(secrets.POSTGRES_PASSWORD, this.postgresPort);
      this.postgres = attachedPostgres(live.pid, this.deps.stopPostmaster ?? stopPostmaster);
      if (this.stopped) await this.releaseDatabase();
      return;
    }
    const postgres = await this.deps.postgresFactory({
      databaseDir,
      port: this.postgresPort,
      user: POSTGRES_USER,
      password: secrets.POSTGRES_PASSWORD,
      persistent: true,
      authMethod: "scram-sha-256",
      postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
      onLog: (message) => {
        void writeServiceLog(path.join(this.deps.userDataDir, "logs", "postgres.log"), message);
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        void writeServiceLog(path.join(this.deps.userDataDir, "logs", "postgres.log"), message);
      },
    });
    this.postgres = postgres;
    if (this.stopped) {
      await this.releaseDatabase();
      return;
    }
    try {
      try {
        await stat(path.join(databaseDir, "PG_VERSION"));
      } catch {
        await postgres.initialise();
      }
      if (this.stopped) {
        await this.releaseDatabase();
        return;
      }
      await postgres.start();
    } catch {
      await this.releaseDatabase();
      throw new Error("The database stopped.");
    }
    if (this.stopped) await this.releaseDatabase();
  }

  private async releaseDatabase(): Promise<void> {
    const postgres = this.postgres;
    this.postgres = undefined;
    if (postgres) await postgres.stop().catch(() => undefined);
  }

  /** Whether the postmaster that owns this data directory is still running. */
  private async databaseAlive(): Promise<boolean> {
    const databaseDir = path.join(this.deps.userDataDir, "postgres");
    return (await livePostmaster(databaseDir, this.deps.postmasterAlive ?? pidIsAlive)) !== null;
  }

  private spawn(service: ServiceName): void {
    if (this.stopped || !this.secrets) return;
    const launch = localServiceLaunch({
      service,
      packaged: this.deps.packaged,
      execPath: this.deps.execPath,
      resourcesPath: this.deps.resourcesPath,
      appPath: this.deps.appPath,
    });
    const env = serviceEnvironment(this.deps.env, this.deps.platform, {
      databaseUrl: this.databaseUrl,
      dataDir: path.join(this.deps.userDataDir, "data"),
      origin: this.originUrl,
      apiPort: this.apiPort,
      secrets: this.secrets,
      userDataDir: this.deps.userDataDir,
    });
    if (launch.nodePath) env.NODE_PATH = launch.nodePath;
    const child = this.deps.spawn(launch.command, launch.args, {
      shell: false,
      windowsHide: true,
      detached: this.deps.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    this.children.set(service, child);
    if (service === "worker") {
      this.workerOutput = "";
      this.workerReady = false;
    }
    const log = path.join(this.deps.userDataDir, "logs", `${service}.log`);
    const output = (chunk: Buffer) => {
      void writeServiceLog(log, chunk);
      if (service === "worker" && this.children.get(service) === child) this.noteWorker(chunk);
    };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    child.once("exit", () => this.onChildExit(service, child));
  }

  /** Keeps a short tail so the ready line is found even when split across chunks. */
  private noteWorker(chunk: Buffer): void {
    if (this.workerReady) return;
    const text = this.workerOutput + chunk.toString("utf8");
    this.workerReady = text.includes(WORKER_READY);
    this.workerOutput = text.slice(-WORKER_READY.length);
  }

  private onChildExit(service: ServiceName, child: ChildProcess): void {
    if (this.children.get(service) !== child) return;
    this.children.delete(service);
    if (service === "worker") this.workerReady = false;
    if (this.stopped) return;
    const now = this.deps.now();
    const marks = (this.restartMarks.get(service) ?? []).filter(
      (mark) => now - mark < RESTART_WINDOW_MS,
    );
    if (marks.length >= 3) {
      this.failService(service);
      return;
    }
    const delay = this.deps.restartDelayMs?.(marks.length) ?? 1_000 * 2 ** marks.length;
    marks.push(now);
    this.restartMarks.set(service, marks);
    const timer = setTimeout(() => {
      this.restartTimers.delete(service);
      if (!this.stopped && !this.children.has(service)) this.spawn(service);
    }, delay);
    this.restartTimers.set(service, timer);
  }

  private clearRestartTimers(): void {
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
  }

  private failService(service: ServiceName): void {
    this.fail(service === "api" ? "The API stopped." : "The worker stopped.");
  }

  private fail(message: string): void {
    this.publish("failed", message);
    this.deps.onFailed?.(message);
  }

  /** A service or the database gave up since this run published its last phase. */
  private failed(): boolean {
    return this.current.phase === "failed";
  }

  /**
   * Ready needs the API's health answer and the worker's ready line. A service that
   * gives up restarting during the wait ends it. One that is still not ready at the
   * deadline is stopped, so the sentence that names it is true and Retry starts it fresh.
   */
  private async waitForServices(): Promise<boolean> {
    const deadline = this.deps.now() + READY_BUDGET_MS;
    let apiAnswered = false;
    while (!this.stopped && !this.failed() && this.deps.now() <= deadline) {
      apiAnswered = await this.probe();
      if (apiAnswered && this.workerReady && !this.failed()) return true;
      if (this.deps.now() === deadline) break;
      await delay(200);
    }
    if (this.stopped || this.failed()) return false;
    const service = apiAnswered ? "worker" : "api";
    await this.stopChild(service);
    if (!this.stopped) this.failService(service);
    return false;
  }

  private async probe(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(`${this.originUrl}/rpc/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
        signal: controller.signal,
      });
      if (!response.ok) return false;
      return isArdurBotHealth(await response.json());
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async choosePort(file: string): Promise<number> {
    const saved = await readPersistedPort(file);
    if (saved !== null && (await this.deps.portAvailable(saved))) return saved;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await this.deps.allocatePort();
      if (FORBIDDEN_PORTS.has(port)) continue;
      if (!(await this.deps.portAvailable(port))) continue;
      await writePersistedPort(file, port);
      return port;
    }
    throw new Error("No loopback port is free.");
  }

  private async loadSecrets(): Promise<Record<SecretKey, string>> {
    const file = path.join(this.deps.userDataDir, "secrets.env");
    const parsed = parseSecrets(await readPrivateFile(file, 4096));
    let changed = false;
    for (const key of Object.keys(SECRET_KEYS) as SecretKey[]) {
      if (!parsed[key]) {
        parsed[key] = this.deps.randomHex(SECRET_KEYS[key]);
        changed = true;
      }
    }
    if (changed) {
      const body = (Object.keys(SECRET_KEYS) as SecretKey[])
        .map((key) => `${key}=${parsed[key]}`)
        .join("\n");
      await writePrivateFile(file, `${body}\n`);
    }
    return parsed as Record<SecretKey, string>;
  }

  private async stopChild(service: ServiceName): Promise<void> {
    const timer = this.restartTimers.get(service);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(service);
    const child = this.children.get(service);
    this.children.delete(service);
    if (!child) return;
    await signalChild(child, "SIGINT", STOP_TIMEOUT_MS);
  }

  private publish(phase: DesktopLocalStackState["phase"], message: string | null): void {
    this.current = {
      phase,
      message,
      output: [],
      layerBytes: {},
      imageTag: "",
    };
    this.deps.onState?.(this.current);
  }
}

function attachedPostgres(pid: number, stop: (pid: number) => Promise<void>): EmbeddedPostgresLike {
  return {
    initialise: async () => undefined,
    start: async () => undefined,
    stop: () => stop(pid),
  };
}

/** The migration and the database's first line, while the server itself is still up. */
function migrationFailureSentence(error: unknown): string {
  const failure = (typeof error === "object" && error !== null ? error : {}) as {
    migrationName?: unknown;
    databaseError?: unknown;
    message?: unknown;
  };
  const raw =
    typeof failure.databaseError === "string"
      ? failure.databaseError
      : typeof failure.message === "string"
        ? failure.message
        : "";
  const detail = (raw.split("\n").find((line) => line.trim()) ?? "")
    .trim()
    .replace(/\.+$/u, "")
    .slice(0, 200);
  const at = typeof failure.migrationName === "string" ? ` at ${failure.migrationName}` : "";
  return detail
    ? `Preparing the database failed${at}: ${detail}.`
    : `Preparing the database failed${at}.`;
}

function idleState(): DesktopLocalStackState {
  return { phase: "idle", message: null, output: [], layerBytes: {}, imageTag: "" };
}

function databaseUrl(password: string, port: number): string {
  return `postgres://${POSTGRES_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE_NAME}`;
}

function parseSecrets(raw: string | null): Partial<Record<SecretKey, string>> {
  const parsed: Partial<Record<SecretKey, string>> = {};
  if (!raw) return parsed;
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!Object.hasOwn(SECRET_KEYS, key)) continue;
    const value = line.slice(separator + 1).trim();
    if (value) parsed[key as SecretKey] = value;
  }
  return parsed;
}

function serviceEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  settings: {
    databaseUrl: string;
    dataDir: string;
    origin: string;
    apiPort: number;
    secrets: Record<SecretKey, string>;
    userDataDir: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    ELECTRON_RUN_AS_NODE: "1",
    DATABASE_URL: settings.databaseUrl,
    DATA_DIR: settings.dataDir,
    SANDBOX_PROVIDER: "desktop",
    ARDURBOT_HOST_ROOTS_FILE: path.join(settings.userDataDir, "host-service", HOST_ROOTS_FILE),
    BETTER_AUTH_SECRET: settings.secrets.BETTER_AUTH_SECRET,
    ENCRYPTION_KEY: settings.secrets.ENCRYPTION_KEY,
    SCREEN_PROXY_SECRET: settings.secrets.SCREEN_PROXY_SECRET,
    SANDBOX_SUPERVISOR_TOKEN: settings.secrets.SANDBOX_SUPERVISOR_TOKEN,
    BETTER_AUTH_URL: settings.origin,
    WEB_ORIGIN: settings.origin,
    API_URL: settings.origin,
    API_HOST: "127.0.0.1",
    API_PORT: String(settings.apiPort),
    NODE_ENV: source.NODE_ENV === "test" ? "production" : (source.NODE_ENV ?? "production"),
    // The supervisor reads the worker's ready line from structured logs.
    LOG_FORMAT: "json",
  };
  delete env.ARDURBOT_HOST_BRIDGE;
  if (platform === "win32") env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  return env;
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  } else {
    child.kill(signal);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    void exited.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
