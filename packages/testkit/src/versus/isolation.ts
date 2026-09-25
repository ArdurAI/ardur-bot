import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { contentDigest } from "../scoreboard/manifest.js";
import { requireValue } from "./budget.js";
import { sanitize } from "./provenance.js";

const exec = promisify(execFile);
export interface OwnedDirectory {
  root: string;
  owner: string;
  workspace: string;
  state: string;
}
const ownedDirectories = new Map<string, OwnedDirectory>();
export async function createTrialDirectory(parent: string): Promise<OwnedDirectory> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(path.join(parent, "trial-")));
  const owner = randomUUID();
  await writeFile(path.join(root, ".versus-owner"), owner, { flag: "wx", mode: 0o600 });
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const resource = { root, owner, workspace, state };
  ownedDirectories.set(root, resource);
  return resource;
}
export async function assertOwnedTrial(workspace: string, state: string) {
  const resource = [...ownedDirectories.values()].find(
    (item) => item.workspace === workspace && item.state === state,
  );
  requireValue(
    resource &&
      (await realpath(workspace)) === workspace &&
      (await realpath(state)) === state &&
      (await readFile(path.join(resource.root, ".versus-owner"), "utf8")) === resource.owner,
    "Trial paths require a current invocation-owned directory",
  );
}
/** Cleanup requires the exact newly created directory and its unmodified ownership marker. */
export async function destroyOwnedDirectory(resource: OwnedDirectory) {
  requireValue(
    !(await lstat(resource.root)).isSymbolicLink() &&
      (await realpath(resource.root)) === resource.root,
    "Cleanup root changed",
  );
  requireValue(
    (await readFile(path.join(resource.root, ".versus-owner"), "utf8")) === resource.owner,
    "Cleanup ownership mismatch",
  );
  await rm(resource.root, { recursive: true });
  ownedDirectories.delete(resource.root);
}
export async function safeFile(root: string, relative: string, createParents = false) {
  requireValue(
    relative.length > 0 &&
      !path.isAbsolute(relative) &&
      !relative.includes("\0") &&
      !relative.split(/[\\/]/).some((part) => part === ".." || part === "." || !part),
    "File outside trial authority",
  );
  const base = await realpath(root);
  let current = base;
  const pieces = relative.split("/");
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]!);
    try {
      const stat = await lstat(current);
      requireValue(!stat.isSymbolicLink(), "Symlink outside trial authority");
      if (index < pieces.length - 1)
        requireValue(stat.isDirectory(), "File parent is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (index < pieces.length - 1) {
        requireValue(createParents, "Missing parent");
        await mkdir(current, { mode: 0o700 });
      }
    }
  }
  requireValue(current.startsWith(`${base}${path.sep}`), "File outside trial authority");
  return current;
}

export function minimalEnvironment(state: string, executablePath: string): NodeJS.ProcessEnv {
  return {
    PATH: [path.dirname(executablePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      path.delimiter,
    ),
    HOME: path.join(state, "home"),
    HERMES_HOME: path.join(state, "hermes"),
    XDG_CONFIG_HOME: path.join(state, "config"),
    XDG_CACHE_HOME: path.join(state, "cache"),
    XDG_DATA_HOME: path.join(state, "data"),
    TMPDIR: path.join(state, "tmp"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "UTC",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}
export async function prepareEnvironment(state: string, executable: string) {
  const env = minimalEnvironment(state, executable);
  for (const key of [
    "HOME",
    "HERMES_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TMPDIR",
  ])
    await mkdir(env[key]!, { recursive: true, mode: 0o700 });
  return env;
}

export interface NativePolicy {
  root: string;
  readRoots: string[];
  ports: number[];
  forbiddenRoots: string[];
}
export function nativeProfile(policy: NativePolicy) {
  const quote = (value: string) => {
    requireValue(path.isAbsolute(value) && !/[\n\r\0]/.test(value), "Invalid sandbox path");
    return JSON.stringify(value);
  };
  for (const port of policy.ports)
    requireValue(Number.isInteger(port) && port > 0 && port < 65536, "Invalid sandbox port");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    // The native startup control needs the root directory itself on current macOS.
    // A literal grants no recursive access to its children.
    '(allow file-read* (literal "/"))',
    // Apple's curl initializes LibreSSL before an HTTP connection as well.
    '(allow file-read-data (literal "/private/etc/ssl/openssl.cnf"))',
    ...[
      "/System",
      "/usr/lib",
      "/usr/share",
      "/bin",
      "/usr/bin",
      "/private/var/db/dyld",
      "/dev",
      ...policy.readRoots,
      policy.root,
    ].map((root) => `(allow file-read* (subpath ${quote(root)}))`),
    ...["/bin", "/usr/bin", ...policy.readRoots].map(
      (root) => `(allow process-exec (subpath ${quote(root)}))`,
    ),
    `(allow file-write* (subpath ${quote(policy.root)}) (literal "/dev/null"))`,
    ...policy.ports.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    ...policy.forbiddenRoots.map(
      (root) => `(deny file-read* file-write* (subpath ${quote(root)}))`,
    ),
    // An install source tree may itself contain credentials and contributor metadata.
    '(deny file-read* (regex #"/(auth[.]json|[.]env([.][^/]*)?|tokens|cookies|sessions|histories|caches|contributors|[.]git)(/|$)"))',
  ].join("\n");
}
export interface IsolationResult {
  mechanism: string;
  passed: boolean;
  checks: Record<string, boolean>;
  profileHash: string | null;
  resourceEnforcement: "watchdog-only";
  limits: string[];
  diagnostic?: string;
}
const validProofs = new WeakMap<object, string>();
export interface IsolationProof {
  result: IsolationResult;
  profilePath: string;
  policyHash: string;
}
export function assertIsolation(proof: IsolationProof, policy: NativePolicy) {
  requireValue(
    validProofs.get(proof) === contentDigest(policy) &&
      proof.result.passed &&
      proof.policyHash === contentDigest(policy),
    "Isolation preflight failed or policy changed",
  );
}

/** Filesystem/network canaries cannot authorize a process with unbounded resource exposure. */
export function assertNativeProductIsolation(proof: IsolationProof, policy: NativePolicy) {
  assertIsolation(proof, policy);
  requireValue(
    proof.result.resourceEnforcement !== "watchdog-only",
    "Native product launch requires hard process-tree CPU, memory, pids and aggregate disk enforcement; canaries alone are insufficient",
  );
}

/** Only benign newly created sentinels are used. A passing availability check is insufficient. */
export async function proveNativeIsolation(policy: NativePolicy): Promise<IsolationProof> {
  const checks: Record<string, boolean> = {};
  const result: IsolationResult = {
    mechanism: "macos-sandbox-exec",
    passed: false,
    checks,
    profileHash: null,
    resourceEnforcement: "watchdog-only",
    limits: [
      "Native RSS/CPU/process counts use a sampling watchdog, not kernel resource ceilings; disk and detached-child enforcement are incomplete.",
      "Canaries test the declared process tree and policy; native product acceptance remains separate.",
    ],
  };
  const profilePath = path.join(policy.root, "isolation.sb");
  const proof: IsolationProof = { result, profilePath, policyHash: contentDigest(policy) };
  if (process.platform !== "darwin") {
    result.limits.push(
      "Native macOS isolation unavailable; a separately qualified container/VM lane is required.",
    );
    return proof;
  }
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "versus-canary-")));
  const allowed = createServer((_request, response) => response.end("allowed"));
  const denied = createServer((_request, response) => response.end("forbidden"));
  try {
    await Promise.all([
      new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve)),
    ]);
    const allowedPort = (allowed.address() as AddressInfo).port;
    const deniedPort = (denied.address() as AddressInfo).port;
    await writeFile(path.join(outside, "sentinel"), "outside-canary");
    await writeFile(path.join(outside, "grader"), "synthetic-hidden-grader");
    await writeFile(path.join(policy.root, "input-canary"), "inside-canary");
    await symlink(outside, path.join(policy.root, "escape-canary"));
    // The positive network control adds only a port, never extra protection for sentinels.
    const profile = nativeProfile({
      ...policy,
      ports: [...policy.ports, allowedPort],
    });
    const finalProfile = nativeProfile(policy);
    result.profileHash = contentDigest(finalProfile);
    await writeFile(profilePath, finalProfile, { mode: 0o600 });
    const script = [
      'test "$(/bin/cat "$1/input-canary")" = inside-canary && echo positive-read',
      'echo test > "$1/write-canary" && echo positive-write',
      '! /bin/cat "$2/sentinel" >/dev/null 2>&1 && echo outside-read',
      '! /bin/sh -c \'echo bad > "$1/new-file"\' child "$2" 2>/dev/null && echo outside-write',
      '! /bin/cat "$1/escape-canary/sentinel" >/dev/null 2>&1 && echo symlink-escape',
      '! /bin/sh -c \'/bin/cat "$1/sentinel"\' child "$2" >/dev/null 2>&1 && echo child-escape',
      '! /bin/cat "$2/grader" >/dev/null 2>&1 && echo hidden-grader',
      '/usr/bin/curl --noproxy "*" -fsS --max-time 2 "$3" >/dev/null 2>&1 && echo positive-egress',
      '! /usr/bin/curl --noproxy "*" -fsS --max-time 2 "$4" >/dev/null 2>&1 && echo forbidden-egress',
    ].join("\n");
    const probe = (selectedProfile: string, selectedScript: string) =>
      exec(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          selectedProfile,
          "/bin/sh",
          "-c",
          selectedScript,
          "canary",
          policy.root,
          outside,
          `http://127.0.0.1:${allowedPort}`,
          `http://127.0.0.1:${deniedPort}`,
        ],
        { env: minimalEnvironment(policy.root, "/bin/sh"), timeout: 10000, maxBuffer: 8192 },
      );
    const execution = await probe(profile, script);
    const markers = new Set(execution.stdout.trim().split("\n"));
    for (const name of [
      "positive-read",
      "positive-write",
      "outside-read",
      "outside-write",
      "symlink-escape",
      "child-escape",
      "hidden-grader",
      "positive-egress",
      "forbidden-egress",
    ])
      checks[name] = markers.has(name);
    // Re-run every containment check under the exact launch profile. The temporary
    // positive-control listener must now be unreachable, without sentinel-specific rules.
    const exact = await probe(
      finalProfile,
      script.replace(
        '/usr/bin/curl --noproxy "*" -fsS --max-time 2 "$3" >/dev/null 2>&1 && echo positive-egress',
        '! /usr/bin/curl --noproxy "*" -fsS --max-time 2 "$3" >/dev/null 2>&1 && echo canary-port-revoked',
      ),
    );
    const exactMarkers = new Set(exact.stdout.trim().split("\n"));
    for (const name of Object.keys(checks).filter((name) => name !== "positive-egress"))
      checks[`exact-${name}`] = exactMarkers.has(name);
    checks["exact-canary-port-revoked"] = exactMarkers.has("canary-port-revoked");
    result.passed = Object.values(checks).every(Boolean);
    if (result.passed) validProofs.set(proof, proof.policyHash);
  } catch (error) {
    checks["sandbox-execution"] = false;
    result.passed = false;
    const failure = error as { stderr?: string; stdout?: string; code?: string; signal?: string };
    result.diagnostic = sanitize(
      JSON.stringify({
        stderr: failure.stderr,
        stdout: failure.stdout,
        code: failure.code,
        signal: failure.signal,
      }).slice(0, 2000),
      [policy.root, outside],
    );
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => allowed.close(() => resolve())),
      new Promise<void>((resolve) => denied.close(() => resolve())),
    ]);
    await rm(outside, { recursive: true });
    for (const name of ["input-canary", "write-canary", "escape-canary"])
      await rm(path.join(policy.root, name), { force: true });
  }
  Object.freeze(result.checks);
  Object.freeze(result.limits);
  Object.freeze(result);
  Object.freeze(proof);
  return proof;
}
