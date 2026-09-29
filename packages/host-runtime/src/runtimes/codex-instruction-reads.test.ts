import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProjectInstructions,
  trustedInstructionSources,
  UnsafeInstructionFileError,
} from "./codex-app-server-runtime.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A scratch folder, spelled as the disk spells it (the system temp folder is itself a link). */
async function scratch() {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-reads-")));
  return root;
}

async function write(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

describe("project instructions", () => {
  it("reads the instruction files from the git root down to the folder, outermost first", async () => {
    const repo = path.join(await scratch(), "repo");
    const folder = path.join(repo, "a", "b");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const files = [
      await write(path.join(repo, "AGENTS.md"), "root rules\n"),
      await write(path.join(repo, "a", "AGENTS.md"), "area rules"),
      await write(path.join(folder, "AGENTS.md"), "\nfolder rules\n"),
    ];
    // Above the git root: never read.
    await write(path.join(root, "AGENTS.md"), "outside");
    expect(await loadProjectInstructions(folder)).toEqual({
      text: "root rules\n\narea rules\n\nfolder rules",
      sources: files,
      directories: [repo, path.join(repo, "a"), folder],
    });
  });

  it("reads nothing where there are no instruction files", async () => {
    const folder = path.join(await scratch(), "home");
    await mkdir(folder, { recursive: true });
    expect(await loadProjectInstructions(folder)).toEqual({
      text: "",
      sources: [],
      directories: [folder],
    });
  });

  it("reads only the folder's own instruction file when there is no git root", async () => {
    const folder = path.join(await scratch(), "home");
    const own = await write(path.join(folder, "AGENTS.md"), "own");
    await write(path.join(root, "AGENTS.md"), "above");
    expect(await loadProjectInstructions(folder)).toMatchObject({ text: "own", sources: [own] });
  });

  it("takes one file per folder: the override, then AGENTS.md, then a fallback name", async () => {
    const project = path.join(await scratch(), "project");
    const folder = path.join(project, "services", "api");
    await mkdir(path.join(project, ".hg"), { recursive: true });
    await write(path.join(project, "AGENTS.md"), "project plain");
    const override = await write(path.join(project, "AGENTS.override.md"), "project override");
    const guide = await write(path.join(project, "services", "TEAM_GUIDE.md"), "services guide");
    const plain = await write(path.join(folder, "AGENTS.md"), "api plain");
    await write(path.join(folder, "TEAM_GUIDE.md"), "api guide");
    await write(path.join(root, "escape.md"), "escaped");
    expect(
      await loadProjectInstructions(folder, {
        rootMarkers: [".hg"],
        fallbackFilenames: ["TEAM_GUIDE.md", "../escape.md", 7],
      }),
    ).toMatchObject({
      text: "project override\n\nservices guide\n\napi plain",
      sources: [override, guide, plain],
    });
  });

  it("keeps to Codex's limit, and reads nothing when the limit is zero", async () => {
    const folder = path.join(await scratch(), "bot");
    await mkdir(path.join(folder, ".git"), { recursive: true });
    await write(path.join(folder, "AGENTS.md"), "0123456789");
    expect((await loadProjectInstructions(folder, { maxBytes: 4 })).text).toBe("0123");
    expect((await loadProjectInstructions(folder, { maxBytes: "4" })).text).toBe("0123456789");
    // Turned off in Codex's own settings: nothing is read, so nothing can refuse the session.
    await rm(path.join(folder, "AGENTS.md"));
    await symlink(
      await write(path.join(root, "vault", "secret.txt"), "protected"),
      path.join(folder, "AGENTS.md"),
    );
    expect(await loadProjectInstructions(folder, { maxBytes: 0 })).toMatchObject({
      text: "",
      sources: [],
    });
  });

  it("walks the folder as the disk spells it when it is reached through a link", async () => {
    const real = path.join(await scratch(), "real");
    const own = await write(path.join(real, "AGENTS.md"), "own");
    const alias = path.join(root, "alias");
    await symlink(real, alias);
    expect(await loadProjectInstructions(alias)).toEqual({
      text: "own",
      sources: [own],
      directories: [real],
    });
  });

  it("follows a link that stays inside the project, and reads the file it points to", async () => {
    const repo = path.join(await scratch(), "repo");
    const folder = path.join(repo, "bot");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const shared = await write(path.join(repo, "CLAUDE.md"), "shared rules");
    await symlink(shared, path.join(repo, "AGENTS.md"));
    const guide = await write(path.join(folder, "docs", "guide.md"), "bot guide");
    await symlink(guide, path.join(folder, "AGENTS.md"));
    expect(await loadProjectInstructions(folder)).toMatchObject({
      text: "shared rules\n\nbot guide",
      sources: [shared, guide],
    });
  });

  it("reads a real file whose name differs only in case, on a disk that ignores case", async () => {
    const repo = path.join(await scratch(), "repo");
    const folder = path.join(repo, "bot");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(folder, { recursive: true });
    const spelled = await write(path.join(repo, "agents.md"), "lowercase");
    const found = await realpath(path.join(repo, "AGENTS.md")).catch(() => undefined);
    // A disk that tells the two names apart has no AGENTS.md here, and Codex finds none either.
    expect((await loadProjectInstructions(folder)).sources).toEqual(found ? [spelled] : []);
  });

  it.each([
    ["a link out of the project", "link"],
    ["a chain of links that ends outside the project", "chain"],
    ["a second name for a file outside the project", "outside-name"],
    ["a second name for a file inside the project", "inside-name"],
    ["a broken link", "broken"],
    ["a folder", "folder"],
    ["protected data", "protected"],
  ])("refuses the session for %s", async (_label, kind) => {
    const repo = path.join(await scratch(), "repo");
    const folder = path.join(repo, "bot");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "AGENTS.md");
    const outside = await write(path.join(root, "vault", "secret.txt"), "protected");
    const guarded: string[] = [];
    if (kind === "link") await symlink(outside, file);
    if (kind === "chain") {
      await symlink(outside, path.join(folder, "step.md"));
      await symlink(path.join(folder, "step.md"), file);
    }
    if (kind === "outside-name") await link(outside, file);
    if (kind === "inside-name") await link(await write(path.join(folder, "CLAUDE.md"), "x"), file);
    if (kind === "broken") await symlink(path.join(folder, "gone.md"), file);
    if (kind === "folder") await mkdir(file);
    if (kind === "protected") guarded.push(await write(file, "kept"));
    const refusal = await loadProjectInstructions(folder, {}, guarded).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(UnsafeInstructionFileError);
    expect((refusal as UnsafeInstructionFileError).filename).toBe("AGENTS.md");
  });
});

describe("what Codex says it loaded", () => {
  const minute = 60_000;
  const check = (directories: string[] = [], guarded: string[] = [], askedAtMs = Date.now()) => ({
    directories,
    guarded,
    askedAtMs,
  });
  /** A file that last changed well before the session was asked for. */
  async function settled(file: string, text = "global rules") {
    await write(file, text);
    return file;
  }

  it("trusts an ordinary file outside the project that did not change", async () => {
    const home = path.join(await scratch(), "codex-home");
    const file = await settled(path.join(home, "AGENTS.md"));
    const later = Date.now() + minute;
    expect(await trustedInstructionSources([file], check([], [], later))).toBe(true);
    expect(await trustedInstructionSources([], check())).toBe(true);
    expect(await trustedInstructionSources(undefined, check())).toBe(true);
  });

  it("trusts a link to the person's own file elsewhere", async () => {
    const home = path.join(await scratch(), "codex-home");
    const dotfile = await settled(path.join(root, "dotfiles", "AGENTS.md"));
    await mkdir(home, { recursive: true });
    await symlink(dotfile, path.join(home, "AGENTS.md"));
    const later = Date.now() + minute;
    expect(
      await trustedInstructionSources([path.join(home, "AGENTS.md")], check([], [], later)),
    ).toBe(true);
  });

  it("refuses a file that points at protected data", async () => {
    const home = path.join(await scratch(), "codex-home");
    const secret = await settled(path.join(root, "data", "secrets.env"), "KEY=1");
    await mkdir(home, { recursive: true });
    await symlink(secret, path.join(home, "AGENTS.md"));
    const later = Date.now() + minute;
    expect(
      await trustedInstructionSources(
        [path.join(home, "AGENTS.md")],
        check([], [path.join(root, "data")], later),
      ),
    ).toBe(false);
  });

  it("refuses a file that changed after the session was asked for", async () => {
    const home = path.join(await scratch(), "codex-home");
    const file = path.join(home, "AGENTS.md");
    const asked = Date.now() - minute;
    await settled(file);
    expect(await trustedInstructionSources([file], check([], [], asked))).toBe(false);
  });

  it("refuses a file that was swapped for a link and put back, even with its times reset", async () => {
    const home = path.join(await scratch(), "codex-home");
    const file = await settled(path.join(home, "AGENTS.md"));
    const secret = await settled(path.join(root, "data", "secrets.env"), "KEY=1");
    const before = new Date(Date.now() - 10 * minute);
    await utimes(file, before, before);
    // Asked for a moment ago; then the swap, Codex's read, and the file put back.
    const asked = Date.now() - 1;
    await rename(file, `${file}.kept`);
    await symlink(secret, file);
    await rm(file);
    await rename(`${file}.kept`, file);
    await utimes(file, before, before);
    expect(await trustedInstructionSources([file], check([], [], asked))).toBe(false);
  });

  it("refuses a file from the project, which Codex was told not to load", async () => {
    const repo = path.join(await scratch(), "repo");
    const folder = path.join(repo, "bot");
    const own = await settled(path.join(folder, "AGENTS.md"));
    const above = await settled(path.join(repo, "AGENTS.md"));
    const later = Date.now() + minute;
    for (const file of [own, above])
      expect(await trustedInstructionSources([file], check([repo, folder], [], later))).toBe(false);
  });

  it("refuses what it cannot check", async () => {
    const later = Date.now() + minute;
    const missing = path.join(await scratch(), "gone.md");
    for (const sources of [[missing], ["relative.md"], [7], "AGENTS.md", {}])
      expect(await trustedInstructionSources(sources, check([], [], later))).toBe(false);
  });
});
