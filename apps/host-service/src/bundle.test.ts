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
    expect(await readdir(directory)).toEqual(["host-service.cjs"]);
    expect(
      Object.keys(metadata.inputs).some((file) => /prisma|pi-runtime|pi-ai|koffi/i.test(file)),
    ).toBe(false);
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
