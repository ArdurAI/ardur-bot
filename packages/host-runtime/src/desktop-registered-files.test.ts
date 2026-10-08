import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_REFUSALS, CommandRefusalError } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FILE_LOCATION_REFUSAL } from "./host-policy.js";

const context = {
  operationId: "files",
  traceId: "files",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(restricted: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "registered-files-")));
  cleanups.push(root);
  const registered = path.join(root, "project");
  const outside = path.join(root, "outside");
  const protectedPath = path.join(registered, "protected");
  await Promise.all(
    [registered, outside, protectedPath].map((folder) => mkdir(folder, { recursive: true })),
  );
  await mkdir(path.join(root, "homes"));
  const foldersFile = path.join(root, "folders.json");
  await writeFile(foldersFile, JSON.stringify([registered]));
  const provider = new DesktopSandboxProvider({
    root: path.join(root, "homes"),
    restricted,
    registeredFoldersFile: foldersFile,
    guard: { paths: [protectedPath], ports: [], sockets: [] },
  });
  const computer = await provider.provision({ botId: "bot", homePath: "" }, context);
  return { root, registered, outside, protectedPath, foldersFile, provider, computer };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe.each([false, true])("registered local files (restricted: %s)", (restricted) => {
  it("identifies the actual file guard refusal without changing its original sentence", async () => {
    const { provider, computer } = await fixture(restricted);
    const error = await provider
      .readFile(computer, "../outside.txt", context)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandRefusalError);
    expect(error).toMatchObject({
      refusalId: "file-location",
      message: COMMAND_REFUSALS["file-location"],
    });
  });

  it("narrows workspace operations to a Team bot without changing explicit registered roots", async () => {
    const { provider, computer, registered } = await fixture(restricted);
    const root = "bots/selected";
    const scoped = { ...context, fileRoot: root };
    const own = path.join(computer.providerRef, root);
    const other = path.join(computer.providerRef, "bots/other");
    await mkdir(own, { recursive: true });
    await mkdir(other);
    await writeFile(path.join(own, "notes.md"), "own");
    await writeFile(path.join(other, "notes.md"), "other");
    await writeFile(path.join(registered, "notes.md"), "registered");
    expect(await provider.listFiles(computer, root, scoped)).toMatchObject([
      { path: `${root}/notes.md` },
    ]);
    expect(await provider.readFile(computer, `${root}/notes.md`, scoped)).toEqual(bytes("own"));
    await provider.stop(computer, context);
    await provider.writeFile(
      computer,
      { path: `${root}/notes.md`, content: bytes("edited") },
      scoped,
    );
    expect(await provider.readFile(computer, `${root}/notes.md`, scoped)).toEqual(bytes("edited"));
    for (const escapedPath of ["bots/other", path.join(registered, "notes.md")]) {
      await expect(provider.listFiles(computer, escapedPath, scoped)).rejects.toThrow(
        FILE_LOCATION_REFUSAL,
      );
      await expect(provider.readFile(computer, escapedPath, scoped)).rejects.toThrow(
        FILE_LOCATION_REFUSAL,
      );
      await expect(
        provider.writeFile(computer, { path: escapedPath, content: bytes("draft") }, scoped),
      ).rejects.toThrow(FILE_LOCATION_REFUSAL);
    }
    await symlink(other, path.join(own, "sibling"), "junction");
    await expect(provider.listFiles(computer, `${root}/sibling`, scoped)).rejects.toThrow(
      FILE_LOCATION_REFUSAL,
    );
    await expect(provider.readFile(computer, `${root}/sibling/notes.md`, scoped)).rejects.toThrow(
      FILE_LOCATION_REFUSAL,
    );
    await expect(
      provider.writeFile(
        computer,
        { path: `${root}/sibling/notes.md`, content: bytes("draft") },
        scoped,
      ),
    ).rejects.toThrow(FILE_LOCATION_REFUSAL);
    await rm(path.join(own, "sibling"));
    await rm(own, { recursive: true });
    await symlink(other, own, "junction");
    await expect(provider.listFiles(computer, root, scoped)).rejects.toThrow(FILE_LOCATION_REFUSAL);
    await expect(provider.readFile(computer, `${root}/notes.md`, scoped)).rejects.toThrow(
      FILE_LOCATION_REFUSAL,
    );
    await expect(
      provider.writeFile(computer, { path: `${root}/notes.md`, content: bytes("draft") }, scoped),
    ).rejects.toThrow(FILE_LOCATION_REFUSAL);
    expect(await readFile(path.join(other, "notes.md"), "utf8")).toBe("other");
    // Explicit operations outside the workspace pane retain the existing registered-root behavior.
    const explicit = path.join(registered, "notes.md");
    expect(await provider.readFile(computer, explicit, context)).toEqual(bytes("registered"));
    await provider.writeFile(computer, { path: explicit, content: bytes("updated") }, context);
    expect(await readFile(explicit, "utf8")).toBe("updated");
  });

  it("keeps own-folder relative paths working and accepts their absolute form", async () => {
    const { provider, computer } = await fixture(restricted);
    await provider.writeFile(computer, { path: "notes/result.txt", content: bytes("own") });
    expect(await provider.readFile(computer, "notes/result.txt")).toEqual(bytes("own"));
    expect(
      await provider.readFile(computer, path.join(computer.providerRef, "notes/result.txt")),
    ).toEqual(bytes("own"));
  });
  it("reads and writes an absolute path inside a registered folder", async () => {
    const { registered, provider, computer } = await fixture(restricted);
    const target = path.join(registered, "notes/result.txt");
    await provider.writeFile(computer, { path: target, content: bytes("project") });
    expect(await provider.readFile(computer, target)).toEqual(bytes("project"));
    expect(await readFile(target, "utf8")).toBe("project");
  });
  it("lists absolute registered paths and preserves own-folder listings", async () => {
    const { registered, provider, computer } = await fixture(restricted);
    const folder = path.join(registered, "notes");
    await mkdir(folder);
    await writeFile(path.join(folder, "result.txt"), "project");
    expect(await provider.listFiles(computer, folder, context)).toEqual([
      { path: path.join(folder, "result.txt"), kind: "file", size: 7 },
    ]);
    await provider.writeFile(computer, { path: "notes/result.txt", content: bytes("own") });
    expect(await provider.listFiles(computer, "notes", context)).toEqual([
      { path: "notes/result.txt", kind: "file", size: 3 },
    ]);
    expect(await provider.listFiles(computer, computer.providerRef, context)).toContainEqual({
      path: path.join(computer.providerRef, "notes"),
      kind: "dir",
      size: expect.any(Number),
    });
  });
  it("refuses outside, traversing, NUL and escaping directory listings", async () => {
    const { registered, outside, protectedPath, provider, computer } = await fixture(restricted);
    await symlink(outside, path.join(registered, "escape"), "junction");
    for (const directory of [
      outside,
      `${registered}/../outside`,
      "../outside",
      "bad\0path",
      path.join(registered, "escape"),
    ]) {
      await expect(provider.listFiles(computer, directory, context)).rejects.toThrow(
        FILE_LOCATION_REFUSAL,
      );
    }
    await expect(provider.listFiles(computer, protectedPath, context)).rejects.toThrow("protected");
  });
  it("rechecks registration before listing a folder", async () => {
    const { registered, foldersFile, provider, computer } = await fixture(restricted);
    const folder = path.join(registered, "visible");
    await mkdir(folder);
    expect(await provider.listFiles(computer, folder, context)).toEqual([]);
    await writeFile(foldersFile, "[]");
    await expect(provider.listFiles(computer, folder, context)).rejects.toThrow(
      FILE_LOCATION_REFUSAL,
    );
  });
  it("refuses a path outside both roots without changing it", async () => {
    const { outside, provider, computer } = await fixture(restricted);
    const target = path.join(outside, "result.txt");
    await writeFile(target, "untouched");
    await expect(provider.readFile(computer, target)).rejects.toThrow(FILE_LOCATION_REFUSAL);
    await expect(
      provider.writeFile(computer, { path: target, content: bytes("changed") }),
    ).rejects.toThrow(FILE_LOCATION_REFUSAL);
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("refuses parent and final symlinks that escape a registered folder", async () => {
    const { registered, outside, provider, computer } = await fixture(restricted);
    const target = path.join(outside, "result.txt");
    await writeFile(target, "untouched");
    await symlink(outside, path.join(registered, "escape"), "junction");
    await symlink(target, path.join(registered, "file.txt"));
    for (const filePath of [
      path.join(registered, "escape/result.txt"),
      path.join(registered, "file.txt"),
    ]) {
      await expect(provider.readFile(computer, filePath)).rejects.toThrow(FILE_LOCATION_REFUSAL);
      await expect(
        provider.writeFile(computer, { path: filePath, content: bytes("changed") }),
      ).rejects.toThrow();
    }
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("refuses raw dot-dot traversal and NUL before normalizing", async () => {
    const { registered, provider, computer } = await fixture(restricted);
    for (const filePath of [
      `${registered}/../outside/result.txt`,
      "../outside/result.txt",
      "bad\0path",
    ]) {
      await expect(provider.readFile(computer, filePath)).rejects.toThrow(FILE_LOCATION_REFUSAL);
      await expect(
        provider.writeFile(computer, { path: filePath, content: bytes("changed") }),
      ).rejects.toThrow(FILE_LOCATION_REFUSAL);
    }
  });
  it("does not allow protected files even inside a registered root", async () => {
    const { protectedPath, provider, computer } = await fixture(restricted);
    const target = path.join(protectedPath, "file.txt");
    await writeFile(target, "protected fixture");
    await expect(provider.readFile(computer, target)).rejects.toThrow("protected");
    await expect(
      provider.writeFile(computer, {
        path: path.join(protectedPath, "new/child.txt"),
        content: bytes("changed"),
      }),
    ).rejects.toThrow("protected");
    await expect(realpath(path.join(protectedPath, "new"))).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("protected fixture");
  });
  it("does not create parents through an in-root symlink to a protected folder", async () => {
    const { registered, protectedPath, provider, computer } = await fixture(restricted);
    await symlink(protectedPath, path.join(registered, "protected-alias"), "junction");
    await expect(
      provider.writeFile(computer, {
        path: path.join(registered, "protected-alias/new/child.txt"),
        content: bytes("changed"),
      }),
    ).rejects.toThrow("protected");
    await expect(realpath(path.join(protectedPath, "new"))).rejects.toThrow();
  });
  it("uses current registrations and ignores unavailable folders", async () => {
    const { root, registered, foldersFile, provider, computer } = await fixture(restricted);
    const target = path.join(registered, "file.txt");
    await writeFile(target, "project");
    await writeFile(foldersFile, JSON.stringify([path.join(root, "missing"), registered]));
    expect(await provider.readFile(computer, target)).toEqual(bytes("project"));
    await writeFile(foldersFile, "[]");
    await expect(provider.readFile(computer, target)).rejects.toThrow(FILE_LOCATION_REFUSAL);
    await expect(
      provider.writeFile(computer, { path: target, content: bytes("changed") }),
    ).rejects.toThrow(FILE_LOCATION_REFUSAL);
  });
  it("refuses hard-linked writes in registered folders", async () => {
    const { registered, outside, provider, computer } = await fixture(restricted);
    const target = path.join(outside, "original.txt");
    const alias = path.join(registered, "alias.txt");
    await writeFile(target, "untouched");
    await link(target, alias);
    await expect(
      provider.writeFile(computer, { path: alias, content: bytes("changed") }),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
});
