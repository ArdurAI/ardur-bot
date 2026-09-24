import { crc32, inflateRawSync } from "node:zlib";
import type { BundleFile } from "./files.js";
import { BUNDLE_MAX_BYTES, bundlePath, validateBundleFiles } from "./files.js";

const invalid = () => new Error("Choose a valid ZIP, MCPB, or DXT bundle.");
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Reads bounded single-disk ZIP archives. Extraction never delegates paths to an archiver. */
export function readBundleZip(input: Uint8Array): BundleFile[] {
  const zip = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (zip.length < 22 || zip.length > BUNDLE_MAX_BYTES) throw invalid();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw invalid();
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const start = zip.readUInt32LE(end + 16);
  if (count !== zip.readUInt16LE(end + 8) || count > 10_000 || start + size !== end)
    throw invalid();
  let cursor = start;
  let total = 0;
  const files: BundleFile[] = [];
  const ranges: [number, number][] = [];
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = zip.readUInt16LE(cursor + 8);
    const compression = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const length = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const local = zip.readUInt32LE(cursor + 42);
    if (
      flags & 0x2041 ||
      ![0, 8].includes(compression) ||
      zip.readUInt16LE(cursor + 34) ||
      [compressed, length, local].includes(0xffffffff)
    )
      throw invalid();
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength) throw invalid();
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    try {
      name = decoder.decode(rawName);
    } catch {
      throw invalid();
    }
    const directory = name.endsWith("/");
    const filePath = bundlePath(directory ? name.slice(0, -1) : name);
    if (names.has(filePath.toLowerCase())) throw invalid();
    names.add(filePath.toLowerCase());
    const kind = mode & 0o170000;
    if (kind && kind !== (directory ? 0o040000 : 0o100000))
      throw new Error("Bundle links and special files are not supported.");
    if (
      local + 30 > start ||
      zip.readUInt32LE(local) !== 0x04034b50 ||
      zip.readUInt16LE(local + 6) !== flags ||
      zip.readUInt16LE(local + 8) !== compression
    )
      throw invalid();
    const localNameLength = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + zip.readUInt16LE(local + 28);
    const dataEnd = dataStart + compressed;
    if (dataEnd > start || !zip.subarray(local + 30, local + 30 + localNameLength).equals(rawName))
      throw invalid();
    if (
      !(flags & 8) &&
      (zip.readUInt32LE(local + 14) !== crc ||
        zip.readUInt32LE(local + 18) !== compressed ||
        zip.readUInt32LE(local + 22) !== length)
    )
      throw invalid();
    ranges.push([local, dataEnd]);
    total += length;
    if (length > BUNDLE_MAX_BYTES || total > BUNDLE_MAX_BYTES)
      throw new Error("The unpacked bundle is too large.");
    const packed = zip.subarray(dataStart, dataEnd);
    let bytes: Buffer;
    try {
      bytes =
        compression === 0
          ? Buffer.from(packed)
          : inflateRawSync(packed, { maxOutputLength: Math.max(1, length) });
    } catch {
      throw invalid();
    }
    if (bytes.length !== length || crc32(bytes) !== crc || (directory && length !== 0))
      throw invalid();
    if (!directory) files.push({ path: filePath, bytes, executable: Boolean(mode & 0o111) });
    cursor = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1]![1]))
    throw invalid();
  validateBundleFiles(files);
  return files;
}
