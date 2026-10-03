import type { ThreadEvents } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { beforeFileChange, fileChangeText, recordFileChange } from "./file-changes.js";

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

it.each([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".docker/config.json",
  ".config/gh/hosts.yml",
  ".terraform.d/credentials",
  ".terraform.d/credentials.tfrc.json",
  "fixture\\.config\\gh\\hosts.yml",
  "fixture/.netrc",
  ".env",
  ".env.local",
  "project/.env",
  "project\\\\.env",
  ".ssh/config",
  ".aws/credentials",
  ".kube/config",
  ".gnupg/private-keys-v1.d/key",
  "/proc/123/environ",
])("never reads or records snapshots for %s", async (path) => {
  const readFile = vi.fn(async () => new TextEncoder().encode("unmanaged fixture credential"));
  expect(
    await beforeFileChange({ readFile } as never, {} as never, path, {} as never, []),
  ).toBeNull();
  expect(readFile).not.toHaveBeenCalled();
  const append = vi.fn();
  await recordFileChange(
    { append } as never,
    { spaceId: "space", threadId: "thread", botId: "bot", id: "run" },
    { computerId: "computer", path, source: "tool", before: "old fixture", after: "new fixture" },
    [],
  );
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ path, before: null, after: null }),
    }),
  );
});

it("retains ordinary source snapshots even when the filename mentions a credential name", async () => {
  const readFile = vi.fn(async () => new TextEncoder().encode("public source"));
  expect(
    await beforeFileChange({ readFile } as never, {} as never, "src/token.ts", {} as never, []),
  ).toBe("public source");
  expect(readFile).toHaveBeenCalledOnce();
  const append = vi.fn();
  await recordFileChange(
    { append } as never,
    { spaceId: "space", threadId: "thread", botId: "bot", id: "run" },
    { computerId: "computer", path: "src/token.ts", source: "tool", before: "old", after: "new" },
    [],
  );
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ before: "old", after: "new" }),
    }),
  );
});
