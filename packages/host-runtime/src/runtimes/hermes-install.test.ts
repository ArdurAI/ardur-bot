import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { probeHermesInstall } from "./hermes-install.js";

it("requires an explicit absolute pinned install", () => {
  expect(() => probeHermesInstall("relative-install")).toThrow("unavailable");
  if (process.platform === "win32") return;
  expect(() => probeHermesInstall(path.join(tmpdir(), "missing-install"))).toThrow("safety check");
});

it.skipIf(process.platform === "win32")("refuses a project dotenv by existence alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-probe-"));
  try {
    await mkdir(path.join(root, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(root, ".venv", "bin", "python"), "fixture");
    await writeFile(path.join(root, ".env"), "");
    expect(() => probeHermesInstall(root)).toThrow("safety check");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
