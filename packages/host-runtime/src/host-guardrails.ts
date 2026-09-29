import { existsSync, readdirSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Host command guardrails.
 *
 * A bot on a host computer ("This Mac") runs commands as the owner's user. That access
 * reaches Ardur's own control plane: the env file holding DATABASE_URL and the key that
 * decrypts stored credentials, the app data folder, and the local database/API/supervisor
 * ports. This module computes the deny list from the running configuration (never from
 * hardcoded paths) and applies it two ways:
 *
 * - macOS: every host command runs under `/usr/bin/sandbox-exec` with a Seatbelt profile
 *   generated per process. The profile is `(allow default)` plus targeted denies, so
 *   ordinary work is untouched while the listed files stay unreadable, the listed
 *   loopback ports stay unreachable, and the local container-engine sockets (which are
 *   root-equivalent and hold the stack's own container secrets) stay unconnectable. The
 *   same deny-over-allow carve-out is how the Codex CLI keeps writable roots read-only
 *   under `.git` (openai/codex seatbelt_base_policy.sbpl); Claude Code's sandbox runtime
 *   likewise generates a Seatbelt profile string and executes
 *   through `/usr/bin/sandbox-exec -p`. `sandbox-exec` is documented as DEPRECATED in its
 *   man page but remains the mechanism both tools ship on macOS.
 * - Every platform: the in-process file tools check the same deny list, so a registered
 *   folder that happens to contain a protected file still cannot serve it to a bot.
 *
 * Linux has no wrapper here: Landlock needs kernel 6.7+ for TCP rules and a native syscall
 * helper this repo cannot ship offline, and bubblewrap can only mask files, not filter
 * ports (`--unshare-net` is all-or-nothing). Linux commands therefore run unwrapped and the
 * UI warning stays the honest statement of protection there. Windows is out of scope.
 */

export interface HostGuardrailConfig {
  /** Absolute paths (files or directory roots) a host command must never read or write. */
  paths: string[];
  /** Loopback TCP ports a host command must never connect to. */
  ports: number[];
  /** Absolute unix-socket paths a host command must never connect to (engine sockets). */
  sockets: string[];
}

/**
 * App-managed state under DATA_DIR. `desktop-computers` holds the bots' own homes and `board`
 * holds the board databases that host board commands must keep writing — both stay open.
 */
export const GUARDED_DATA_DIR_CHILDREN = [
  "artifacts",
  "home-revisions",
  "homes",
  "pi-sessions",
  "push-tokens",
] as const;

/** The DATA_DIR children host work must keep writing; everything else there can be denied. */
export const OPEN_DATA_DIR_CHILDREN = ["board", "desktop-computers"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The port a URL reaches on this machine's loopback interface, or undefined when remote. */
export function loopbackPortOf(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  if (url.port) {
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  }
  if (url.protocol === "postgres:" || url.protocol === "postgresql:") return 5432;
  if (url.protocol === "http:") return 80;
  if (url.protocol === "https:") return 443;
  return undefined;
}

function validPort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function subdirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** unix:// endpoints name a socket; a loopback tcp:// endpoint names a port. */
function parseEngineEndpoint(value: string | undefined): { socket?: string; port?: number } {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("unix://")) {
    const socket = trimmed.slice("unix://".length);
    return path.isAbsolute(socket) ? { socket } : {};
  }
  const port = loopbackPortOf(trimmed);
  return port === undefined ? {} : { port };
}

/**
 * The local container-engine endpoints a host command must never reach. An engine socket is
 * root-equivalent on this machine: through it a command can inspect or enter Ardur's own
 * containers and read the stack's DATABASE_URL, Postgres password and supervisor token from
 * their environment. The list covers the default Docker socket, Docker Desktop's user
 * sockets, Colima profiles, OrbStack, Podman machine sockets, and whatever `DOCKER_HOST` or
 * `CONTAINER_HOST` points at, resolved from the running configuration where it is set.
 * `fleet/discovery.ts` probes the same engines to offer Docker computers; a bot that needs
 * containers belongs on one of those (or a VM), not on This Mac. Missing paths are still
 * denied as written: an engine installed later lands where the deny already points.
 */
export function containerEngineGuard(env: NodeJS.ProcessEnv = process.env): {
  sockets: string[];
  ports: number[];
} {
  const sockets: string[] = ["/var/run/docker.sock"];
  const ports: number[] = [];
  const home = env.HOME?.trim();
  if (home && path.isAbsolute(home)) {
    sockets.push(
      path.join(home, ".docker", "run", "docker.sock"),
      path.join(home, ".docker", "desktop", "docker.sock"),
      path.join(home, ".orbstack", "run", "docker.sock"),
    );
    const colima = path.join(home, ".colima");
    for (const profile of ["default", ...subdirectories(colima)])
      sockets.push(path.join(colima, profile, "docker.sock"));
    const dataHome = env.XDG_DATA_HOME?.trim();
    const podmanMachine =
      dataHome && path.isAbsolute(dataHome)
        ? path.join(dataHome, "containers", "podman", "machine")
        : path.join(home, ".local", "share", "containers", "podman", "machine");
    sockets.push(path.join(podmanMachine, "podman.sock"));
    for (const provider of subdirectories(podmanMachine))
      sockets.push(path.join(podmanMachine, provider, "podman.sock"));
  }
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${process.getuid?.() ?? 1000}`;
  if (path.isAbsolute(runtimeDir)) sockets.push(path.join(runtimeDir, "podman", "podman.sock"));
  for (const value of [env.DOCKER_HOST, env.CONTAINER_HOST]) {
    const endpoint = parseEngineEndpoint(value);
    if (endpoint.socket) sockets.push(endpoint.socket);
    if (endpoint.port !== undefined) ports.push(endpoint.port);
  }
  return { sockets: [...new Set(sockets)], ports: [...new Set(ports)] };
}

/**
 * A source checkout's embedded Postgres keeps its cluster in DATA_DIR itself, with the
 * dev-generated credentials.json beside it. When the cluster marker is present, every entry
 * except the children host work must keep writing is a database file to deny. Deriving the
 * entries from the directory itself means a file a future Postgres adds is denied too.
 */
function databaseDataPaths(resolvedData: string): string[] {
  if (!existsSync(path.join(resolvedData, "PG_VERSION"))) return [];
  const open = new Set<string>(OPEN_DATA_DIR_CHILDREN);
  try {
    return readdirSync(resolvedData)
      .filter((entry) => !open.has(entry))
      .map((entry) => path.join(resolvedData, entry));
  } catch {
    return [];
  }
}

/**
 * The deny list for this process, from its own configuration:
 * - the env file the stack loaded (`ARDURBOT_ENV_FILE`, recorded by loadRootEnv);
 * - the app-managed children of `DATA_DIR` (the bots' own homes under `desktop-computers`
 *   are excluded — denying them would break the computer itself);
 * - when `DATA_DIR` is also the embedded Postgres cluster (a source checkout), every
 *   database file in it — the cluster entries and credentials.json — derived from the
 *   directory, again except the children host work must keep;
 * - extra absolute paths from `ARDURBOT_GUARD_PATHS` (the desktop app lists its secrets.env,
 *   Postgres cluster, compose stack env and host pairing store here);
 * - the loopback ports of `DATABASE_URL` / `REALTIME_DATABASE_URL`, `API_PORT`, `API_URL`,
 *   and `SANDBOX_SUPERVISOR_URL`. A database or API on another host is out of reach of a
 *   loopback deny and is skipped;
 * - the local container-engine sockets (and any loopback engine TCP port) from
 *   containerEngineGuard.
 */
export function guardrailConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): HostGuardrailConfig {
  const paths: string[] = [];
  const envFile = env.ARDURBOT_ENV_FILE?.trim();
  if (envFile && path.isAbsolute(envFile)) paths.push(envFile);
  const dataDir = env.DATA_DIR?.trim() || "./data";
  const resolvedData = path.resolve(cwd, dataDir);
  for (const child of GUARDED_DATA_DIR_CHILDREN) paths.push(path.join(resolvedData, child));
  paths.push(...databaseDataPaths(resolvedData));
  for (const extra of (env.ARDURBOT_GUARD_PATHS ?? "").split(path.delimiter)) {
    const trimmed = extra.trim();
    if (trimmed && path.isAbsolute(trimmed)) paths.push(trimmed);
  }
  const engine = containerEngineGuard(env);
  const ports = [
    loopbackPortOf(env.DATABASE_URL),
    loopbackPortOf(env.REALTIME_DATABASE_URL),
    validPort(env.API_PORT),
    loopbackPortOf(env.API_URL),
    loopbackPortOf(env.SANDBOX_SUPERVISOR_URL),
    ...engine.ports,
  ].filter((port): port is number => port !== undefined);
  return {
    paths: [...new Set(paths)],
    ports: [...new Set(ports)],
    sockets: engine.sockets,
  };
}

/**
 * Seatbelt matches the kernel's resolved path, so each entry contributes its realpath and,
 * when a symlink sits on the way, the spelled-out form too. A missing entry (a secrets file
 * a deployment never created, an engine socket not installed yet) cannot be realpath'd
 * whole, so its nearest existing ancestor is resolved instead and the missing tail
 * re-appended: the path stays denied in the spelling the kernel will use once it exists,
 * not only as written.
 */
export async function resolveGuardrailPaths(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map((entry) => resolveGuardrailPath(entry)));
  return [...new Set(resolved.flat())];
}

async function resolveGuardrailPath(entry: string): Promise<string[]> {
  const real = await realpath(entry).catch(() => undefined);
  if (real) return real !== entry ? [entry, real] : [entry];
  const ancestor = await realpathAncestor(entry);
  return ancestor && ancestor !== entry ? [entry, ancestor] : [entry];
}

/** The entry re-spelled through the realpath of its nearest existing ancestor. */
async function realpathAncestor(entry: string): Promise<string | undefined> {
  const missing: string[] = [];
  let candidate = entry;
  for (;;) {
    missing.unshift(path.basename(candidate));
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    const real = await realpath(parent).catch(() => undefined);
    if (real) return path.join(real, ...missing);
    candidate = parent;
  }
}

/** Synchronous twin of resolveGuardrailPaths for spawn sites that cannot await. */
export function resolveGuardrailPathsSync(paths: string[]): string[] {
  const resolved = paths.map((entry) => {
    let real: string | undefined;
    try {
      real = realpathSync(entry);
    } catch {
      real = undefined;
    }
    if (real) return real !== entry ? [entry, real] : [entry];
    const ancestor = realpathAncestorSync(entry);
    return ancestor && ancestor !== entry ? [entry, ancestor] : [entry];
  });
  return [...new Set(resolved.flat())];
}

function realpathAncestorSync(entry: string): string | undefined {
  const missing: string[] = [];
  let candidate = entry;
  for (;;) {
    missing.unshift(path.basename(candidate));
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    let real: string | undefined;
    try {
      real = realpathSync(parent);
    } catch {
      real = undefined;
    }
    if (real) return path.join(real, ...missing);
    candidate = parent;
  }
}

function quotePath(value: string): string {
  if (!path.isAbsolute(value) || /[\n\r\0]/.test(value))
    throw new Error("Invalid host guardrail path.");
  return JSON.stringify(value);
}

function quotePort(port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("Invalid host guardrail port.");
  // This macOS build's profile parser accepts only `*` or `localhost` as the host in a
  // `remote ip` rule; `localhost` covers both 127.0.0.1 and ::1 (verified on macOS 26).
  return JSON.stringify(`localhost:${port}`);
}

/**
 * One Seatbelt profile for one command: allow the host's normal work, deny exactly the
 * computed paths, loopback ports and engine sockets. Deny rules win over the default allow
 * in SBPL — the carve-out pattern Codex CLI relies on for `.git`/`.codex` inside writable
 * roots. A unix-socket connect is a network operation, not a file one: file denies do not
 * stop it (verified with sandbox-exec probes on macOS 26), so sockets get their own
 * `remote unix-socket` rule with one filter clause per socket — several `literal` values
 * inside a single clause apply only the first. Throws on untrustworthy input; callers must
 * fail the command closed, never skip the wrap.
 */
export function seatbeltProfile(config: HostGuardrailConfig): string {
  const rules = ["(version 1)", "(allow default)"];
  const paths = [...config.paths].sort();
  if (paths.length)
    rules.push(
      `(deny file-read* file-write* ${paths
        .map(quotePath)
        .map((p) => `(subpath ${p})`)
        .join(" ")})`,
    );
  if (config.ports.length)
    rules.push(
      `(deny network-outbound ${[...config.ports]
        .sort((a, b) => a - b)
        .map((port) => `(remote ip ${quotePort(port)})`)
        .join(" ")})`,
    );
  const sockets = [...config.sockets].sort();
  if (sockets.length)
    rules.push(
      `(deny network-outbound ${sockets
        .map(quotePath)
        .map((socket) => `(remote unix-socket (literal ${socket}))`)
        .join(" ")})`,
    );
  return rules.join("\n");
}

export const SEATBELT_BINARY = "/usr/bin/sandbox-exec";

/** The argv that runs `argv` under the deny profile. */
export function seatbeltArgv(argv: string[], profile: string): string[] {
  return [SEATBELT_BINARY, "-p", profile, ...argv];
}

/**
 * Path containment for the in-process file tools, which never leave the worker process and
 * so cannot rely on Seatbelt. Case-insensitive on case-folding platforms (APFS, NTFS).
 */
export function isGuardedPath(
  paths: string[],
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = platform === "darwin" || platform === "win32";
  const target = fold ? candidate.toLowerCase() : candidate;
  return paths.some((entry) => {
    const base = fold ? entry.toLowerCase() : entry;
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
}
