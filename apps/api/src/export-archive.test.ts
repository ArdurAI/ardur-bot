import type { HomeArchiveFile } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import { gzipArchive } from "./export-archive.js";

async function drain(file: HomeArchiveFile) {
  const stream = gzipArchive(
    (async function* () {
      yield file;
    })(),
  );
  for await (const _chunk of stream) {
    /* Consume and surface stream failures. */
  }
}
const content = (bytes: Uint8Array) =>
  (async function* () {
    yield bytes;
  })();
it.each([
  "../outside",
  "/absolute",
  "home/../outside",
  "home\\outside",
  "home\nforged",
  "home//file",
])("rejects unsafe archive path %s", async (path) => {
  await expect(drain({ path, size: 1, content: content(new Uint8Array([1])) })).rejects.toThrow(
    "Invalid archive path.",
  );
});
it.each([0, 2])(
  "fails rather than completing a truncated or growing file (%s bytes)",
  async (size) => {
    await expect(
      drain({ path: "file", size, content: content(new Uint8Array([1])) }),
    ).rejects.toThrow("File changed during export.");
  },
);
it("cancels the producer when the download is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = gzipArchive(
    {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("Must not start reading");
        },
      }),
    },
    controller.signal,
  );
  await expect(async () => {
    for await (const _chunk of stream) {
      /* drain */
    }
  }).rejects.toMatchObject({ name: "AbortError" });
});
