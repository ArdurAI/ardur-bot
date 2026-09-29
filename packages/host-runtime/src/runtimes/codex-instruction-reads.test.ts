import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { instructionFileReads, UnsafeInstructionFileError } from "./codex-app-server-runtime.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A scratch folder, spelled as the disk spells it (the system temp folder is itself a link). */
async function scratch() {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-reads-")));
  return root;
}

async function write(file: string, text = "instructions") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

it("grants the instruction files that exist from the git root down to the folder", async () => {
  const repo = path.join(await scratch(), "repo");
  const folder = path.join(repo, "a", "b");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const files = [
    await write(path.join(repo, "AGENTS.md")),
    await write(path.join(repo, "a", "AGENTS.override.md")),
    await write(path.join(folder, "AGENTS.md")),
  ];
  // Above the git root: never granted.
  await write(path.join(root, "AGENTS.md"));
  const reads = await instructionFileReads(folder);
  expect(Object.keys(reads).sort()).toEqual([...files].sort());
  expect(new Set(Object.values(reads))).toEqual(new Set(["read"]));
});

it("grants nothing for instruction files that are not there", async () => {
  const folder = path.join(await scratch(), "home");
  await mkdir(folder, { recursive: true });
  expect(await instructionFileReads(folder)).toEqual({});
});

it("grants only the folder's own instruction files when there is no git root", async () => {
  const folder = path.join(await scratch(), "home");
  const own = await write(path.join(folder, "AGENTS.md"));
  await write(path.join(root, "AGENTS.md"));
  expect(Object.keys(await instructionFileReads(folder))).toEqual([own]);
});

it("honours configured root markers and fallback instruction names", async () => {
  const project = path.join(await scratch(), "project");
  const folder = path.join(project, "services", "api");
  await mkdir(path.join(project, ".hg"), { recursive: true });
  const files = [
    await write(path.join(project, "TEAM_GUIDE.md")),
    await write(path.join(project, "services", "AGENTS.md")),
    await write(path.join(folder, "TEAM_GUIDE.md")),
  ];
  await write(path.join(root, "escape.md"));
  const reads = await instructionFileReads(folder, {
    rootMarkers: [".hg"],
    fallbackFilenames: ["TEAM_GUIDE.md", "../escape.md", 7],
  });
  expect(Object.keys(reads).sort()).toEqual([...files].sort());
  expect(Object.keys(reads).some((key) => key.includes("escape"))).toBe(false);
});

it("walks and grants the folder as the disk spells it when the folder is reached through a link", async () => {
  const real = path.join(await scratch(), "real");
  const own = await write(path.join(real, "AGENTS.md"));
  const alias = path.join(root, "alias");
  await symlink(real, alias);
  expect(Object.keys(await instructionFileReads(alias))).toEqual([own]);
});

it("grants a link that stays inside the bot's folder, as the file it points to", async () => {
  const folder = path.join(await scratch(), "bot");
  const target = await write(path.join(folder, "docs", "guide.md"));
  await symlink(target, path.join(folder, "AGENTS.md"));
  expect(await instructionFileReads(folder)).toEqual({ [target]: "read" });
});

it("refuses an instruction file that links to a file outside the bot's folder", async () => {
  const folder = path.join(await scratch(), "bot");
  await mkdir(folder, { recursive: true });
  const outside = await write(path.join(root, "vault", "secret.txt"), "protected");
  await symlink(outside, path.join(folder, "AGENTS.md"));
  const refusal = await instructionFileReads(folder).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UnsafeInstructionFileError);
  expect((refusal as UnsafeInstructionFileError).filename).toBe("AGENTS.md");
});

it("refuses a link in a folder above the bot's folder, even to a file beside it", async () => {
  const repo = path.join(await scratch(), "repo");
  const folder = path.join(repo, "bot");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(folder, { recursive: true });
  await symlink(await write(path.join(repo, "notes.txt")), path.join(repo, "AGENTS.md"));
  await expect(instructionFileReads(folder)).rejects.toBeInstanceOf(UnsafeInstructionFileError);
});

it("refuses an instruction file that is a second name for a file elsewhere", async () => {
  const folder = path.join(await scratch(), "bot");
  await mkdir(folder, { recursive: true });
  await link(
    await write(path.join(root, "vault", "secret.txt"), "protected"),
    path.join(folder, "AGENTS.md"),
  );
  await expect(instructionFileReads(folder)).rejects.toBeInstanceOf(UnsafeInstructionFileError);
});

it("refuses an instruction file that is a folder, a broken link or protected data", async () => {
  const folder = path.join(await scratch(), "bot");
  await mkdir(path.join(folder, "AGENTS.md"), { recursive: true });
  await expect(instructionFileReads(folder)).rejects.toBeInstanceOf(UnsafeInstructionFileError);

  await rm(path.join(folder, "AGENTS.md"), { recursive: true });
  await symlink(path.join(folder, "gone.md"), path.join(folder, "AGENTS.md"));
  await expect(instructionFileReads(folder)).rejects.toBeInstanceOf(UnsafeInstructionFileError);

  await rm(path.join(folder, "AGENTS.md"));
  const own = await write(path.join(folder, "AGENTS.md"));
  await expect(instructionFileReads(folder, {}, [own])).rejects.toBeInstanceOf(
    UnsafeInstructionFileError,
  );
  expect(await instructionFileReads(folder, {}, [path.join(root, "elsewhere")])).toEqual({
    [own]: "read",
  });
});

it("grants a real file whose name differs only in case, on a disk that ignores case", async () => {
  const repo = path.join(await scratch(), "repo");
  const folder = path.join(repo, "bot");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(folder, { recursive: true });
  const spelled = await write(path.join(repo, "agents.md"));
  const found = await realpath(path.join(repo, "AGENTS.md")).catch(() => undefined);
  // A disk that tells the two names apart has no AGENTS.md here, and Codex finds none either.
  expect(await instructionFileReads(folder)).toEqual(found ? { [spelled]: "read" } : {});
});
