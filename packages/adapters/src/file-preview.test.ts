import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import { FILE_PREVIEW_SCRIPT, readFilePreview } from "./file-preview.js";

it("bounds a provider preview and refuses symlinks or traversal without reading their target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "file-preview-"));
  try {
    await writeFile(path.join(root, "large.txt"), "x".repeat(300_000));
    const preview = (file: string) =>
      execFileSync("python3", ["-c", FILE_PREVIEW_SCRIPT, root, file, "200000"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    expect(Buffer.from(preview("large.txt").toString().trim(), "base64").length).toBe(200_000);
    await symlink("large.txt", path.join(root, "link.txt"));
    expect(() => preview("link.txt")).toThrow();
    expect(() => preview("../large.txt")).toThrow();
    await writeFile(path.join(root, "binary.bin"), new Uint8Array([0, 255]));
    expect(Buffer.from(preview("binary.bin").toString().trim(), "base64")).toEqual(
      Buffer.from([0, 255]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects incomplete or oversized provider output", async () => {
  const provider: Pick<SandboxProvider, "execute"> = {
    async *execute() {
      yield { type: "stdout", data: "xxxx" };
    },
  };
  await expect(
    readFilePreview(provider, {} as ComputerRef, "/workspace", "file", {} as AdapterContext, 10),
  ).rejects.toThrow("unavailable");
  const oversized: Pick<SandboxProvider, "execute"> = {
    async *execute() {
      yield { type: "stdout", data: "x".repeat(100) };
      yield { type: "exit", code: 0 };
    },
  };
  await expect(
    readFilePreview(oversized, {} as ComputerRef, "/workspace", "file", {} as AdapterContext, 10),
  ).rejects.toThrow("limit");
});
