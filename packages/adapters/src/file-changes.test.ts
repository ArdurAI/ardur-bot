import type { ThreadEvents } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { fileChangeText, recordFileChange } from "./file-changes.js";

it("bounds and redacts recorded file content without claiming a binary before-image", async () => {
  expect(
    fileChangeText(new TextEncoder().encode("key=fake-sensitive-value"), ["fake-sensitive-value"]),
  ).not.toContain("fake-sensitive-value");
  expect(fileChangeText(new Uint8Array([0, 1]))).toBeNull();
  expect(fileChangeText(new Uint8Array(128 * 1024 + 1).fill(97))).toBeNull();
  const append = vi.fn(async () => ({}));
  await recordFileChange(
    { append } as unknown as ThreadEvents,
    { id: "run", botId: "bot", spaceId: "space", threadId: "thread" },
    {
      computerId: "computer",
      path: "main.ts",
      source: "artifact",
      before: null,
      after: "contents",
    },
    [],
  );
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: "run",
      type: "computer.file.changed",
      payload: expect.objectContaining({ source: "artifact", before: null, after: "contents" }),
    }),
  );
});
