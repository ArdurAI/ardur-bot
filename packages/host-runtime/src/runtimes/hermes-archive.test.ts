import { lstatSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { extractSourceArchive, extractUvBinary } from "./hermes-archive.js";

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
