import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardError } from "@ardurbot/contracts/board";
import { afterEach, expect, it, vi } from "vitest";
import { validateBoardArgv } from "./argv.js";
import { BoardRunner, serializeBoard, supportedBeadsVersion } from "./runner.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
async function fixture(env: NodeJS.ProcessEnv = {}, timeoutMs?: number) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "board-runner-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  for (const file of ["bd", "responses.json"])
    await copyFile(
      new URL(`../../../adapters/src/board/fixtures/${file}`, import.meta.url),
      path.join(bin, file),
    );
  await chmod(path.join(bin, "bd"), 0o755);
  const log = path.join(root, "calls.jsonl");
  const runner = new BoardRunner({
    root,
    hostRoots: [root],
    timeoutMs,
    environment: async () => ({
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
      BOARD_FIXTURE_LOG: log,
      ...env,
    }),
  });
  const workspace = { path: path.join(root, "board", "space") };
  await mkdir(path.join(workspace.path, ".beads"), { recursive: true });
  await writeFile(path.join(workspace.path, ".beads", "metadata.json"), "{}");
  const command = async (argv: string[]) => {
    const result = await runner.run(
      { action: "command", actor: "Owner", workspace: { kind: "space" }, argv },
      "space",
    );
    if (!result.ok) throw new BoardError(result.problem);
    return result;
  };
  return {
    root,
    workspace,
    runner,
    command,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; argv: string[] }),
  };
}
it("refuses executable, workspace and file-output flags even on an otherwise allowed command", () => {
  for (const argv of [
    ["sh", "-c", "echo unsafe"],
    ["list", "-C", "/outside"],
    ["show", "--db", "/outside", "board-a"],
    ["create", "--body-file", "/outside"],
    ["export", "--output", "/outside"],
    ["update", "board-a", "--metadata", "@file"],
    ["delete", "board-a"],
    ["close"],
    ["graph"],
  ])
    expect(() => validateBoardArgv(argv)).toThrow();
  expect(validateBoardArgv(["create", "--title", "; $(echo literal)"])).toEqual({ write: true });
  expect(() =>
    validateBoardArgv(["update", "board-a", "--set-metadata", "ardur_run_id=run;touch"]),
  ).toThrow();
  expect(validateBoardArgv(["update", "board-a", "--set-metadata", "ardur_run_id=run-1"])).toEqual({
    write: true,
  });
  expect(
    validateBoardArgv(["update", "board-a", "--set-metadata", "ardur_filed_by=Builder"]),
  ).toEqual({ write: true });
});
it("serializes all workspace operations including concurrent writes", async () => {
  const f = await fixture({ BOARD_FIXTURE_DELAY: "20" });
  await Promise.all([
    f.command(["comments", "add", "--", "board-a", "one"]),
    f.command(["comments", "add", "--", "board-a", "two"]),
    f.command(["ready"]),
  ]);
  expect((await f.calls()).map((entry) => entry.event)).toEqual([
    "start",
    "end",
    "start",
    "end",
    "start",
    "end",
  ]);
  for (const call of await f.calls()) {
    expect(call.argv).toContain("--json");
    expect(call.argv).toContain("--sandbox");
    expect(call.argv).toContain("--actor");
    expect(call.argv).toContain("-C");
  }
});
it.each([
  ["show", "other-item"],
  ["update", "other-item", "--title", "Changed"],
])("refuses prefix routing before executing %s", async (...argv) => {
  const f = await fixture();
  await writeFile(
    path.join(f.workspace.path, ".beads", "routes.jsonl"),
    `${JSON.stringify({ prefix: "other-", path: "../outside" })}\n`,
  );
  await expect(f.command(argv)).rejects.toMatchObject({ problem: { code: "forbidden" } });
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
it("returns structured missing-binary, unsupported-version, timeout and external-lock problems", async () => {
  expect(supportedBeadsVersion("bd version 1.2.2")).toBe("1.2.2");
  for (const version of ["0.59.0", "1.1.9", "2.0.0", "unknown"])
    expect(() => supportedBeadsVersion(version)).toThrow("not supported yet");
  const missing = await fixture({ PATH: "" });
  await expect(missing.command(["ready"])).rejects.toMatchObject({
    problem: { code: "not_installed", message: "Beads is not installed on this computer" },
  });
  const old = await fixture({ BOARD_FIXTURE_VERSION: "bd version 0.59.0" });
  await expect(old.command(["ready"])).rejects.toMatchObject({
    problem: { code: "unsupported_version" },
  });
  const timeout = await fixture({ BOARD_FIXTURE_DELAY: "500" }, 150);
  await expect(timeout.command(["ready"])).rejects.toMatchObject({ problem: { code: "timeout" } });
  const busy = await fixture({ BOARD_FIXTURE_BUSY: "1" });
  await expect(busy.command(["ready"])).rejects.toMatchObject({
    problem: { code: "busy", message: "Another write is in progress" },
  });
});
it("confines registered roots, rejects symlinks and does not discover a parent board", async () => {
  const f = await fixture();
  const request = {
    action: "command" as const,
    actor: "Owner",
    argv: ["list", "--all"],
    workspace: { kind: "folder" as const, path: path.dirname(f.root) },
  };
  expect(await f.runner.run(request, "space")).toMatchObject({
    ok: false,
    problem: { code: "forbidden" },
  });
  expect(
    await f.runner.run({ ...request, workspace: { kind: "folder", path: f.root } }, "space"),
  ).toMatchObject({ ok: false, problem: { code: "no_board" } });
  const beads = path.join(f.workspace.path, ".beads");
  await rm(beads, { recursive: true });
  await symlink(f.root, beads);
  await expect(f.command(["ready"])).rejects.toMatchObject({ problem: { code: "forbidden" } });
  await rm(beads);
  await mkdir(beads);
  await symlink(f.root, path.join(beads, "embeddeddolt"));
  await expect(f.command(["ready"])).rejects.toMatchObject({ problem: { code: "forbidden" } });
});
it("initializes only an explicit folder with skip flags and no -C before the board exists", async () => {
  const f = await fixture();
  const result = await f.runner.run(
    {
      action: "init",
      argv: [],
      actor: "Owner",
      prefix: "board",
      workspace: { kind: "folder", path: f.root },
    },
    "space",
  );
  expect(result.ok).toBe(true);
  const init = (await f.calls()).find((call) => call.argv.includes("init"))!.argv;
  expect(init).toEqual(
    expect.arrayContaining([
      "--non-interactive",
      "--skip-agents",
      "--skip-hooks",
      "--stealth",
      "--prefix",
      "board",
    ]),
  );
  expect(init).not.toContain("-C");
  expect(init).not.toContain("--remote");
});
it("creates the space board marker before init so an ancestor board cannot capture it", async () => {
  const f = await fixture();
  await rm(path.join(f.workspace.path, ".beads"), { recursive: true });
  await mkdir(path.join(f.root, ".beads"));
  await writeFile(path.join(f.root, ".beads", ".local_version"), "1.2.2");
  const result = await f.runner.run(
    {
      action: "init",
      argv: [],
      actor: "Owner",
      prefix: "board",
      workspace: { kind: "space" },
    },
    "space",
  );
  expect(result.ok).toBe(true);
  expect(
    JSON.parse(await readFile(path.join(f.workspace.path, ".beads", "metadata.json"), "utf8")),
  ).toEqual({});
  await expect(readFile(path.join(f.root, ".beads", "metadata.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("initializes a folder whose .beads directory has no metadata or config", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, ".beads", ".local_version"), "1.2.2").catch(async () => {
    await mkdir(path.join(f.root, ".beads"));
    await writeFile(path.join(f.root, ".beads", ".local_version"), "1.2.2");
  });
  const result = await f.runner.run(
    {
      action: "init",
      argv: [],
      actor: "Owner",
      prefix: "board",
      workspace: { kind: "folder", path: f.root },
    },
    "space",
  );
  expect(result.ok).toBe(true);
  expect(await readFile(path.join(f.root, ".beads", "metadata.json"), "utf8")).toBe("{}");
});
async function failedInit(stderr: string) {
  const f = await fixture({ BOARD_FIXTURE_INIT_STDERR: stderr });
  await rm(path.join(f.workspace.path, ".beads"), { recursive: true });
  return f.runner.run(
    {
      action: "init",
      argv: [],
      actor: "Owner",
      prefix: "board",
      workspace: { kind: "space" },
    },
    "space",
  );
}
it("redacts the Beads error line when init fails", async () => {
  const result = await failedInit(
    "warning: beads.role not configured (GH#2950).\nInitialization failed for person@example.test token=fixture-secret",
  );
  expect(result).toMatchObject({
    ok: false,
    problem: {
      code: "command_failed",
      message: "Beads reported: Initialization failed for [email] [redacted].",
    },
  });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});
it.each([
  [
    "show does-not-exist",
    [
      "warning: beads.role not configured (GH#2950).",
      "  Fix: git config beads.role maintainer",
      "  Or:  git config beads.role contributor",
      'Error fetching does-not-exist: no issue found matching "does-not-exist"',
    ].join("\n"),
    'Beads reported: Error fetching does-not-exist: no issue found matching "does-not-exist".',
  ],
  [
    "repository id warning",
    [
      "Warning: failed to update git exclude: not a git repository",
      "Warning: could not compute repository ID: not a git repository",
      "Warning: could not compute clone ID: not a git repository: not a git repository: exit status 128",
      "Error: --from-jsonl specified but /fixture/board/.beads/issues.jsonl does not exist",
    ].join("\n"),
    "Beads reported: Error: --from-jsonl specified but /fixture/board/.beads/issues.jsonl does not exist.",
  ],
  [
    "bare error line",
    "Error:\ndatabase not found: board",
    "Beads reported: database not found: board.",
  ],
])("reports the Beads error from %s stderr", async (_shape, stderr, message) => {
  expect(await failedInit(stderr)).toMatchObject({
    ok: false,
    problem: { code: "command_failed", message },
  });
});
it("keeps the generic sentence when stderr has only warnings", async () => {
  expect(
    await failedInit(
      "warning: beads.role not configured (GH#2950).\nWarning: could not compute repository ID: not a git repository\n",
    ),
  ).toMatchObject({
    ok: false,
    problem: {
      code: "command_failed",
      message: "Beads could not finish this change. Check the item and its dependencies.",
    },
  });
});
it.each(["beads.db", "embeddeddolt"] as const)(
  "refuses %s without settings and does not report it as initialized",
  async (entry) => {
    const f = await fixture();
    const beads = path.join(f.root, ".beads");
    await mkdir(beads);
    if (entry === "beads.db") await writeFile(path.join(beads, entry), "");
    else await mkdir(path.join(beads, entry));
    const discovered = await f.runner.run(
      { action: "discover", argv: [], actor: "Owner" },
      "space",
    );
    expect(discovered).toMatchObject({
      ok: true,
      workspaces: expect.arrayContaining([
        expect.objectContaining({ path: f.root, kind: "folder", initialized: false }),
      ]),
    });
    expect(
      await f.runner.run(
        {
          action: "init",
          argv: [],
          actor: "Owner",
          prefix: "board",
          workspace: { kind: "folder", path: f.root },
        },
        "space",
      ),
    ).toMatchObject({
      ok: false,
      problem: {
        code: "command_failed",
        message:
          "This folder has board data without its settings files. Move its .beads folder aside, then start the board.",
      },
    });
    await expect(readFile(path.join(beads, "metadata.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(path.join(beads, entry))).isDirectory()).toBe(entry === "embeddeddolt");
  },
);
it("rejects an init that exits successfully without creating metadata", async () => {
  const f = await fixture({ BOARD_FIXTURE_INIT_EMPTY: "1" });
  await rm(path.join(f.workspace.path, ".beads"), { recursive: true });
  expect(
    await f.runner.run(
      {
        action: "init",
        argv: [],
        actor: "Owner",
        prefix: "board",
        workspace: { kind: "space" },
      },
      "space",
    ),
  ).toMatchObject({
    ok: false,
    problem: {
      code: "command_failed",
      message: "Beads reported success but did not create this board.",
    },
  });
});

it("expires queued work without executing it and preserves the queue for the next caller", async () => {
  let release: () => void = () => undefined;
  const waiting = serializeBoard(
    "deadline",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const work = vi.fn();
  const controller = new AbortController();
  const pending = serializeBoard("deadline", work, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ problem: { code: "timeout" } });
  release();
  await waiting;
  await serializeBoard("deadline", async () => undefined);
  expect(work).not.toHaveBeenCalled();
});
it("rejects database redirects and parent-directory symlinks before creating children", async () => {
  const f = await fixture();
  for (const metadata of [
    { dolt_data_dir: f.root },
    { database: f.root, dolt_data_dir: "embeddeddolt" },
    { database: "../../outside" },
    { dolt_database: "../../outside" },
    { dolt_database: "/outside" },
  ]) {
    await writeFile(
      path.join(f.workspace.path, ".beads", "metadata.json"),
      JSON.stringify(metadata),
    );
    await expect(f.command(["ready"])).rejects.toMatchObject({ problem: { code: "forbidden" } });
  }
  await rm(path.join(f.root, "board"), { recursive: true });
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.root, "board"));
  await expect(f.command(["ready"])).rejects.toMatchObject({ problem: { code: "forbidden" } });
  await expect(readFile(path.join(outside, "space"))).rejects.toMatchObject({ code: "ENOENT" });
});
