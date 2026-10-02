import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleHostGuardrails } from "./bundle-services.mjs";

describe("desktop host guardrails packaging", () => {
  it("loads the emitted JavaScript under node_modules without a TypeScript loader", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desktop-guardrails-"));
    try {
      const outfile = path.join(root, "node_modules/fixture/host-guardrails.mjs");
      await bundleHostGuardrails(outfile);
      const code = await readFile(outfile, "utf8");
      expect(code).not.toMatch(/from\s+["'][^"']+\.ts["']/);
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const {GUARDED_DATA_DIR_CHILDREN, knownLoopbackGuardPorts} = await import(process.argv[1]); if (!GUARDED_DATA_DIR_CHILDREN.includes("homes") || JSON.stringify(knownLoopbackGuardPorts({DATABASE_URL:"postgres://localhost:4567/fixture"})) !== "[4567]") process.exit(1);',
          new URL(`file://${outfile}`).href,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      for (const name of ["host-service.ts", "host-service-ipc.ts"]) {
        const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
        expect(source).toContain('from "./desktop-guardrails.js"');
        expect(source).not.toContain('from "@ardurbot/host-runtime/host-guardrails"');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
