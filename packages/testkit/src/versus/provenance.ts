import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentDigest } from "../scoreboard/manifest.js";
import {
  HERMES_RELEASE_REVISION,
  HERMES_RESEARCH_REVISION,
  RESEARCH_BASELINE,
} from "./manifest.js";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
export const bytesHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function git(cwd: string, args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    },
  ).trim();
}
export async function findExecutable(name: string, explicit?: string): Promise<string | null> {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Missing candidate. */
    }
  }
  return null;
}
async function findGitRoot(start: string) {
  let current = start;
  for (let level = 0; level < 6; level++) {
    try {
      await lstat(path.join(current, ".git"));
      return current;
    } catch {
      /* Ancestors contain no state reads. */
    }
    current = path.dirname(current);
  }
  return null;
}
export interface HermesIdentity {
  available: boolean;
  requestedRevision: string;
  releaseRevision: string;
  actualRevision: string | null;
  parentRevision: string | null;
  expectedRevision: string;
  revisionMatches: boolean;
  binaryHash: string | null;
  sourceDirty: boolean | null;
  dirtyStatusHash: string | null;
  sourceHashes: { file: string; sha256: string }[];
  sourceHashCoverage: string;
}
const hermesFiles = [
  "hermes_cli/_parser.py",
  "hermes_cli/oneshot.py",
  "hermes_cli/main.py",
  "hermes_cli/cli_stream_mixin.py",
  "hermes_cli/cli_chat_turn_mixin.py",
  "cli.py",
  "tools/approval.py",
  "hermes_cli/runtime_provider.py",
  "hermes_cli/config_defaults.py",
  "tools/mcp_tool_discovery.py",
];
export async function inspectHermes(
  options: { executable?: string; source?: string; expectedRevision?: string } = {},
) {
  const executable = await findExecutable("hermes", options.executable);
  const source = options.source
    ? await realpath(options.source)
    : executable
      ? await findGitRoot(path.dirname(executable))
      : null;
  const identity: HermesIdentity = {
    available: executable !== null,
    requestedRevision: HERMES_RESEARCH_REVISION,
    releaseRevision: HERMES_RELEASE_REVISION,
    actualRevision: null,
    parentRevision: null,
    expectedRevision: options.expectedRevision ?? HERMES_RESEARCH_REVISION,
    revisionMatches: false,
    binaryHash: executable ? bytesHash(await readFile(executable)) : null,
    sourceDirty: null,
    dirtyStatusHash: null,
    sourceHashes: [],
    sourceHashCoverage: "entrypoints-only-not-complete-installation",
  };
  if (source) {
    try {
      identity.actualRevision = git(source, ["rev-parse", "HEAD"]);
      identity.parentRevision = git(source, ["rev-parse", "HEAD^"]);
      // No diff contents, untracked enumeration, owner config, or session files are read.
      const status = git(source, ["status", "--porcelain", "--untracked-files=no"]);
      identity.sourceDirty = Boolean(status);
      identity.dirtyStatusHash = status ? bytesHash(status) : null;
      for (const file of hermesFiles) {
        try {
          const sourceFile = path.join(source, file);
          const relative = path.relative(source, await realpath(sourceFile));
          if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          identity.sourceHashes.push({
            file,
            sha256: bytesHash(await readFile(sourceFile)),
          });
        } catch {
          /* Missing entrypoint is visible through coverage. */
        }
      }
    } catch {
      identity.sourceDirty = null;
    }
  }
  identity.revisionMatches = identity.actualRevision === identity.expectedRevision;
  return { identity, executable, source };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(target)));
    else if (entry.isFile() && /\.(ts|json|md)$/.test(entry.name)) found.push(target);
  }
  return found;
}
export async function inspectBuild(root = repositoryRoot) {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const parentCommit = git(root, ["rev-parse", "HEAD^"]);
  const fixedReleaseCommit = git(root, ["rev-parse", `${RESEARCH_BASELINE}^{commit}`]);
  const sourceRoots = [
    "packages/testkit/src",
    "packages/adapters/src",
    "packages/adapter-kit/src",
    "packages/auth/src",
    "packages/contracts/src",
    "packages/core/src",
    "packages/db/src",
    "packages/logging/src",
    "packages/host-runtime/src",
    "packages/memory/src",
    "apps/api/src",
  ];
  const tracked = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...sourceRoots,
  ])
    .split("\n")
    .filter((file) => /\.(ts|json)$/.test(file));
  const files = [
    ...new Set([
      ...tracked,
      ...(await sourceFiles(path.join(root, "packages/testkit/src/versus"))).map((file) =>
        path.relative(root, file),
      ),
    ]),
  ].sort();
  const inventory: { file: string; sha256: string | null }[] = [];
  // Bound open files while avoiding thousands of serial filesystem round trips.
  for (let offset = 0; offset < files.length; offset += 32)
    inventory.push(
      ...(await Promise.all(
        files.slice(offset, offset + 32).map(async (file) => {
          try {
            return { file, sha256: bytesHash(await readFile(path.join(root, file))) };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return { file, sha256: null };
          }
        }),
      )),
    );
  const lock = bytesHash(await readFile(path.join(root, "pnpm-lock.yaml")));
  const status = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...files,
    "pnpm-lock.yaml",
    "packages/testkit/package.json",
  ]);
  const diff = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    "--",
    ...files,
    "pnpm-lock.yaml",
    "packages/testkit/package.json",
  ]);
  const buildArtifact = {
    kind: "executed-source-inventory",
    commit,
    parentCommit,
    fixedReleaseCommit,
    inventory,
    dependencyLock: lock,
  };
  return {
    build: {
      commit,
      parentCommit,
      fixedReleaseCommit,
      dirty: Boolean(status || diff),
      diffDigest: status || diff ? contentDigest({ status, diff, inventory }) : null,
      artifactHash: contentDigest(buildArtifact),
    },
    buildArtifact,
    dependencyLock: lock,
    graderHash: contentDigest(
      inventory.filter(
        (entry) =>
          entry.file.includes("/scoreboard/graders/") ||
          entry.file.endsWith("/scoreboard/tasks/reference.ts"),
      ),
    ),
    environment: {
      platform: platform(),
      arch: arch(),
      osVersion: release(),
      hardwareClass: `${cpus()[0]?.model ?? "unknown"}-${cpus().length}-cpu-${totalmem()}-bytes`
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .slice(0, 96),
      runtimeVersions: [{ id: "node", version: process.version }],
    },
  };
}

/** Public evidence is path-free. Keep actual launch arguments private to the process supervisor. */
export function sanitize(value: string, replacements: readonly string[] = []) {
  let clean = value;
  for (const replacement of [...replacements].filter(Boolean).sort((a, b) => b.length - a.length))
    clean = clean.replaceAll(replacement, "<isolated-resource>");
  return clean
    .replace(/(?:\/Users\/|\/home\/)[^\s"'<>]+/g, "<private-path>")
    .replace(/(?:\/private)?\/var\/folders\/[^\s"'<>]+/g, "<temporary-path>")
    .replace(
      /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi,
      "<redacted-address>",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer <redacted>")
    .replace(/cap_[a-f0-9]{48}/g, "<trial-capability>");
}
