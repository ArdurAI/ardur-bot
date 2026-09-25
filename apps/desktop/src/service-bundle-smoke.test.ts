import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { smokeSkipReason } from "../scripts/service-bundle-smoke.mjs";

const script = fileURLToPath(new URL("../scripts/service-bundle-smoke.mjs", import.meta.url));

describe("service bundle smoke", () => {
  it("skips with a stated reason when no Postgres service is configured", () => {
    expect(smokeSkipReason({})).toMatch(/No Postgres service is configured/);
    expect(smokeSkipReason({ ARDURBOT_SMOKE_DATABASE_URL: "postgres://fixture" })).toBeNull();
    expect(smokeSkipReason({ ARDURBOT_SMOKE_EMBEDDED: "1" })).toBeNull();
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/No Postgres service is configured/);
  });

  it("resolves the smoke script from the desktop scripts directory", () => {
    expect(path.basename(script)).toBe("service-bundle-smoke.mjs");
  });
});
