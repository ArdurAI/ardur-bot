import { realpathSync } from "node:fs";
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
 *   ordinary work is untouched while the listed files stay unreadable and the listed
 *   loopback ports stay unreachable. The same deny-over-allow carve-out is how the Codex
 *   CLI keeps writable roots read-only under `.git` (openai/codex seatbelt_base_policy.sbpl);
 *   Claude Code's sandbox runtime likewise generates a Seatbelt profile string and executes
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

/**
 * The deny list for this process, from its own configuration:
 * - the env file the stack loaded (`ARDURBOT_ENV_FILE`, recorded by loadRootEnv);
 * - the app-managed children of `DATA_DIR` (the bots' own homes under `desktop-computers`
 *   are excluded — denying them would break the computer itself);
 * - extra absolute paths from `ARDURBOT_GUARD_PATHS` (the desktop app lists its secrets.env,
 *   Postgres cluster, compose stack env and host pairing store here);
 * - the loopback ports of `DATABASE_URL` / `REALTIME_DATABASE_URL`, `API_PORT`, `API_URL`,
 *   and `SANDBOX_SUPERVISOR_URL`. A database or API on another host is out of reach of a
 *   loopback deny and is skipped.
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
  for (const extra of (env.ARDURBOT_GUARD_PATHS ?? "").split(path.delimiter)) {
    const trimmed = extra.trim();
    if (trimmed && path.isAbsolute(trimmed)) paths.push(trimmed);
  }
  const ports = [
    loopbackPortOf(env.DATABASE_URL),
    loopbackPortOf(env.REALTIME_DATABASE_URL),
    validPort(env.API_PORT),
    loopbackPortOf(env.API_URL),
    loopbackPortOf(env.SANDBOX_SUPERVISOR_URL),
  ].filter((port): port is number => port !== undefined);
  return { paths: [...new Set(paths)], ports: [...new Set(ports)] };
}

/**
 * Seatbelt matches the kernel's resolved path, so each entry contributes its realpath and,
 * when a symlink sits on the way, the spelled-out form too. Missing paths (a secrets file a
 * deployment never created) are still denied as written.
 */
export async function resolveGuardrailPaths(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map((entry) => resolveGuardrailPath(entry)));
  return [...new Set(resolved.flat())];
}

async function resolveGuardrailPath(entry: string): Promise<string[]> {
  const real = await realpath(entry).catch(() => undefined);
  return real && real !== entry ? [entry, real] : [entry];
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
    return real && real !== entry ? [entry, real] : [entry];
  });
  return [...new Set(resolved.flat())];
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
 * computed paths and loopback ports. Deny rules win over the default allow in SBPL — the
 * carve-out pattern Codex CLI relies on for `.git`/`.codex` inside writable roots.
 * Throws on untrustworthy input; callers must fail the command closed, never skip the wrap.
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
