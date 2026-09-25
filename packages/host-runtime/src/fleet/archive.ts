import type { PortableFile } from "@ardurbot/adapter-kit";

export const MAX_FLEET_ARCHIVE = 64 * 1024 * 1024;
export function fleetPath(value: string) {
  if (value === "." || value === "") return "";
  if (
    value.startsWith("/") ||
    /[\0\r\n\\]/.test(value) ||
    value.split("/").some((part) => ["", ".", "..", ".ardurbot-runtime"].includes(part))
  )
    throw new Error("Path escapes computer.");
  return value;
}
export function* readFleetArchive(bytes: Uint8Array): Iterable<PortableFile> {
  if (bytes.length > MAX_FLEET_ARCHIVE) throw new Error("Checkpoint exceeds limit.");
  const archive = Buffer.from(bytes);
  const seen = new Set<string>();
  let offset = 0;
  for (; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const text = (from: number, length: number) =>
      header
        .subarray(from, from + length)
        .toString()
        .replace(/\0.*$/s, "");
    const number = (from: number, length: number) => Number.parseInt(text(from, length).trim(), 8);
    const expected = number(148, 8);
    const actual = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    const size = number(124, 12);
    const name = fleetPath([text(345, 155), text(0, 100)].filter(Boolean).join("/"));
    if (
      actual !== expected ||
      !name ||
      !["0", ""].includes(text(156, 1)) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 16 * 1024 * 1024 ||
      offset + 512 + size > archive.length ||
      seen.has(name)
    )
      throw new Error("Invalid checkpoint.");
    seen.add(name);
    yield {
      path: name,
      content: new Uint8Array(archive.subarray(offset + 512, offset + 512 + size)),
      executable: (number(100, 8) & 0o111) !== 0,
    };
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Incomplete checkpoint.");
}
export async function writeFleetArchive(files: AsyncIterable<PortableFile>) {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  let size = 1024;
  for await (const file of files) {
    const name = fleetPath(file.path);
    if (!name || seen.has(name) || file.content.length > 16 * 1024 * 1024)
      throw new Error("Invalid checkpoint file.");
    seen.add(name);
    const encoded = Buffer.from(name);
    const split = name.lastIndexOf("/");
    const prefix = encoded.length > 100 ? name.slice(0, split) : "";
    const leaf = encoded.length > 100 ? name.slice(split + 1) : name;
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100)
      throw new Error("Checkpoint path exceeds limit.");
    const header = Buffer.alloc(512);
    header.write(leaf, 0, 100);
    header.write(prefix, 345, 155);
    const octal = (value: number, offset: number, width: number) =>
      header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width);
    octal(file.executable ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(file.content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    octal(
      header.reduce((sum, byte) => sum + byte, 0),
      148,
      8,
    );
    const padding = Buffer.alloc((512 - (file.content.length % 512)) % 512);
    size += 512 + file.content.length + padding.length;
    if (size > MAX_FLEET_ARCHIVE || seen.size > 10000) throw new Error("Checkpoint exceeds limit.");
    chunks.push(header, Buffer.from(file.content), padding);
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
