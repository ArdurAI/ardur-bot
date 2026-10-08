import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { bundleDeviceListener } from "./bundle-services.mjs";

it("bundles the shared listener into JavaScript that Electron can load without a TypeScript loader", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "device-listener-bundle-"));
  try {
    const outfile = path.join(scratch, "node_modules/fixture/device-listener.mjs");
    const result = await bundleDeviceListener(outfile);
    expect(result.inputs).toContain("packages/host-runtime/src/device-listener.ts");
    const code = await readFile(outfile, "utf8");
    expect(code).not.toMatch(/from\s+["'][^"']+\.ts["']/);
    const checked = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { RemoteListener, allowedDeviceRequest } = await import(process.argv[1]); if (new RemoteListener().state().enabled || !allowedDeviceRequest("POST", "/device/request") || allowedDeviceRequest("POST", "/rpc/me")) process.exit(1);',
        new URL(`file://${outfile}`).href,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
