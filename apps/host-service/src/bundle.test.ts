import { fork } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
// The build is a JavaScript entry point so desktop packaging never needs a TS loader.
// @ts-expect-error Build script is intentionally JavaScript.
import { bundleHostService } from "../build.mjs";

it("builds one relocatable JavaScript file without server modules or workspace imports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "host-bundle-"));
  try {
    const file = path.join(directory, "host-service.cjs");
    const metadata = await bundleHostService(file);
    const entries = await readdir(directory);
    expect(entries.filter((name) => /\.[cm]?js$/.test(name))).toEqual(["host-service.cjs"]);
    expect(entries.sort()).toEqual(
      metadata.native.files.length ? ["host-service.cjs", "native"] : ["host-service.cjs"],
    );
    if (metadata.native.files.length) {
      expect(await readdir(path.join(directory, "native"), { recursive: true })).toEqual(
        expect.arrayContaining(
          metadata.native.files.map((file: string) => path.normalize(file.slice("native/".length))),
        ),
      );
      for (const native of metadata.native.files) {
        expect(native).toMatch(/^native\/win_(?:x64|arm64|ia32)\/koffi\.node$/);
        expect((await readFile(path.join(directory, native))).length).toBeGreaterThan(0);
      }
    } else {
      expect(metadata.native.skipped).toHaveLength(3);
      for (const skipped of metadata.native.skipped)
        expect(skipped.reason).toContain(
          "is installed; Windows writes remain refused for this target.",
        );
    }
    expect(
      Object.keys(metadata.inputs).some((file) => /prisma|pi-runtime|pi-ai|koffi/i.test(file)),
    ).toBe(false);
    expect(
      Object.keys(metadata.inputs).some((file) =>
        file.endsWith("host-runtime/src/board/runner.ts"),
      ),
    ).toBe(true);
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(/(?:require\(|from\s*)["'][^"']*(?:@ardurbot|\.ts["'])/);
    expect(Buffer.byteLength(source)).toBeLessThan(1_500_000);
    const child = fork(file, [], {
      cwd: directory,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    child.send({ type: "stop" });
    expect(await closed).toBe(0);
    expect(output).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
