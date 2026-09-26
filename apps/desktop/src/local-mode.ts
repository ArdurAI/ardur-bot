import type { ChildProcess, SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalStackState } from "@ardurbot/contracts";
import { localFoldersFile } from "./local-folders.js";
import { writeServiceLog } from "./local-logs.js";
import type { EmbeddedPostgresLike, EmbeddedPostgresOptions } from "./local-postgres.js";
import {
  APP_DATABASE_USER,
  DATABASE_NAME,
  FORBIDDEN_PORTS,
  initialisePrivately,
  MissingDatabaseBinariesError,
  POSTGRES_USER,
  postgresProcess,
  postgresServesFolder,
  readPersistedPort,
  recordedPostmasterPort,
  stopOwnedPostgres,
  writePersistedPort,
} from "./local-postgres.js";
import { isArdurBotHealth } from "./setup-config.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const STOP_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 8_000;
const READY_BUDGET_MS = 60_000;
/** An unpackaged run compiles the API and worker sources with tsx first, which can take minutes. */
const SOURCE_READY_BUDGET_MS = 5 * 60_000;
const RESTART_WINDOW_MS = 5 * 60_000;
/** The worker's structured log line once its job host is running. */
const WORKER_READY = '"message":"worker ready"';
const SECRET_KEYS = {
  /** The superuser's, for maintenance and for proving a server serves this folder. */
  POSTGRES_PASSWORD: 16,
  /** The application role's. Not a cluster secret: a new one is set on the role at start. */
  APP_DATABASE_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
  SCREEN_PROXY_SECRET: 32,
  SANDBOX_SUPERVISOR_TOKEN: 32,
} as const;
/** Replacing either of these would lock the person out of an existing database. */
const CLUSTER_SECRETS = ["POSTGRES_PASSWORD", "ENCRYPTION_KEY"] as const;
const DATABASE_STOPPED = "The database stopped.";
const DATABASE_NOT_STARTED =
  "The database could not start. Retry, or restart the computer if it happens again.";
const NO_FREE_PORT = "No free local port was found. Close other apps, then Retry.";
const DATA_FOLDER_UNWRITABLE =
  "The app data folder could not be written. Check its permissions and free disk space, then Retry.";
const SETTINGS_UNSAVED =
  "The app could not save its database settings. Check free disk space, then Retry.";
const SETTINGS_UNREADABLE =
  "The app could not read its database settings. Check the permissions of the app data folder, then Retry.";
const SETTINGS_MISSING =
  "The app's database settings are missing. Reset local data in Settings, System, or restore the file from a backup.";
/** What a reset moves aside; ports and granted folders are kept. */
const LOCAL_DATA = ["postgres", "data", "secrets.env"] as const;

type SecretKey = keyof typeof SECRET_KEYS;
type ServiceName = "api" | "worker";

/**
 * A step before the services start failed. The message is the sentence the window shows;
 * `detail` goes to the local-mode log only. `offerReset` means only a reset clears it.
 */
class LocalModeFailure extends Error {
  constructor(
    message: string,
    readonly detail = "",
    readonly offerReset = false,
  ) {
    super(message);
  }
}

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
  /**
   * Creates the application database and its role as the superuser (`adminUrl`), then
   * applies migrations as that role (`databaseUrl`). An abort cancels the running statement.
   */
  migrate: (input: { adminUrl: string; databaseUrl: string; signal: AbortSignal }) => Promise<void>;
  /** May load the embedded binaries first; a missing package rejects with its name. */
  postgresFactory: (
    options: EmbeddedPostgresOptions,
  ) => EmbeddedPostgresLike | Promise<EmbeddedPostgresLike>;
  /** Stops a server a previous run left in the data folder, once it proved it serves it. */
  stopAdoptedPostgres: (databaseDir: string) => Promise<void>;
  /** Whether the server on `port` answers for this data folder; a real connection by default. */
  postgresServes?: (input: {
    port: number;
    password: string;
    databaseDir: string;
  }) => Promise<boolean>;
  allocatePort: () => Promise<number>;
  portAvailable: (port: number) => Promise<boolean>;
  randomHex: (bytes: number) => string;
  now: () => number;
  /** Delay before the next restart of a crashed service; doubles from one second by default. */
  restartDelayMs?: (restarts: number) => number;
  onState?: (state: DesktopLocalStackState) => void;
  onFailed?: (message: string) => void;
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
  private adminUrl = "";
  private databaseUrl = "";
  private secrets: Record<SecretKey, string> | null = null;
  private runAbort: AbortController | null = null;
  private stopping: Promise<void> | null = null;
  private stopRequests = 0;
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

  /**
   * A start while a stop winds down waits for it, then starts fresh, unless another stop
   * was asked for in the meantime.
   */
  start(): Promise<DesktopLocalStackState> {
    if (this.stopping) {
      const requests = this.stopRequests;
      return this.stopping.then(() =>
        this.stopRequests === requests ? this.start() : this.current,
      );
    }
    if (this.current.phase === "ready" && this.running()) return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    this.stopped = false;
    this.databaseReported = false;
    // Retry gives every service a fresh restart budget; run() starts whatever is not running.
    this.restartMarks.clear();
    this.clearRestartTimers();
    const abort = new AbortController();
    this.runAbort = abort;
    const run = this.run(abort.signal).finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Postgres is not restarted. The window shows one sentence; Retry calls start(). */
  reportDatabaseDown(): Promise<void> {
    if (this.databaseReported || this.stopped) return Promise.resolve();
    this.databaseReported = true;
    this.publish("failed", DATABASE_STOPPED);
    this.deps.onFailed?.(DATABASE_STOPPED);
    return this.releaseDatabase();
  }

  /**
   * For the main process's `exit` event, when nothing can be awaited: after a SIGTERM the
   * database library stops Postgres and exits, and the API and worker must not outlive it.
   */
  signalServicesNow(): void {
    for (const child of this.children.values()) {
      if (child.exitCode != null || child.signalCode != null) continue;
      try {
        if (child.pid && this.deps.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Cancels the run in flight and waits for it to settle, so no migration still holds a
   * connection, then stops the worker, the API, and the database and reports the stack idle.
   */
  stop(): Promise<void> {
    this.stopRequests += 1;
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.runAbort?.abort();
    this.clearRestartTimers();
    const stopping = this.stopNow().finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  /**
   * Stops everything, then moves the database, the files and the settings into
   * `backups/local-data-<time>` in the app data folder, so the next start begins fresh.
   */
  async resetData(): Promise<string> {
    await this.stop();
    const stamp = new Date(this.deps.now()).toISOString().replace(/[:.]/g, "-");
    const backup = path.join(this.deps.userDataDir, "backups", `local-data-${stamp}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of LOCAL_DATA) {
      try {
        await rename(path.join(this.deps.userDataDir, name), path.join(backup, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return backup;
  }

  private async stopNow(): Promise<void> {
    const run = this.inflight;
    if (run) await run.catch(() => undefined);
    if (this.inflight === run) this.inflight = null;
    await this.stopChild("worker");
    await this.stopChild("api");
    await this.releaseDatabase();
    this.publish("idle", null);
  }

  private async run(signal: AbortSignal): Promise<DesktopLocalStackState> {
    try {
      this.publish("database", null);
      await this.ensurePostgres(signal);
      if (this.stopped) return this.current;
      this.publish("migrations", null);
      await this.deps.migrate({
        adminUrl: this.adminUrl,
        databaseUrl: this.databaseUrl,
        signal,
      });
      if (this.stopped) return this.current;
      this.publish("services", null);
      if (!this.children.has("api")) this.spawn("api");
      if (!this.children.has("worker")) this.spawn("worker");
      if (!(await this.waitForServices(signal))) return this.current;
      this.publish("ready", null);
      return this.current;
    } catch (error) {
      if (this.stopped || this.databaseReported) return this.current;
      if (error instanceof LocalModeFailure) {
        this.log(error.detail);
        this.fail(error.message, error.offerReset);
      } else if (error instanceof MissingDatabaseBinariesError) {
        this.fail(error.message);
      } else if (this.current.phase === "migrations" && (await this.databaseAlive())) {
        await this.releaseDatabase();
        this.log(error instanceof Error ? error.message : String(error));
        const failure = migrationFailure(error);
        if (!this.stopped) this.fail(failure.message, failure.offerReset);
      } else {
        await this.reportDatabaseDown();
      }
      return this.current;
    }
  }

  /** Details a sentence leaves out, for the person who opens the logs folder. */
  private log(detail: string): void {
    if (!detail) return;
    const file = path.join(this.deps.userDataDir, "logs", "local-mode.log");
    void writeServiceLog(file, `${new Date(this.deps.now()).toISOString()} ${detail}\n`);
  }

  private databaseDir(): string {
    return path.join(this.deps.userDataDir, "postgres");
  }

  private async ensurePostgres(signal: AbortSignal): Promise<void> {
    const databaseDir = this.databaseDir();
    await this.prepareFolders();
    const secrets = await this.loadSecrets();
    this.secrets = secrets;
    this.postgresPort = await this.choosePort(path.join(this.deps.userDataDir, "postgres.port"));
    // A Retry after the worker stopped keeps the running API, and with it the open window's origin.
    if (!this.children.has("api")) {
      this.apiPort = await this.choosePort(path.join(this.deps.userDataDir, "api.port"));
    }
    this.originUrl = `http://127.0.0.1:${this.apiPort}`;
    this.useDatabasePort(this.postgresPort);
    // A server left running by an earlier run is used only if it proves it serves this
    // folder. Anything else in postmaster.pid is left to Postgres's own lock-file check.
    const recorded = await recordedPostmasterPort(databaseDir);
    if (
      recorded !== null &&
      !FORBIDDEN_PORTS.has(recorded) &&
      (await this.serves(recorded, secrets.POSTGRES_PASSWORD))
    ) {
      if (recorded !== this.postgresPort) {
        this.postgresPort = recorded;
        await this.persistPort(path.join(this.deps.userDataDir, "postgres.port"), recorded);
      }
      this.useDatabasePort(recorded);
      this.postgres = this.adopted(recorded, secrets.POSTGRES_PASSWORD);
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
    // From here stop() owns releasing it, once this run settles.
    this.postgres = postgres;
    if (this.stopped) return;
    // A stop during a start ends the server the library is starting, so the start settles.
    const onAbort = () => void stopOwnedPostgres(postgres);
    try {
      if (!(await exists(path.join(databaseDir, "PG_VERSION")))) {
        await initialisePrivately(postgres, this.deps.userDataDir);
      }
      if (this.stopped) return;
      signal.addEventListener("abort", onAbort, { once: true });
      await postgres.start();
    } catch {
      if (this.stopped) return;
      await this.releaseDatabase();
      throw new LocalModeFailure(DATABASE_NOT_STARTED);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    this.watchDatabase(postgres);
  }

  private useDatabasePort(port: number): void {
    const secrets = this.secrets!;
    this.adminUrl = databaseUrl(POSTGRES_USER, secrets.POSTGRES_PASSWORD, port);
    this.databaseUrl = databaseUrl(APP_DATABASE_USER, secrets.APP_DATABASE_PASSWORD, port);
  }

  /** A server that exits once started is reported once; Retry starts it again. */
  private watchDatabase(postgres: EmbeddedPostgresLike): void {
    postgresProcess(postgres)?.once("exit", () => {
      if (this.postgres === postgres) void this.reportDatabaseDown();
    });
  }

  /** A server this run did not start. It is stopped only after proving, again, that it is ours. */
  private adopted(port: number, password: string): EmbeddedPostgresLike {
    const databaseDir = this.databaseDir();
    return {
      initialise: async () => undefined,
      start: async () => undefined,
      stop: async () => {
        if (await this.serves(port, password)) await this.deps.stopAdoptedPostgres(databaseDir);
      },
    };
  }

  private serves(port: number, password: string): Promise<boolean> {
    const serves = this.deps.postgresServes ?? postgresServesFolder;
    return serves({ port, password, databaseDir: this.databaseDir() });
  }

  private async prepareFolders(): Promise<void> {
    for (const name of ["postgres", "data", "logs"]) {
      const folder = path.join(this.deps.userDataDir, name);
      try {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await access(folder, constants.W_OK);
      } catch (error) {
        throw new LocalModeFailure(DATA_FOLDER_UNWRITABLE, errorSummary(error));
      }
    }
  }

  private async releaseDatabase(): Promise<void> {
    const postgres = this.postgres;
    this.postgres = undefined;
    if (postgres) await stopOwnedPostgres(postgres);
  }

  /** Whether the server that owns this data folder still answers for it. */
  private async databaseAlive(): Promise<boolean> {
    if (!this.secrets) return false;
    return this.serves(this.postgresPort, this.secrets.POSTGRES_PASSWORD);
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
    // A process that could not start emits `error` and may never emit `exit`.
    child.once("error", () => this.onChildExit(service, child));
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

  private fail(message: string, offerReset = false): void {
    this.publish("failed", message, offerReset);
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
  private async waitForServices(signal: AbortSignal): Promise<boolean> {
    const deadline =
      this.deps.now() + (this.deps.packaged ? READY_BUDGET_MS : SOURCE_READY_BUDGET_MS);
    let apiAnswered = false;
    while (!this.stopped && !this.failed() && this.deps.now() <= deadline) {
      apiAnswered = await this.probe(signal);
      if (apiAnswered && this.workerReady && !this.failed()) return true;
      await delay(200);
    }
    if (this.stopped || this.failed()) return false;
    const service = apiAnswered ? "worker" : "api";
    await this.stopChild(service);
    if (!this.stopped) this.failService(service);
    return false;
  }

  private async probe(signal: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
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
      signal.removeEventListener("abort", abort);
    }
  }

  private async choosePort(file: string): Promise<number> {
    const saved = await readPersistedPort(file);
    if (saved !== null && (await this.deps.portAvailable(saved))) return saved;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await this.deps.allocatePort().catch(() => null);
      if (port === null || FORBIDDEN_PORTS.has(port)) continue;
      if (!(await this.deps.portAvailable(port))) continue;
      await this.persistPort(file, port);
      return port;
    }
    throw new LocalModeFailure(NO_FREE_PORT);
  }

  private async persistPort(file: string, port: number): Promise<void> {
    try {
      await writePersistedPort(file, port);
    } catch (error) {
      throw settingsWriteFailure(error);
    }
  }

  /**
   * Secrets are generated once. Over an existing database they are never generated again:
   * a new password or encryption key would lock the person out of their own data.
   */
  private async loadSecrets(): Promise<Record<SecretKey, string>> {
    const file = path.join(this.deps.userDataDir, "secrets.env");
    const saved = await readSecrets(file);
    if (await exists(path.join(this.databaseDir(), "PG_VERSION"))) {
      if (saved.problem === "unreadable") {
        throw new LocalModeFailure(SETTINGS_UNREADABLE, saved.detail);
      }
      const missing = CLUSTER_SECRETS.find((key) => !saved.values[key]);
      if (saved.problem === "missing" || missing) {
        throw new LocalModeFailure(
          SETTINGS_MISSING,
          saved.detail || `secrets.env has no ${missing}`,
          true,
        );
      }
    }
    const parsed = saved.values;
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
      try {
        await writePrivateFile(file, `${body}\n`);
      } catch (error) {
        throw settingsWriteFailure(error);
      }
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

  private publish(
    phase: DesktopLocalStackState["phase"],
    message: string | null,
    offerReset = false,
  ): void {
    this.current = {
      phase,
      message,
      output: [],
      layerBytes: {},
      imageTag: "",
      ...(offerReset ? { offerReset } : {}),
    };
    this.deps.onState?.(this.current);
  }
}

function settingsWriteFailure(error: unknown): LocalModeFailure {
  return new LocalModeFailure(SETTINGS_UNSAVED, errorSummary(error));
}

/** `EACCES: permission denied`, without the path Node appends. */
function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.split(", ")[0]!.trim() || "unknown error";
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * `missing` covers no file and something other than a file in its place; `unreadable`, a
 * file that cannot be read. `detail` is Node's code and text, for the log only.
 */
async function readSecrets(file: string): Promise<{
  values: Partial<Record<SecretKey, string>>;
  problem: "missing" | "unreadable" | null;
  detail: string;
}> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) {
      return { values: {}, problem: "missing", detail: "secrets.env is not a regular file" };
    }
    await access(file, constants.R_OK);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { values: {}, problem: missing ? "missing" : "unreadable", detail: errorSummary(error) };
  }
  const text = await readPrivateFile(file, 4096);
  if (text === null)
    return { values: {}, problem: "unreadable", detail: "secrets.env is unreadable" };
  return { values: parseSecrets(text), problem: null, detail: "" };
}

const INSTALL_LATEST = "Install the latest version of Ardur Bot, then Retry.";

/**
 * The sentence for a failed migration while the server itself is still up. The migration's
 * own error keeps its name and first line; the full text is in the local-mode log.
 */
function migrationFailure(error: unknown): { message: string; offerReset: boolean } {
  const failure = (typeof error === "object" && error !== null ? error : {}) as {
    reason?: unknown;
    migrationName?: unknown;
    databaseError?: unknown;
    message?: unknown;
  };
  if (failure.reason === "newer") {
    return {
      message: `This data was last opened by a newer version of Ardur Bot. ${INSTALL_LATEST}`,
      offerReset: false,
    };
  }
  if (failure.reason === "modified") {
    return {
      message: `This version of Ardur Bot does not match its database. ${INSTALL_LATEST}`,
      offerReset: false,
    };
  }
  if (failure.reason === "unfinished") {
    return {
      message:
        "An earlier database update did not finish. Reset local data in Settings, System, or restore the app data folder from a backup.",
      offerReset: true,
    };
  }
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
  const action = "Retry, or install the latest version if it happens again.";
  return {
    message: detail
      ? `Preparing the database failed${at}: ${detail}. ${action}`
      : `Preparing the database failed${at}. ${action}`,
    offerReset: false,
  };
}

function idleState(): DesktopLocalStackState {
  return { phase: "idle", message: null, output: [], layerBytes: {}, imageTag: "" };
}

function databaseUrl(user: string, password: string, port: number): string {
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE_NAME}`;
}

function parseSecrets(raw: string): Partial<Record<SecretKey, string>> {
  const parsed: Partial<Record<SecretKey, string>> = {};
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
    ARDURBOT_HOST_ROOTS_FILE: localFoldersFile(settings.userDataDir),
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
