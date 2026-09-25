import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { embeddedPostgresPackageName, stagePlan } from "../scripts/stage-embedded-postgres.mjs";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  build: { extraResources: { from: string; to: string; filter?: string[] }[] };
};

const workflow = readFileSync(
  new URL("../../../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);

const matrix = [
  { platform: "darwin", arch: "arm64", packageName: "@embedded-postgres/darwin-arm64" },
  { platform: "darwin", arch: "x64", packageName: "@embedded-postgres/darwin-x64" },
  { platform: "linux", arch: "x64", packageName: "@embedded-postgres/linux-x64" },
  { platform: "linux", arch: "arm64", packageName: "@embedded-postgres/linux-arm64" },
  { platform: "win32", arch: "x64", packageName: "@embedded-postgres/windows-x64" },
] as const;

describe("embedded Postgres packaging", () => {
  it("stages one platform binary for each release architecture and not the wrapper", () => {
    for (const target of matrix) {
      expect(embeddedPostgresPackageName(target.platform, target.arch)).toBe(target.packageName);
      const plan = stagePlan(target.platform, target.arch);
      expect(plan.packageName).toBe(target.packageName);
      expect(plan.packageName).not.toBe("embedded-postgres");
      expect(plan.destination).toBe(
        path.join("build", "postgres-modules", "node_modules", target.packageName),
      );
    }
    const postgresResources = packageJson.build.extraResources.filter(
      (resource) =>
        resource.from.includes("postgres") ||
        resource.to.includes("postgres") ||
        resource.from.includes("embedded-postgres"),
    );
    expect(postgresResources).toEqual([{ from: "build/postgres-modules", to: "postgres-modules" }]);
    expect(JSON.stringify(packageJson.build.extraResources)).not.toContain(
      "node_modules/embedded-postgres",
    );
    expect(workflow).toContain("stage-embedded-postgres.mjs");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
  });
});
