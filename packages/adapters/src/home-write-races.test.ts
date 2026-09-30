import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeContainmentError, LocalAgentHomeStore } from "./home.js";

const race = vi.hoisted(() => ({
  afterLstat: undefined as ((path: string) => Promise<void>) | undefined,
  beforeRename: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const result = await actual.lstat(...args);
      await race.afterLstat?.(String(args[0]));
      return result;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await race.beforeRename?.();
      return actual.rename(...args);
    },
  };
});

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  race.afterLstat = undefined;
  race.beforeRename = undefined;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ardurbot-home-write-race-"));
  dirs.push(root);
  const store = new LocalAgentHomeStore(root);
  await fs.mkdir(path.join(store.pathFor("bot-1"), "bots", "bot", "sub"), { recursive: true });
  // The store checks the realpath'd home; match it so hooks see the same paths.
  const home = await fs.realpath(store.pathFor("bot-1"));
  const workspace = path.join(home, "bots", "bot");
  const target = path.join(workspace, "sub", "notes.md");
  const outsideDir = path.join(await fs.realpath(root), "outside");
  const outsideFile = path.join(outsideDir, "notes.md");
  await fs.writeFile(target, "hello");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(outsideFile, "secret");
  return { root, store, home, workspace, target, outsideDir, outsideFile };
}

const tempLeftovers = async (dir: string) =>
  (await fs.readdir(dir)).filter((entry) => entry.includes(".tmp-"));

describe("LocalAgentHomeStore writeFileInsideRoot", () => {
  it("writes through a temporary file inside the verified directory and keeps the mode", async () => {
    const { store, workspace, target } = await fixture();
    await fs.chmod(target, 0o755);
    await store.writeFileInsideRoot(
      "bot-1",
      "bots/bot",
      "bots/bot/sub/notes.md",
      "changed",
      context,
    );
    expect(await fs.readFile(target, "utf8")).toBe("changed");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
    expect(await tempLeftovers(path.dirname(target))).toEqual([]);

    await store.writeFileInsideRoot(
      "bot-1",
      "bots/bot",
      "bots/bot/new/deep/file.md",
      "fresh",
      context,
    );
    expect(await fs.readFile(path.join(workspace, "new", "deep", "file.md"), "utf8")).toBe("fresh");

    await store.writeFileInsideRoot("bot-1", "", "loose.md", "bot scope", context);
    expect(await fs.readFile(path.join(store.pathFor("bot-1"), "loose.md"), "utf8")).toBe(
      "bot scope",
    );
  });

  it("refuses a target that is already a symlink out of the workspace", async () => {
    const { store, target, outsideFile } = await fixture();
    await fs.rm(target);
    await fs.symlink(outsideFile, target);
    await expect(
      store.writeFileInsideRoot("bot-1", "bots/bot", "bots/bot/sub/notes.md", "pwned", context),
    ).rejects.toThrow(HomeContainmentError);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await tempLeftovers(path.dirname(target))).toEqual([]);
  });

  it("refuses a parent directory that is already a symlink out of the workspace", async () => {
    const { store, workspace, outsideDir, outsideFile } = await fixture();
    await fs.rm(path.join(workspace, "sub"), { recursive: true });
    await fs.symlink(outsideDir, path.join(workspace, "sub"));
    await expect(
      store.writeFileInsideRoot("bot-1", "bots/bot", "bots/bot/sub/notes.md", "pwned", context),
    ).rejects.toThrow(HomeContainmentError);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
    expect(await tempLeftovers(outsideDir)).toEqual([]);
  });

  it("refuses when a parent directory is swapped for a symlink after the boundary check", async () => {
    const { store, workspace, outsideDir, outsideFile } = await fixture();
    const sub = path.join(workspace, "sub");
    let swapped = false;
    race.afterLstat = async (checked) => {
      // The last boundary component is checked before the file's parent walk.
      if (checked !== workspace || swapped) return;
      swapped = true;
      await fs.rename(sub, `${sub}-real`);
      await fs.symlink(outsideDir, sub);
    };
    await expect(
      store.writeFileInsideRoot("bot-1", "bots/bot", "bots/bot/sub/notes.md", "pwned", context),
    ).rejects.toThrow(HomeContainmentError);
    expect(swapped).toBe(true);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
    expect(await tempLeftovers(outsideDir)).toEqual([]);
  });

  it("refuses when the target is swapped for a symlink after the parent check", async () => {
    const { store, target, outsideFile } = await fixture();
    let swapped = false;
    race.afterLstat = async (checked) => {
      if (checked !== path.dirname(target) || swapped) return;
      swapped = true;
      await fs.rm(target);
      await fs.symlink(outsideFile, target);
    };
    await expect(
      store.writeFileInsideRoot("bot-1", "bots/bot", "bots/bot/sub/notes.md", "pwned", context),
    ).rejects.toThrow(HomeContainmentError);
    expect(swapped).toBe(true);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
  });

  it("replaces a symlink swapped in after every check instead of following it", async () => {
    const { store, target, outsideFile } = await fixture();
    let swapped = false;
    race.beforeRename = async () => {
      swapped = true;
      await fs.rm(target);
      await fs.symlink(outsideFile, target);
    };
    await store.writeFileInsideRoot(
      "bot-1",
      "bots/bot",
      "bots/bot/sub/notes.md",
      "changed",
      context,
    );
    expect(swapped).toBe(true);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(target, "utf8")).toBe("changed");
  });

  it("refuses when a concurrent commit replaced the home with a planted symlink", async () => {
    const { root, store, home, outsideFile } = await fixture();
    // A stop/commit swaps the whole home directory by atomic rename; anything
    // planted in the replacement (here a symlink escaping the workspace) must
    // be refused by the next write even though a path check ran before it.
    const replacement = path.join(root, "replacement");
    await fs.mkdir(path.join(replacement, "bots", "bot"), { recursive: true });
    await fs.symlink(outsideFile, path.join(replacement, "bots", "bot", "notes.md"));
    await fs.writeFile(path.join(replacement, "bots", "bot", "plain.md"), "plain");
    await fs.rename(home, `${home}.old`);
    await fs.rename(replacement, home);
    await expect(
      store.writeFileInsideRoot("bot-1", "bots/bot", "bots/bot/notes.md", "pwned", context),
    ).rejects.toThrow(HomeContainmentError);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
    await expect(
      store.writeFileInsideRoot("bot-1", "bots/bot", "bots/bot/plain.md", "updated", context),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(home, "bots", "bot", "plain.md"), "utf8")).toBe("updated");
  });
});
