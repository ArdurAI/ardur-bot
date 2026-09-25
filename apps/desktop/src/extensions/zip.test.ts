import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readBundleZip } from "./zip.js";

function zipFile(name: string, text: string, mode = 0o100644) {
  const data = Buffer.from(text),
    packed = deflateRawSync(data),
    filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}
describe("bounded ZIP decoding", () => {
  it("reads deflated files with integrity and executable metadata", () => {
    const files = readBundleZip(zipFile("server/main.js", "fixture", 0o100755));
    expect(files[0]?.path).toBe("server/main.js");
    expect(Buffer.from(files[0]!.bytes).toString()).toBe("fixture");
    expect(files[0]?.executable).toBe(true);
  });
  it("rejects traversal, links, truncation, corruption and inconsistent sizes", () => {
    expect(() => readBundleZip(zipFile("../escape", "x"))).toThrow();
    expect(() => readBundleZip(zipFile("link", "target", 0o120777))).toThrow();
    const valid = zipFile("file", "fixture");
    expect(() => readBundleZip(valid.subarray(0, -1))).toThrow();
    valid[34] = 0xff;
    expect(() => readBundleZip(valid)).toThrow();
  });
});
