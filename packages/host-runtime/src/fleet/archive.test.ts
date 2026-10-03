import type { PortableFile } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  fleetArchiveBatches,
  MAX_FLEET_ARCHIVE,
  readFleetArchive,
  writeFleetArchive,
} from "./archive.js";

async function* from(files: PortableFile[]) {
  yield* files;
}
async function collect(files: PortableFile[]) {
  const batches: PortableFile[][] = [];
  for await (const batch of fleetArchiveBatches(from(files))) batches.push(batch);
  return batches;
}
const file = (path: string, bytes: number): PortableFile => ({
  path,
  content: new Uint8Array(bytes),
  executable: false,
});

// 2026-09-30: a Team workspace of 433 MB in 26,844 files could no longer be restored because
// one archive is capped at 64 MiB and 10,000 files; the Team computer stayed down.
describe("restoring a workspace larger than one archive", () => {
  it("splits by size so every group writes as a valid archive, and keeps every file once", async () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      file(`tasks/t${i}/data.bin`, 15 * 1024 * 1024),
    );
    const batches = await collect(files);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((f) => f.path)).toEqual(files.map((f) => f.path));
    for (const batch of batches) {
      const archive = await writeFleetArchive(from(batch));
      expect(archive.length).toBeLessThanOrEqual(MAX_FLEET_ARCHIVE);
      expect([...readFleetArchive(archive)].map((f) => f.path)).toEqual(batch.map((f) => f.path));
    }
  });

  it("splits by file count", async () => {
    const files = Array.from({ length: 25_000 }, (_, i) => file(`tasks/f${i}.txt`, 10));
    const batches = await collect(files);
    expect(batches.map((b) => b.length)).toEqual([10_000, 10_000, 5_000]);
    for (const batch of batches)
      await expect(writeFleetArchive(from(batch))).resolves.toBeDefined();
  });

  it("keeps a small workspace in one group, and still refuses a path repeated across groups", async () => {
    expect(await collect([file("a.txt", 1), file("b.txt", 1)])).toHaveLength(1);
    const repeated = [
      ...Array.from({ length: 10_000 }, (_, i) => file(`f${i}.txt`, 1)),
      file("f0.txt", 1),
    ];
    await expect(collect(repeated)).rejects.toThrow("Invalid checkpoint file.");
  });
});
