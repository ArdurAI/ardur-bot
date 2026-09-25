import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { HomeArchiveFile } from "@ardurbot/adapter-kit";

export function archiveFile(path: string, value: unknown): HomeArchiveFile {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  return {
    path,
    size: bytes.length,
    content: (async function* () {
      yield bytes;
    })(),
  };
}

/** A backpressured POSIX tar stream. PAX paths preserve long and Unicode filenames. */
export function gzipArchive(files: AsyncIterable<HomeArchiveFile>, signal?: AbortSignal) {
  const compressed = createGzip();
  void pipeline(Readable.from(tar(files), { objectMode: false }), compressed, { signal }).catch(
    () => {},
  );
  return compressed;
}

async function* tar(files: AsyncIterable<HomeArchiveFile>) {
  for await (const file of files) {
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      /[\0\r\n]/.test(file.path) ||
      file.path.split("/").some((part) => part === ".." || part === "." || !part)
    )
      throw new Error("Invalid archive path.");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 0o77777777777)
      throw new Error("Invalid archive file size.");
    const longPath = Buffer.byteLength(file.path) > 100 || /[^\x20-\x7e]/.test(file.path);
    if (longPath) {
      const record = ` path=${file.path}\n`;
      let length = Buffer.byteLength(record) + 1;
      while (Buffer.byteLength(record) + String(length).length !== length)
        length = Buffer.byteLength(record) + String(length).length;
      const bytes = Buffer.from(`${length}${record}`);
      yield header("PaxHeader", bytes.length, 0o600, "x");
      yield bytes;
      yield Buffer.alloc((512 - (bytes.length % 512)) % 512);
    }
    yield header(longPath ? "file" : file.path, file.size, file.executable ? 0o700 : 0o600);
    let count = 0;
    for await (const chunk of file.content) {
      count += chunk.byteLength;
      if (count > file.size) throw new Error("File changed during export. Try again.");
      yield chunk;
    }
    if (count !== file.size) throw new Error("File changed during export. Try again.");
    yield Buffer.alloc((512 - (count % 512)) % 512);
  }
  yield Buffer.alloc(1024);
}

function header(name: string, size: number, mode: number, type = "0") {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  const octal = (value: number, offset: number, width: number) =>
    block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  block.fill(32, 148, 156);
  block.write(type, 156, 1);
  block.write("ustar\0", 257, 6);
  block.write("00", 263, 2);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}
