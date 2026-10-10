import { describe, expect, it, vi } from "vitest";
import {
  GIT_OBSERVATION_BUDGET_MS,
  GIT_OBSERVATION_MAX_ENTRIES,
  GIT_OBSERVATION_RETURNED_BYTES,
  GIT_OBSERVATION_TEXT_SIDE_BYTES,
  type GitRunner,
  type GitRunResult,
  observeGitChanges,
  parseGitStatus,
} from "./git-observation.js";

const ROOT = "/bots/bot-1";
const HEAD = "a".repeat(40);

type Fake = {
  runner: GitRunner;
  calls: { args: readonly string[]; cwd: string; maxBytes: number; timeoutMs: number }[];
  queue: GitRunResult[];
};

function fakeRunner(): Fake {
  const calls: Fake["calls"] = [];
  const queue: GitRunResult[] = [];
  return {
    calls,
    queue,
    runner: {
      async run(args, options) {
        calls.push({
          args,
          cwd: options.cwd,
          maxBytes: options.maxBytes,
          timeoutMs: options.timeoutMs,
        });
        const next = queue.shift();
        if (!next) throw new Error(`unexpected git invocation: ${args.join(" ")}`);
        return next;
      },
    },
  };
}

/** Queues the standard repository probe answers, then the given command results. */
function repository(fake: Fake, results: GitRunResult[], head = HEAD) {
  fake.queue.push(ok(`${ROOT}/.git\n`)); // rev-parse --absolute-git-dir
  fake.queue.push(ok(`${head}\n`)); // rev-parse --verify HEAD
  fake.queue.push(...results);
}

const ok = (stdout: string): GitRunResult => ({
  stdout: new TextEncoder().encode(stdout),
  code: 0,
});
const fail = (code: number, stderr = ""): GitRunResult => ({
  stdout: new Uint8Array(),
  stderr: new TextEncoder().encode(stderr),
  code,
});

describe("parseGitStatus", () => {
  it("maps porcelain codes to staged, unstaged, untracked and conflict", () => {
    const text =
      "M  staged.md\0 M unstaged.md\0MM both.md\0?? new.md\0UU conflict.md\0!! ignored.md\0";
    expect(parseGitStatus(text)).toEqual([
      { path: "staged.md", staged: true, unstaged: false, untracked: false, conflict: false },
      { path: "unstaged.md", staged: false, unstaged: true, untracked: false, conflict: false },
      { path: "both.md", staged: true, unstaged: true, untracked: false, conflict: false },
      { path: "new.md", staged: false, unstaged: false, untracked: true, conflict: false },
      { path: "conflict.md", staged: true, unstaged: true, untracked: false, conflict: true },
    ]);
  });

  it("drops worktree metadata paths and malformed records", () => {
    const text = "M  .git/hooks/pre-commit\0M \0M  ../escape.md\0M  ok.md\0";
    expect(parseGitStatus(text).map((entry) => entry.path)).toEqual(["ok.md"]);
  });
});

describe("observeGitChanges", () => {
  it.each(["C:\\bots\\bot", "\\\\host\\share\\bot"])(
    "accepts trusted metadata with Windows separators for root %s",
    async (root) => {
      const fake = fakeRunner();
      fake.queue.push(ok(`${HEAD}\n`), ok(" M app.txt\0"));
      const result = await observeGitChanges(fake.runner, { root, gitDir: `${root}\\.git` });
      expect(result).toMatchObject({ kind: "status", entries: [{ path: "app.txt" }] });
      expect(fake.calls).toHaveLength(2);
    },
  );

  it("refuses a trusted metadata override outside the workspace before running Git", async () => {
    const fake = fakeRunner();
    expect(await observeGitChanges(fake.runner, { root: ROOT, gitDir: "/outside/.git" })).toEqual({
      kind: "unavailable",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("runs git with a fixed read-only argument list, never a shell", async () => {
    const fake = fakeRunner();
    repository(fake, [ok(" M terminal.md\0")]);
    const result = await observeGitChanges(fake.runner, { root: ROOT });
    expect(result.kind).toBe("status");
    const { args, cwd, timeoutMs } = fake.calls[2]!;
    expect(args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--ignore-submodules=all",
      "--untracked-files=all",
    ]);
    // Every word is its own array element; nothing is joined into a shell string.
    for (const word of args) expect(word).not.toMatch(/[;&|`$()]/u);
    expect(cwd).toBe(ROOT);
    expect(timeoutMs).toBeLessThanOrEqual(GIT_OBSERVATION_BUDGET_MS);
  });

  it("treats the deadline as one budget for the observation, not per command", async () => {
    // A slow runner burns budget on every call; a fixed virtual clock keeps the
    // arithmetic exact. Each call costs 40ms against a 100ms budget, so the
    // fourth command (the diff) finds nothing left and the observation stops.
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    const slow: GitRunner = {
      async run(args, options) {
        timeouts.push(options.timeoutMs);
        now += 40;
        if (args.includes("--absolute-git-dir")) return ok(`${ROOT}/.git\n`);
        if (args[0] === "rev-parse") return ok(`${HEAD}\n`);
        if (args.includes("status")) return ok(" M app.ts\0");
        return ok("--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n");
      },
    };
    try {
      const result = await observeGitChanges(slow, {
        root: ROOT,
        path: "app.ts",
        deadlineMs: 100,
      });
      expect(result).toEqual({ kind: "unavailable" });
      expect(timeouts).toEqual([100, 60, 20]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stops before the first command when the budget is already spent", async () => {
    const fake = fakeRunner();
    const result = await observeGitChanges(fake.runner, {
      root: ROOT,
      deadlineMs: Date.now() - 1,
    });
    expect(result).toEqual({ kind: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reports the head identity and bounded entries", async () => {
    const fake = fakeRunner();
    repository(fake, [ok(" M one.md\0?? two.md\0")]);
    const result = await observeGitChanges(fake.runner, { root: ROOT });
    expect(result).toEqual({
      kind: "status",
      head: HEAD,
      entries: [
        { path: "one.md", staged: false, unstaged: true, untracked: false, conflict: false },
        { path: "two.md", staged: false, unstaged: false, untracked: true, conflict: false },
      ],
      truncated: false,
    });
  });

  it("marks the listing truncated when entries exceed the cap", async () => {
    const fake = fakeRunner();
    const records = Array.from(
      { length: GIT_OBSERVATION_MAX_ENTRIES + 5 },
      (_, index) => ` M f${index}.md`,
    ).join("\0");
    repository(fake, [ok(`${records}\0`)]);
    const result = await observeGitChanges(fake.runner, { root: ROOT });
    expect(result.kind).toBe("status");
    if (result.kind !== "status") throw new Error("unreachable");
    expect(result.entries).toHaveLength(GIT_OBSERVATION_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it("returns not-repository for a plain folder", async () => {
    const fake = fakeRunner();
    fake.queue.push(
      fail(128, "fatal: not a git repository (or any of the parent directories): .git"),
    );
    const result = await observeGitChanges(fake.runner, { root: ROOT });
    expect(result).toEqual({ kind: "not-repository" });
  });

  it("refuses a repository whose gitdir lives outside the bot root", async () => {
    const fake = fakeRunner();
    fake.queue.push(ok("/elsewhere/.git\n"));
    const result = await observeGitChanges(fake.runner, { root: ROOT });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("refuses when the metadata guard rejects the reported gitdir", async () => {
    const fake = fakeRunner();
    repository(fake, [ok("")]);
    const result = await observeGitChanges(fake.runner, {
      root: ROOT,
      assertSafeMetadata: async () => {
        throw new Error("common directory refused");
      },
    });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("treats a timeout as unavailable without partial content", async () => {
    const fake = fakeRunner();
    repository(fake, [{ stdout: new Uint8Array(), code: 124, timedOut: true }]);
    const result = await observeGitChanges(fake.runner, { root: ROOT });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns a staged diff against the index with HEAD as base", async () => {
    const fake = fakeRunner();
    const patch = [
      "diff --git a/app.ts b/app.ts",
      "index 1111111..2222222 100644",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "",
    ].join("\n");
    repository(fake, [ok("M  app.ts\0"), ok(patch)]);
    const result = await observeGitChanges(fake.runner, { root: ROOT, path: "app.ts" });
    expect(result).toEqual({
      kind: "diff",
      before: "keep\nold",
      after: "keep\nnew",
      binary: false,
      truncated: false,
    });
    expect(fake.calls[3]!.args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--cached",
      "HEAD",
      "--",
      "app.ts",
    ]);
  });

  it("returns an unstaged diff without --cached and without a base on an unborn branch", async () => {
    const fake = fakeRunner();
    repository(
      fake,
      [ok(" M app.ts\0"), ok("--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n")],
      "",
    );
    fake.queue[1] = {
      stdout: new TextEncoder().encode(""),
      stderr: new TextEncoder().encode("fatal: Needed a single revision"),
      code: 128,
    };
    const result = await observeGitChanges(fake.runner, { root: ROOT, path: "app.ts" });
    expect(result.kind).toBe("diff");
    if (result.kind !== "diff") throw new Error("unreachable");
    expect(result.before).toBe("old");
    expect(result.after).toBe("new");
    const args = fake.calls[3]!.args;
    expect(args).not.toContain("--cached");
    expect(args).not.toContain("HEAD");
  });

  it("reads untracked content from the worktree with nothing on the before side", async () => {
    const fake = fakeRunner();
    repository(fake, [ok("?? notes.md\0")]);
    const result = await observeGitChanges(fake.runner, {
      root: ROOT,
      path: "notes.md",
      readWorktreeFile: async (path) => {
        expect(path).toBe("notes.md");
        return new TextEncoder().encode("fresh\n");
      },
    });
    expect(result).toEqual({
      kind: "diff",
      before: null,
      after: "fresh",
      binary: false,
      truncated: false,
    });
  });

  it("flags binary diffs and caps oversized sides", async () => {
    const fake = fakeRunner();
    const huge = `+${"x".repeat(GIT_OBSERVATION_TEXT_SIDE_BYTES + 100)}`;
    repository(fake, [ok(" M big.md\0"), ok(`--- a/big.md\n+++ b/big.md\n@@ -1 +1 @@\n${huge}\n`)]);
    const result = await observeGitChanges(fake.runner, { root: ROOT, path: "big.md" });
    expect(result.kind).toBe("diff");
    if (result.kind !== "diff") throw new Error("unreachable");
    expect(result.binary).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.after!.length).toBe(GIT_OBSERVATION_TEXT_SIDE_BYTES);

    const binary = fakeRunner();
    repository(binary, [
      ok(" M bin.md\0"),
      { stdout: new Uint8Array([0x42, 0x00, 0x43]), code: 0 },
    ]);
    const binaryResult = await observeGitChanges(binary.runner, { root: ROOT, path: "bin.md" });
    expect(binaryResult).toEqual({
      kind: "diff",
      before: "",
      after: "",
      binary: true,
      truncated: false,
    });
  });

  it("keeps the returned content inside the total budget", async () => {
    const fake = fakeRunner();
    const side = "y".repeat(GIT_OBSERVATION_TEXT_SIDE_BYTES + 10);
    const patch = `--- a/m.md\n+++ b/m.md\n@@ -1 +1 @@\n-${side}\n+${side}\n`;
    repository(fake, [ok(" M m.md\0"), ok(patch)]);
    const result = await observeGitChanges(fake.runner, { root: ROOT, path: "m.md" });
    if (result.kind !== "diff") throw new Error("unreachable");
    expect(result.before!.length + result.after!.length).toBeLessThanOrEqual(
      GIT_OBSERVATION_RETURNED_BYTES,
    );
    expect(result.truncated).toBe(true);
  });

  it("refuses metadata and traversal paths outright", async () => {
    const fake = fakeRunner();
    repository(fake, [ok("")]);
    const result = await observeGitChanges(fake.runner, { root: ROOT, path: ".git/config" });
    expect(result).toEqual({ kind: "unavailable" });
    expect(fake.calls).toHaveLength(2); // probe + head only, no diff ran
  });

  it("reports an empty diff for a path missing from the listing", async () => {
    const fake = fakeRunner();
    repository(fake, [ok(" M other.md\0")]);
    const result = await observeGitChanges(fake.runner, { root: ROOT, path: "gone.md" });
    expect(result).toEqual({
      kind: "diff",
      before: "",
      after: "",
      binary: false,
      truncated: false,
    });
  });
});
