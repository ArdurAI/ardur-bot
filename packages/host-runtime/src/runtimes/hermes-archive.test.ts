import { spawnSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  extractSourceArchive,
  extractUvBinary,
  gitTreeHash,
  gitTreeIdOfArchive,
} from "./hermes-archive.js";

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(options: {
  name: string;
  size: number;
  mode: number;
  type: string;
  link?: string;
}): Buffer {
  const header = Buffer.alloc(512, 0);
  Buffer.from(options.name, "utf8").copy(header, 0);
  writeOctal(header, 100, 8, options.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, options.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = options.type.charCodeAt(0);
  if (options.link) Buffer.from(options.link, "utf8").copy(header, 157);
  header.write("ustar", 257, "ascii");
  header[262] = 0;
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function pad(data: Buffer): Buffer {
  const extra = (512 - (data.length % 512)) % 512;
  return extra === 0 ? data : Buffer.concat([data, Buffer.alloc(extra)]);
}

function entry(options: {
  name: string;
  data?: Buffer;
  mode?: number;
  type?: string;
  link?: string;
}): Buffer {
  const data = options.data ?? Buffer.alloc(0);
  const type = options.type ?? "0";
  return Buffer.concat([
    tarHeader({
      name: options.name,
      size: data.length,
      mode: options.mode ?? (type === "5" ? 0o755 : 0o644),
      type,
      link: options.link,
    }),
    pad(data),
  ]);
}

function gzipTar(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

const limits = { files: 100, bytes: 1024 * 1024, inflated: 2 * 1024 * 1024 };

const treeFiles = [
  { path: "notes/readme.txt", data: Buffer.from("readme\n"), mode: 0o644 },
  { path: "notes/inner/deep.txt", data: Buffer.from("deep\n"), mode: 0o644 },
  { path: "run.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
  { path: "top.txt", data: Buffer.from("top\n"), mode: 0o644 },
];

function treeArchive(files = treeFiles): Buffer {
  return gzipTar([
    entry({ name: "rel/", type: "5", mode: 0o755 }),
    ...files.map((file) => entry({ name: `rel/${file.path}`, data: file.data, mode: file.mode })),
    // An empty folder is omitted, the same way git omits it from a tree.
    entry({ name: "rel/notes/inner/empty/", type: "5", mode: 0o755 }),
  ]);
}

const gitWorks = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/** The tree id of the same files on disk: git itself when present, else gitTreeHash. */
async function expectedTreeId(
  files: { path: string; data: Buffer; mode: number }[],
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-archive-tree-"));
  try {
    for (const file of files) {
      const full = path.join(dir, file.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.data);
      await chmod(full, file.mode);
    }
    if (gitWorks) {
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-c", "safe.directory=*", ...args], {
          cwd: dir,
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(result.stderr || result.stdout);
        return result.stdout.trim();
      };
      git("init");
      git("config", "core.filemode", "true");
      git("config", "core.autocrlf", "false");
      git("add", "-A");
      return git("write-tree");
    }
    return await gitTreeHash(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("computes the tree id of an archive before anything is written", async () => {
  expect(await gitTreeIdOfArchive(treeArchive(), limits.inflated)).toBe(
    await expectedTreeId(treeFiles),
  );
});

it("a changed byte changes the archive tree id", async () => {
  const base = await gitTreeIdOfArchive(treeArchive(), limits.inflated);
  const changed = treeFiles.map((file) =>
    file.path === "notes/readme.txt" ? { ...file, data: Buffer.from("tampered\n") } : file,
  );
  expect(await gitTreeIdOfArchive(treeArchive(changed), limits.inflated)).not.toBe(base);
});

it("an added file changes the archive tree id", async () => {
  const base = await gitTreeIdOfArchive(treeArchive(), limits.inflated);
  const extended = [...treeFiles, { path: "extra.txt", data: Buffer.from("extra\n"), mode: 0o644 }];
  const added = await gitTreeIdOfArchive(treeArchive(extended), limits.inflated);
  expect(added).not.toBe(base);
  expect(added).toBe(await expectedTreeId(extended));
});

it("hashes an executable archive entry as git mode 100755", async () => {
  const tool = [{ path: "tool", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }];
  const expected = await expectedTreeId(tool);
  expect(await gitTreeIdOfArchive(treeArchive(tool), limits.inflated)).toBe(expected);
  const plain = tool.map((file) => ({ ...file, mode: 0o644 }));
  const plainId = await gitTreeIdOfArchive(treeArchive(plain), limits.inflated);
  expect(plainId).not.toBe(expected);
  expect(plainId).toBe(await expectedTreeId(plain));
});

it("refuses a symbolic link entry when computing the tree id", async () => {
  await expect(
    gitTreeIdOfArchive(
      gzipTar([
        entry({ name: "rel/top.txt", data: Buffer.from("top\n"), mode: 0o644 }),
        entry({ name: "rel/link", type: "2", link: "rel/top.txt", mode: 0o777 }),
      ]),
      limits.inflated,
    ),
  ).rejects.toThrow("archive refused");
});

it.skipIf(process.platform === "win32")(
  "normalizes git archive modes instead of refusing them",
  async () => {
    const dest = await mkdtemp(path.join(tmpdir(), "hermes-modes-"));
    try {
      const archive = gzipTar([
        entry({ name: "pkg/dir/", type: "5", mode: 0o775 }),
        entry({ name: "pkg/dir/shared.txt", data: Buffer.from("shared\n"), mode: 0o664 }),
        entry({ name: "pkg/dir/tool.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o775 }),
        entry({ name: "pkg/everything.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o777 }),
        entry({ name: "pkg/world.txt", data: Buffer.from("world\n"), mode: 0o666 }),
        entry({ name: "pkg/plain.txt", data: Buffer.from("plain\n"), mode: 0o644 }),
        entry({ name: "pkg/exec.txt", data: Buffer.from("exec\n"), mode: 0o755 }),
      ]);
      await extractSourceArchive(archive, dest, limits);
      const mode = (relative: string) => statSync(path.join(dest, relative)).mode & 0o777;
      expect(mode("dir")).toBe(0o755);
      expect(mode("dir/shared.txt")).toBe(0o644);
      expect(mode("dir/tool.sh")).toBe(0o755);
      expect(mode("everything.sh")).toBe(0o755);
      expect(mode("world.txt")).toBe(0o644);
      expect(mode("plain.txt")).toBe(0o644);
      expect(mode("exec.txt")).toBe(0o755);
      expect(await readFile(path.join(dest, "dir", "shared.txt"), "utf8")).toBe("shared\n");
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "strips setuid, setgid and sticky bits from archive modes",
  async () => {
    const dest = await mkdtemp(path.join(tmpdir(), "hermes-special-modes-"));
    try {
      const archive = gzipTar([
        entry({ name: "pkg/setuid.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o4755 }),
        entry({ name: "pkg/sticky.txt", data: Buffer.from("sticky\n"), mode: 0o1666 }),
        entry({ name: "pkg/setgid.txt", data: Buffer.from("setgid\n"), mode: 0o2644 }),
      ]);
      await extractSourceArchive(archive, dest, limits);
      const mode = (relative: string) => statSync(path.join(dest, relative)).mode & 0o7777;
      expect(mode("setuid.sh")).toBe(0o755);
      expect(mode("sticky.txt")).toBe(0o644);
      expect(mode("setgid.txt")).toBe(0o644);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  },
);

it("still refuses link entries", async () => {
  const dest = await mkdtemp(path.join(tmpdir(), "hermes-links-"));
  try {
    await expect(
      extractSourceArchive(
        gzipTar([entry({ name: "pkg/link", type: "2", link: "pkg/plain.txt", mode: 0o777 })]),
        dest,
        limits,
      ),
    ).rejects.toThrow("archive refused");
    await expect(
      extractSourceArchive(
        gzipTar([entry({ name: "pkg/hard", type: "1", link: "pkg/plain.txt" })]),
        dest,
        limits,
      ),
    ).rejects.toThrow("archive refused");
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "writes the uv binary over a planted symlink without following it",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-uv-link-"));
    try {
      const elsewhere = path.join(root, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      const target = path.join(elsewhere, "uv");
      await writeFile(target, "original\n");
      const dir = path.join(root, "runtimes", "uv", "0.12.19");
      await mkdir(dir, { recursive: true });
      const destFile = path.join(dir, "uv");
      await symlink(target, destFile);
      const archive = gzipTar([
        entry({
          name: "uv-x86_64-unknown-linux-musl/uv",
          data: Buffer.from("#!/bin/sh\nbinary\n"),
          mode: 0o755,
        }),
      ]);
      await extractUvBinary(archive, destFile, 1024 * 1024);
      expect(lstatSync(destFile).isSymbolicLink()).toBe(false);
      expect(statSync(destFile).mode & 0o777).toBe(0o755);
      expect(await readFile(destFile, "utf8")).toBe("#!/bin/sh\nbinary\n");
      expect(await readFile(target, "utf8")).toBe("original\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
