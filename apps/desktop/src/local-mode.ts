import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalStackState } from "@ardurbot/contracts";
import { writeServiceLog } from "./local-logs.js";
import {
  DATABASE_NAME,
  type EmbeddedPostgresLike,
  type EmbeddedPostgresOptions,
  FORBIDDEN_PORTS,
  legacyStackEnvExists,
  POSTGRES_USER,
  readPersistedPort,
  writePersistedPort,
} from "./local-postgres.js";
import { isArdurBotHealth } from "./setup-config.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const STOP_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 8_000;
const READY_BUDGET_MS = 60_000;
const RESTART_WINDOW_MS = 5 * 60_000;
const SECRET_KEYS = {
  POSTGRES_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
  SCREEN_PROXY_SECRET: 32,
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
  postgresFactory: (options: EmbeddedPostgresOptions) => EmbeddedPostgresLike;
  allocatePort: () => Promise<number>;
  portAvailable: (port: number) => Promise<boolean>;
  randomHex: (bytes: number) => string;
  now: () => number;
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
  return {
    command: input.execPath,
    args: input.packaged
      ? [path.join(input.resourcesPath, "services", `${entry}.cjs`)]
      : [
          "--import",
          path.join(input.appPath, "../../node_modules/tsx/dist/loader.mjs"),
          path.join(input.appPath, "..", entry, "src", "index.ts"),
        ],
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
    return !this.stopped && (this.postgres !== undefined || this.inflight !== null);
  }

  start(): Promise<DesktopLocalStackState> {
    if (this.current.phase === "ready" && this.running()) return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    this.stopped = false;
    this.databaseReported = false;
    const run = this.run().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Postgres is not restarted. The window shows one sentence; Retry calls start(). */
  reportDatabaseDown(): void {
    if (this.databaseReported || this.stopped) return;
    this.databaseReported = true;
    this.postgres = undefined;
    this.publish("failed", "The database stopped.");
    this.deps.onFailed?.("The database stopped.");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
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
      this.publish("migrations", null);
      await this.deps.migrate(this.databaseUrl);
      this.publish("services", null);
      if (!this.children.has("api")) this.spawn("api");
      if (!this.children.has("worker")) this.spawn("worker");
      if (!(await this.waitForHealth())) {
        this.failService("api");
        return this.current;
      }
      this.originUrl = `http://127.0.0.1:${this.apiPort}`;
      const opened = await this.deps.openApp(this.originUrl);
      if (!opened) {
        this.failService("api");
        return this.current;
      }
      this.publish("ready", null);
      return this.current;
    } catch {
      if (!this.databaseReported) this.reportDatabaseDown();
      return this.current;
    }
  }

  private async ensurePostgres(): Promise<void> {
    const secrets = await this.loadSecrets();
    this.secrets = secrets;
    this.postgresPort = await this.choosePort(path.join(this.deps.userDataDir, "postgres.port"));
    this.apiPort = await this.choosePort(path.join(this.deps.userDataDir, "api.port"));
    this.originUrl = `http://127.0.0.1:${this.apiPort}`;
    this.databaseUrl = databaseUrl(secrets.POSTGRES_PASSWORD, this.postgresPort);
    const databaseDir = path.join(this.deps.userDataDir, "postgres");
    await mkdir(databaseDir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.deps.userDataDir, "data"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.deps.userDataDir, "logs"), { recursive: true, mode: 0o700 });
    const postgres = this.deps.postgresFactory({
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
    try {
      await stat(path.join(databaseDir, "PG_VERSION"));
    } catch {
      await postgres.initialise();
    }
    await postgres.start();
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
    const child = this.deps.spawn(launch.command, launch.args, {
      shell: false,
      windowsHide: true,
      detached: this.deps.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: serviceEnvironment(this.deps.env, this.deps.platform, {
        databaseUrl: this.databaseUrl,
        dataDir: path.join(this.deps.userDataDir, "data"),
        origin: this.originUrl,
        apiPort: this.apiPort,
        secrets: this.secrets,
      }),
    });
    this.children.set(service, child);
    const log = path.join(this.deps.userDataDir, "logs", `${service}.log`);
    child.stdout?.on("data", (chunk: Buffer) => {
      void writeServiceLog(log, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      void writeServiceLog(log, chunk);
    });
    child.once("exit", () => this.onChildExit(service, child));
  }

  private onChildExit(service: ServiceName, child: ChildProcess): void {
    if (this.children.get(service) !== child) return;
    this.children.delete(service);
    if (this.stopped) return;
    const now = this.deps.now();
    const marks = (this.restartMarks.get(service) ?? []).filter(
      (mark) => now - mark < RESTART_WINDOW_MS,
    );
    if (marks.length >= 3) {
      this.failService(service);
      return;
    }
    const delay = 1_000 * 2 ** marks.length;
    marks.push(now);
    this.restartMarks.set(service, marks);
    const timer = setTimeout(() => {
      this.restartTimers.delete(service);
      if (!this.stopped) this.spawn(service);
    }, delay);
    this.restartTimers.set(service, timer);
  }

  private failService(service: ServiceName): void {
    const message = service === "api" ? "The API stopped." : "The worker stopped.";
    this.publish("failed", message);
    this.deps.onFailed?.(message);
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = this.deps.now() + READY_BUDGET_MS;
    while (!this.stopped && this.deps.now() <= deadline) {
      if (await this.probe()) return true;
      if (this.deps.now() === deadline) break;
      await delay(200);
    }
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
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    ELECTRON_RUN_AS_NODE: "1",
    DATABASE_URL: settings.databaseUrl,
    DATA_DIR: settings.dataDir,
    SANDBOX_PROVIDER: "desktop",
    BETTER_AUTH_SECRET: settings.secrets.BETTER_AUTH_SECRET,
    ENCRYPTION_KEY: settings.secrets.ENCRYPTION_KEY,
    SCREEN_PROXY_SECRET: settings.secrets.SCREEN_PROXY_SECRET,
    BETTER_AUTH_URL: settings.origin,
    WEB_ORIGIN: settings.origin,
    API_URL: settings.origin,
    API_HOST: "127.0.0.1",
    API_PORT: String(settings.apiPort),
    NODE_ENV: source.NODE_ENV === "test" ? "production" : (source.NODE_ENV ?? "production"),
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
