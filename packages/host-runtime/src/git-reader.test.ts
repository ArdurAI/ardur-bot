import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { assertSafeGitMetadata, createGitRunner } from "./git-reader.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-reader-")));
  roots.push(root);
  const provider = new DesktopSandboxProvider({ root });
  const computer = await provider.provision({ botId: "bot", homePath: "ignored" }, context);
  const home = computer.providerRef!;
  const git = (args: string[], cwd = home) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
  return { root, provider, computer, home, git };
}

async function observe(
  provider: DesktopSandboxProvider,
  computer: { id: string; botId: string; kind: string; providerRef?: string },
  request: { path?: string } = {},
) {
  return provider.gitChanges(computer as never, request, context);
}

it("shows staged, unstaged and untracked worktree changes without a model run", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "staged.md"), "one\n");
  git(["add", "staged.md"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "staged.md"), "two\n");
  git(["add", "staged.md"]);
  await writeFile(path.join(home, "staged.md"), "three\n");
  await writeFile(path.join(home, "untracked.md"), "new\n");

  const result = await observe(provider, computer);
  expect(result.kind).toBe("status");
  if (result.kind !== "status") throw new Error("unreachable");
  expect(result.head).toMatch(/^[0-9a-f]{40}$/u);
  expect(result.entries).toEqual([
    { path: "staged.md", staged: true, unstaged: true, untracked: false, conflict: false },
    { path: "untracked.md", staged: false, unstaged: false, untracked: true, conflict: false },
  ]);
});

it("returns the staged diff with HEAD as base and the untracked file as after only", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "app.ts"), "old\n");
  git(["add", "app.ts"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "app.ts"), "new\n");
  git(["add", "app.ts"]);

  const staged = await observe(provider, computer, { path: "app.ts" });
  expect(staged).toEqual({
    kind: "diff",
    before: "old",
    after: "new",
    binary: false,
    truncated: false,
  });

  await writeFile(path.join(home, "notes.md"), "fresh\n");
  const untracked = await observe(provider, computer, { path: "notes.md" });
  expect(untracked).toEqual({
    kind: "diff",
    before: null,
    after: "fresh",
    binary: false,
    truncated: false,
  });
});

it("reports a plain folder as not a repository", async () => {
  const { provider, computer } = await fixture();
  const result = await observe(provider, computer);
  expect(result).toEqual({ kind: "not-repository" });
});

it("refuses a repository discovered above the bot folder", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"], path.dirname(home));
  const result = await observe(provider, computer);
  expect(result).toEqual({ kind: "unavailable" });
});

it("refuses linked worktrees, common directories and object alternates", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  // A `.git` file (linked worktree layout) is not a contained directory.
  const linked = path.join(home, "linked");
  git(["worktree", "add", "-q", "--detach", linked]);
  const linkedComputer = {
    ...computer,
    botId: "other-bot",
    providerRef: linked,
    id: "desktop-linked",
  };
  expect(await observe(provider, linkedComputer)).toEqual({ kind: "unavailable" });

  const common = path.join(home, ".git", "commondir");
  await writeFile(common, "../elsewhere\n");
  // Git itself fails the probe on a bogus common directory; either refusal is safe.
  const commonResult = await observe(provider, computer);
  expect(["unavailable", "not-repository"]).toContain(commonResult.kind);
  await rm(common);

  await mkdir(path.join(home, ".git", "objects", "info"), { recursive: true });
  await writeFile(path.join(home, ".git", "objects", "info", "alternates"), "/tmp/elsewhere\n");
  // Real Git keeps working with alternates, so the metadata guard must refuse.
  expect(await observe(provider, computer)).toEqual({ kind: "unavailable" });
});

it("refuses symlinked metadata that could leak an outside file", async () => {
  if (process.platform === "win32") return;
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  const outside = path.join(await realpath(path.join(home, "..")), `outside-${Date.now()}.md`);
  await writeFile(outside, "secret\n");
  try {
    await rm(path.join(home, ".git", "index"));
    await symlink(outside, path.join(home, ".git", "index"));
    expect(await observe(provider, computer)).toEqual({ kind: "unavailable" });
  } finally {
    await rm(outside, { force: true });
  }
});

it("never executes repository configuration: fsmonitor, external diff and textconv stay silent", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "hooked.txt"), "first\n");
  git(["add", "hooked.txt"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "hooked.txt"), "second\n");
  const marker = path.join(home, "ran.txt");
  const script = path.join(home, "probe.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(script, 0o755);
  // Repository config would execute on plain `git status`/`git diff` if the reader
  // did not disable each mechanism per invocation. The fixture commits before this
  // config exists so no setup step can run the probe either.
  await writeFile(
    path.join(home, ".git", "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfsmonitor = ./probe.sh",
      "[diff]",
      "\texternal = ./probe.sh",
    ].join("\n"),
  );
  await writeFile(path.join(home, ".gitattributes"), "hooked.txt diff=probe\n");
  await writeFile(path.join(home, ".git", "config"), `[diff "probe"]\n\ttextconv = ./probe.sh\n`, {
    flag: "a",
  });

  const status = await observe(provider, computer);
  expect(status.kind).toBe("status");
  const diff = await observe(provider, computer, { path: "hooked.txt" });
  expect(diff.kind).toBe("diff");
  if (diff.kind !== "diff") throw new Error("unreachable");
  expect(diff.after).toBe("second");
  expect(diff.binary).toBe(false);
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["clean", "worktree"],
  ["process", "worktree"],
  ["smudge", "worktree"],
  ["clean", "info"],
  ["process", "info"],
  ["smudge", "info"],
])(
  "never executes a repository %s filter assigned in %s attributes",
  async (mechanism, location) => {
    const { provider, computer, home, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(home, "filtered.txt"), "before\n");
    git(["add", "filtered.txt"]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(path.join(home, "filtered.txt"), "after\n");
    const marker = path.join(home, "filter-ran");
    await writeFile(path.join(home, "probe.sh"), "touch filter-ran\ncat\n");
    await writeFile(
      location === "info"
        ? path.join(home, ".git", "info", "attributes")
        : path.join(home, ".gitattributes"),
      "*.txt filter=probe\n",
    );
    git(["config", `filter.probe.${mechanism}`, "sh ./probe.sh"]);
    git(["config", "filter.probe.required", "true"]);

    const status = await observe(provider, computer);
    const diff = await observe(provider, computer, { path: "filtered.txt" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(status.kind).toBe("status");
    expect(diff).toMatchObject({ kind: "diff", before: "before", after: "after" });
  },
);

it("refuses config includes without executing their filters or worktree redirects", async () => {
  const { provider, computer, home, root, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "filtered.txt"), "before\n");
  git(["add", "filtered.txt"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "filtered.txt"), "after\n");
  await writeFile(path.join(home, ".gitattributes"), "*.txt filter=probe\n");
  await writeFile(path.join(home, "probe.sh"), "touch include-ran\ncat\n");
  const included = path.join(root, "included.config");
  await writeFile(included, '[filter "probe"]\nclean = sh ./probe.sh\n');
  git(["config", "include.path", included]);

  expect(await observe(provider, computer)).toEqual({ kind: "unavailable" });
  expect(await observe(provider, computer, { path: "filtered.txt" })).toEqual({
    kind: "unavailable",
  });
  await expect(stat(path.join(home, "include-ran"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["absolute", "relative", "symlink"])(
  "refuses an outside core.worktree configured with an %s path",
  async (layout) => {
    if (layout === "symlink" && process.platform === "win32") return;
    const { provider, computer, home, root, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(home, "tracked.txt"), "before\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "tracked.txt"), "outside content\n");
    let worktree = outside;
    if (layout === "relative") worktree = path.relative(path.join(home, ".git"), outside);
    if (layout === "symlink") {
      worktree = path.join(home, "redirect");
      await symlink(outside, worktree);
    }
    git(["config", "core.worktree", worktree]);

    expect(await observe(provider, computer)).toEqual({ kind: "unavailable" });
    expect(await observe(provider, computer, { path: "tracked.txt" })).toEqual({
      kind: "unavailable",
    });
  },
);

it("lists files in new untracked directories and reads their contents", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await mkdir(path.join(home, "newdir", "nested"), { recursive: true });
  await writeFile(path.join(home, "newdir", "nested", "app.txt"), "new content\n");

  expect(await observe(provider, computer)).toMatchObject({
    kind: "status",
    entries: [{ path: "newdir/nested/app.txt", untracked: true }],
  });
  expect(await observe(provider, computer, { path: "newdir/nested/app.txt" })).toMatchObject({
    kind: "diff",
    before: null,
    after: "new content",
  });
});

it.each([false, true])("recognizes a real tracked binary diff (staged: %s)", async (staged) => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "image.bin"), Buffer.from([1, 0, 2]));
  git(["add", "image.bin"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "image.bin"), Buffer.from([3, 0, 4]));
  if (staged) git(["add", "image.bin"]);

  expect(await observe(provider, computer, { path: "image.bin" })).toMatchObject({
    kind: "diff",
    binary: true,
    truncated: false,
  });
});

it.each([
  ["core.fsmonitor", null, "status"],
  ["diff.probe.textconv", "*.txt diff=probe", "diff"],
  ["diff.probe.command", "*.txt diff=probe", "diff"],
  ["diff.external", null, "diff"],
] as const)(
  "suppresses %s with an executable real-Git probe",
  async (setting, attributes, command) => {
    const { provider, computer, home, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(home, "tracked.txt"), "before\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(path.join(home, "tracked.txt"), "after\n");
    if (attributes) await writeFile(path.join(home, ".gitattributes"), `${attributes}\n`);
    const marker = path.join(home, "helper-ran");
    await writeFile(path.join(home, "probe.sh"), "touch helper-ran\n");
    git(["config", setting, "sh ./probe.sh"]);

    // A positive control proves the configured mechanism really can execute.
    git(command === "status" ? ["status", "--porcelain"] : ["diff", "HEAD", "--", "tracked.txt"]);
    expect((await stat(marker)).isFile()).toBe(true);
    await rm(marker);
    expect(await observe(provider, computer)).toMatchObject({ kind: "status" });
    expect(await observe(provider, computer, { path: "tracked.txt" })).toMatchObject({
      kind: "diff",
      before: "before",
      after: "after",
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("accepts core.worktree pointing at the bot folder and ignores inherited Git redirects", async () => {
  const { provider, computer, home, root, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  git(["config", "core.worktree", ".."]);
  await writeFile(path.join(home, "inside.txt"), "inside\n");
  // Inherited Git settings must not participate in either config parsing or observation.
  const original = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = root;
  try {
    expect(await observe(provider, computer, { path: "inside.txt" })).toMatchObject({
      kind: "diff",
      after: "inside",
    });
  } finally {
    if (original === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = original;
  }
});

it("never recurses into a submodule with repository-configured helpers", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  const child = path.join(home, "child");
  await mkdir(child);
  git(["init", "-q", "-b", "main"], child);
  await writeFile(path.join(child, "tracked.txt"), "before\n");
  git(["add", "tracked.txt"], child);
  git(["commit", "-q", "-m", "child base"], child);
  const childHead = git(["rev-parse", "HEAD"], child).trim();
  git(["update-index", "--add", "--cacheinfo", `160000,${childHead},child`]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(child, "tracked.txt"), "after\n");
  await writeFile(path.join(child, ".gitattributes"), "*.txt filter=probe\n");
  await writeFile(path.join(child, "probe.sh"), "touch submodule-ran\ncat\n");
  git(["config", "filter.probe.clean", "sh ./probe.sh"], child);
  git(["config", "core.fsmonitor", "sh ./probe.sh"], child);
  git(["status", "--porcelain"]);
  const marker = path.join(child, "submodule-ran");
  expect((await stat(marker)).isFile()).toBe(true);
  await rm(marker);

  const status = await observe(provider, computer);
  const diff = await observe(provider, computer, { path: "child" });
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(status).toMatchObject({ kind: "status", entries: [] });
  expect(diff).toMatchObject({ kind: "diff" });
});

it("preserves repository-local ignore rules in the isolated metadata view", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, ".git", "info", "exclude"), "ignored.txt\n");
  await writeFile(path.join(home, "ignored.txt"), "ignored\n");
  await writeFile(path.join(home, "visible.txt"), "visible\n");
  expect(await observe(provider, computer)).toMatchObject({
    kind: "status",
    entries: [{ path: "visible.txt", untracked: true }],
  });
});

it("preserves binary attributes stored in repository-local metadata", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "forced.dat"), "before\n");
  git(["add", "forced.dat"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, ".git", "info", "attributes"), "forced.dat -diff\n");
  await writeFile(path.join(home, "forced.dat"), "after\n");
  expect(await observe(provider, computer, { path: "forced.dat" })).toMatchObject({
    kind: "diff",
    binary: true,
  });
});

it("leaves the index and worktree untouched", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "a.md"), "one\n");
  git(["add", "a.md"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "a.md"), "two\n");
  // Read the fixture state before snapshotting the index; a plain status can
  // refresh stat information, which is a write the reader itself must not make.
  const statusBefore = git(["status", "--porcelain"]);
  const before = execFileSync("sha1sum", [path.join(home, ".git", "index")], { encoding: "utf8" });

  await observe(provider, computer);
  await observe(provider, computer, { path: "a.md" });

  const after = execFileSync("sha1sum", [path.join(home, ".git", "index")], { encoding: "utf8" });
  expect(after).toBe(before);
  expect(git(["status", "--porcelain"])).toBe(statusBefore);
});

it("redacts credentials from diff text with the existing logging redaction", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  await writeFile(path.join(home, "env"), "plain\n");
  git(["add", "env"]);
  git(["commit", "-q", "-m", "base"]);
  await writeFile(path.join(home, "env"), "TOKEN=ghp_fixturetokenvalue1234567890abcd\n");
  const diff = await observe(provider, computer, { path: "env" });
  if (diff.kind !== "diff") throw new Error("unreachable");
  expect(diff.after).not.toContain("ghp_fixturetokenvalue1234567890abcd");
  expect(diff.after).toContain("[Redacted]");
});

it("bounds an untracked read and reports the truncation", async () => {
  const { provider, computer, home, git } = await fixture();
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  await writeFile(path.join(home, "big.md"), `${"x".repeat(200 * 1024)}\n`);
  const diff = await observe(provider, computer, { path: "big.md" });
  if (diff.kind !== "diff") throw new Error("unreachable");
  expect(diff.truncated).toBe(true);
  expect(diff.after!.length).toBeLessThanOrEqual(128 * 1024);
});

it("honours the Team subfolder root so one bot cannot read a sibling's repository", async () => {
  const { provider, computer, home } = await fixture();
  const teamRoot = "teams/crew";
  const mine = path.join(home, teamRoot);
  const sibling = path.join(home, "teams/other");
  await mkdir(mine, { recursive: true });
  await mkdir(sibling, { recursive: true });
  const teamGit = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
      {
        cwd: sibling,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  teamGit(["init", "-q", "-b", "main"]);
  await writeFile(path.join(sibling, "secret.md"), "hidden\n");
  teamGit(["add", "secret.md"]);
  teamGit(["commit", "-q", "-m", "base"]);

  const scoped = { ...computer, id: "desktop-scoped" };
  const scopedContext: AdapterContext = { ...context, fileRoot: teamRoot };
  const mineResult = await provider.gitChanges(scoped as never, {}, scopedContext);
  expect(mineResult).toEqual({ kind: "not-repository" });
  // A traversal path is refused before any sibling content can be read; the root
  // probe already stops at the missing repository.
  const escapeAttempt = await provider.gitChanges(
    scoped as never,
    { path: "../other/secret.md" },
    scopedContext,
  );
  expect(["unavailable", "not-repository"]).toContain(escapeAttempt.kind);
});

describe("assertSafeGitMetadata", () => {
  it("accepts a contained .git directory", async () => {
    const { home, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await expect(assertSafeGitMetadata(home, path.join(home, ".git"))).resolves.toBeUndefined();
  });

  it("rejects a common directory and object alternates", async () => {
    const { home, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    const dotGit = path.join(home, ".git");
    await writeFile(path.join(dotGit, "commondir"), "../elsewhere\n");
    await expect(assertSafeGitMetadata(home, dotGit)).rejects.toThrow();
    await rm(path.join(dotGit, "commondir"));
    await mkdir(path.join(dotGit, "objects", "info"), { recursive: true });
    await writeFile(path.join(dotGit, "objects", "info", "alternates"), "/tmp/elsewhere\n");
    await expect(assertSafeGitMetadata(home, dotGit)).rejects.toThrow();
  });

  it("rejects a gitdir outside the root and a copied repository", async () => {
    const { home } = await fixture();
    await expect(assertSafeGitMetadata(home, "/elsewhere/.git")).rejects.toThrow();
    const clone = path.join(home, "clone");
    await mkdir(clone, { recursive: true });
    await copyFile(path.join(home, ".gitkeep"), path.join(clone, ".gitkeep")).catch(
      () => undefined,
    );
    await expect(assertSafeGitMetadata(clone, path.join(clone, ".git"))).rejects.toThrow();
  });
});

describe("createGitRunner", () => {
  it("reports failure exit codes without stdout leakage", async () => {
    const runner = createGitRunner();
    const result = await runner.run(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], {
      cwd: await realpath(tmpdir()),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    expect(result.code).toBe(128);
    expect(result.stdout.byteLength).toBe(0);
  });

  it("caps stdout at maxBytes and flags the cap", async () => {
    const { home, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    git(["commit", "-q", "--allow-empty", "-m", "base"]);
    await writeFile(path.join(home, "visible.md"), "changed\n");
    const runner = createGitRunner();
    const result = await runner.run(
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"],
      { cwd: home, maxBytes: 4, timeoutMs: 5000 },
    );
    expect(result.capped).toBe(true);
    expect(result.code).toBe(124);
    expect(result.stdout.byteLength).toBeLessThanOrEqual(4);
  });
});
