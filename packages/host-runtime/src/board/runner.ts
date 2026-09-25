import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import type { BoardRun, BoardRunResult, BoardWorkspace } from "@ardurbot/contracts/board";
import { BoardError, BoardRunSchema } from "@ardurbot/contracts/board";
import { getHostEnvironment, redactHostStatus, resolveHostBinary } from "../host-environment.js";
import { validateBoardArgv } from "./argv.js";

export const BOARD_INIT_FLAGS = ["--non-interactive", "--skip-agents", "--skip-hooks", "--stealth"];
const queues = new Map<string, { tail: Promise<unknown>; count: number }>();
const fail = (code: BoardError["problem"]["code"], message: string): never => {
  throw new BoardError({ code, message });
};
/** Reads also open the embedded database. Serialize them with writes to avoid lock churn. */
export async function serializeBoard<T>(
  key: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const queue = queues.get(key) ?? { tail: Promise.resolve(), count: 0 };
  if (queue.count >= 32) return fail("busy", "Another write is in progress");
  queue.count++;
  const result = queue.tail.then(() => {
    signal?.throwIfAborted();
    return work();
  });
  queue.tail = result.catch(() => undefined);
  queues.set(key, queue);
  void result
    .finally(() => {
      if (--queue.count === 0) queues.delete(key);
    })
    .catch(() => undefined);
  if (!signal) return result;
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(new BoardError({ code: "timeout", message: "The board command timed out." }));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export function supportedBeadsVersion(output: string) {
  const version = /(?:bd version\s+)?(\d+\.\d+\.\d+)/.exec(output)?.[1];
  if (!version || !/^1\.2\./.test(version))
    return fail(
      "unsupported_version",
      `Beads version ${version ?? "unknown"} is not supported yet`,
    );
  return version;
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function hasBoard(beads: string) {
  return (
    (await exists(path.join(beads, "metadata.json"))) ||
    (await exists(path.join(beads, "config.yaml")))
  );
}
async function hasBoardData(beads: string) {
  return (
    (await exists(path.join(beads, "beads.db"))) || (await exists(path.join(beads, "embeddeddolt")))
  );
}
function boardFailureDetail(stderr: string) {
  let detail = "";
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^warning:/i.test(trimmed) || /^error:$/i.test(trimmed)) continue;
    detail = trimmed;
  }
  return redactHostStatus(detail);
}
async function noLinks(root: string, budget = { remaining: 20_000 }) {
  if (--budget.remaining < 0)
    return fail("forbidden", "This board is too large to inspect safely.");
  const info = await lstat(root);
  if (info.isSymbolicLink()) return fail("forbidden", "Board files must stay in this folder.");
  if (info.isDirectory())
    for (const entry of await readdir(root)) await noLinks(path.join(root, entry), budget);
}
async function privateDirectory(root: string, ...parts: string[]) {
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    if (await exists(directory)) {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        return fail("forbidden", "Board files must stay in this folder.");
    } else
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    if ((await realpath(directory)) !== directory)
      return fail("forbidden", "Board files must stay in this folder.");
  }
  return directory;
}
async function confinedDatabase(beads: string) {
  await noLinks(beads);
  // Prefix routes can open another database even with BEADS_DIR and BD_DB fixed.
  for (const name of ["redirect", "routes.jsonl"])
    if (await exists(path.join(beads, name)))
      return fail("forbidden", "Board files must stay in this folder.");
  for (const name of ["metadata.json", "config.json"]) {
    if (!(await exists(path.join(beads, name)))) continue;
    const metadata: Record<string, unknown> = JSON.parse(
      await readFile(path.join(beads, name), "utf8"),
    );
    if (metadata.dolt_mode && metadata.dolt_mode !== "embedded")
      return fail("forbidden", "This board needs an embedded Dolt database.");
    for (const customPath of [metadata.dolt_data_dir, metadata.database]) {
      if (typeof customPath !== "string") continue;
      const relative = path.relative(beads, path.resolve(beads, customPath));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return fail("forbidden", "Board files must stay in this folder.");
    }
    if (
      metadata.dolt_database !== undefined &&
      (typeof metadata.dolt_database !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(metadata.dolt_database))
    )
      return fail("forbidden", "Board files must stay in this folder.");
  }
}
export class BoardRunner {
  constructor(
    private readonly options: {
      root: string;
      hostRoots: string[];
      timeoutMs?: number;
      environment?: () => Promise<NodeJS.ProcessEnv>;
    },
  ) {}
  private async folder(request: BoardRun, spaceId: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(spaceId))
      return fail("forbidden", "This board is not available in this space.");
    if (request.workspace?.kind === "folder") {
      const requested = request.workspace.path;
      const found = await Promise.allSettled(this.options.hostRoots.map((p) => realpath(p)));
      const roots = found.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const resolved = await realpath(requested);
      if (!roots.includes(resolved) || (await lstat(requested)).isSymbolicLink())
        return fail("forbidden", "This folder is not registered on this computer.");
      return resolved;
    }
    if (request.workspace?.kind !== "space") return fail("forbidden", "Choose a board.");
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.options.root);
    return privateDirectory(root, "board", spaceId);
  }
  private async environment(directory: string) {
    const inherited = this.options.environment
      ? await this.options.environment()
      : (await getHostEnvironment()).env;
    // These fixed child-only values prevent Git identity discovery, init commits, metrics and remote sync.
    const env = Object.fromEntries(
      Object.entries(inherited).filter(([key]) => !/^(BD_|BEADS_|GIT_|DOLT_)/.test(key)),
    );
    return {
      ...env,
      BEADS_DIR: path.join(directory, ".beads"),
      BD_DB: path.join(directory, ".beads", "beads.db"),
      BD_DOLT_SHARED_SERVER: "false",
      BD_NO_HOOKS: "true",
      BD_DISABLE_METRICS: "1",
      BD_DISABLE_EVENT_FLUSH: "1",
      BEADS_NO_GIT_OPS: "true",
      BEADS_DOLT_LOCAL_ONLY: "true",
      GIT_DIR: devNull,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }
  private execute(
    binary: string,
    argv: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) {
    return new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        argv,
        {
          cwd,
          env,
          shell: false,
          timeout: this.options.timeoutMs ?? 30_000,
          maxBuffer: 2 * 1024 * 1024,
          signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const diagnostic = boardFailureDetail(stderr);
          const code =
            error.killed || error.name === "AbortError"
              ? "timeout"
              : /lock|another process|in use|busy/i.test(stderr)
                ? "busy"
                : /dolt.*(?:not found|not installed|executable)/i.test(stderr)
                  ? "dolt_missing"
                  : "command_failed";
          const message =
            code === "timeout"
              ? "The board command timed out."
              : code === "busy"
                ? "Another write is in progress"
                : code === "dolt_missing"
                  ? "Dolt is not installed on this computer."
                  : diagnostic
                    ? `Beads reported: ${diagnostic.replace(/[.!?]$/, "")}.`
                    : "Beads could not finish this change. Check the item and its dependencies.";
          reject(new BoardError({ code, message }));
        },
      );
    });
  }
  async run(input: BoardRun, spaceId: string, signal?: AbortSignal): Promise<BoardRunResult> {
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    ]);
    try {
      const request = BoardRunSchema.parse(input);
      signal?.throwIfAborted();
      if (request.action === "command") validateBoardArgv(request.argv);
      else if (request.argv.length) return fail("forbidden", "This board command is not allowed.");
      const directory = await this.folder(
        request.action === "discover" ? { ...request, workspace: { kind: "space" } } : request,
        spaceId,
      );
      const env = await this.environment(directory);
      const binary = await resolveHostBinary("bd", env);
      if (!binary) return fail("not_installed", "Beads is not installed on this computer");
      const version = supportedBeadsVersion(
        await this.execute(
          binary,
          ["--version", "--json", "--actor", request.actor],
          directory,
          env,
          signal,
        ),
      );
      if (request.action === "discover") {
        const found = await Promise.allSettled(this.options.hostRoots.map((p) => realpath(p)));
        const roots = [
          ...new Set([
            directory,
            ...found.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
          ]),
        ];
        const workspaces: BoardWorkspace[] = [];
        for (const [index, root] of roots.entries()) {
          signal.throwIfAborted();
          const initialized = await hasBoard(path.join(root, ".beads"));
          let prefix = request.prefix ?? "board";
          if (initialized) {
            // Discovery never follows a redirect or opens a server-backed database.
            const stored = await serializeBoard(
              root,
              async () => {
                await confinedDatabase(path.join(root, ".beads"));
                const text = await this.execute(
                  binary,
                  [
                    "--json",
                    "--actor",
                    request.actor,
                    "--sandbox",
                    "--dolt-auto-commit",
                    "off",
                    "-C",
                    root,
                    "config",
                    "get",
                    "issue_prefix",
                  ],
                  root,
                  await this.environment(root),
                  signal,
                );
                return JSON.parse(text) as { value?: unknown };
              },
              signal,
            ).catch(() => null);
            if (typeof stored?.value === "string") prefix = stored.value;
          }
          workspaces.push({
            isDefault: false,
            allowAllBots: true,
            allowedBotIds: [],
            id: createHash("sha256").update(spaceId).update("\0").update(root).digest("hex"),
            kind: index === 0 ? "space" : "folder",
            path: root,
            prefix,
            name: index === 0 ? "Board" : path.basename(root),
            enabled: true,
            initialized,
          });
        }
        return {
          ok: true,
          version,
          doltInstalled: Boolean(await resolveHostBinary("dolt", env)),
          workspaces,
        };
      }
      return await serializeBoard(
        directory,
        async () => {
          signal?.throwIfAborted();
          const beads = path.join(directory, ".beads");
          const beadsExists = await exists(beads);
          const initialized = await hasBoard(beads);
          if (beadsExists) await confinedDatabase(beads);
          const global = [
            "--json",
            "--actor",
            request.actor,
            "--sandbox",
            "--dolt-auto-commit",
            "off",
          ];
          if (request.action === "init") {
            if (initialized && request.workspace?.kind === "space")
              return { ok: true, version, path: directory };
            if (initialized) return fail("command_failed", "This folder already has a board.");
            if (await hasBoardData(beads))
              return fail(
                "command_failed",
                "This folder has board data without its settings files. Move its .beads folder aside, then start the board.",
              );
            if (!request.prefix) return fail("forbidden", "Choose a board prefix.");
            await privateDirectory(directory, ".beads");
            await chmod(beads, 0o700);
            // -C refuses uninitialized folders in 1.2.2; init uses execFile's confined cwd instead.
            await this.execute(
              binary,
              [...global, "init", ...BOARD_INIT_FLAGS, "--prefix", request.prefix],
              directory,
              env,
              signal,
            );
            if (!(await exists(path.join(beads, "metadata.json"))))
              return fail(
                "command_failed",
                "Beads reported success but did not create this board.",
              );
            await this.execute(
              binary,
              [
                ...global,
                "-C",
                directory,
                "config",
                "set",
                "types.custom",
                "spike,story,milestone",
              ],
              directory,
              env,
              signal,
            );
            return { ok: true, version, path: directory };
          }
          if (!initialized) return fail("no_board", "This folder has no board");
          const argv = request.action === "export" ? ["export"] : request.argv;
          const stdout = await this.execute(
            binary,
            [...global, "-C", directory, ...argv],
            directory,
            env,
            signal,
          );
          if (request.action === "export") {
            for (const line of stdout.split("\n").filter(Boolean)) JSON.parse(line);
            const exportDir = await privateDirectory(
              await realpath(this.options.root),
              "board-exports",
              spaceId,
            );
            const file = path.join(exportDir, `${randomUUID()}.jsonl`);
            await writeFile(file, stdout, { flag: "wx", mode: 0o600 });
            return { ok: true, path: file };
          }
          return { ok: true, stdout };
        },
        signal,
      );
    } catch (error) {
      return {
        ok: false,
        problem:
          error instanceof BoardError
            ? error.problem
            : signal.aborted
              ? { code: "timeout", message: "The board command timed out." }
              : {
                  code: "command_failed",
                  message:
                    "The board is unavailable. Check this computer and its registered folders.",
                },
      };
    }
  }
}
