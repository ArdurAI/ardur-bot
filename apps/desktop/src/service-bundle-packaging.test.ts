import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serviceBundlePlan } from "../scripts/bundle-services.mjs";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  main: string;
  scripts: { build: string };
  build: {
    extraMetadata: { main: string };
    extraResources: { from: string; to: string }[];
  };
};

const workflow = readFileSync(
  new URL("../../../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);

describe("packaged API and worker bundles", () => {
  it("builds api.mjs, worker.mjs, and the Prisma runtime into packaged resources", () => {
    const plan = serviceBundlePlan();
    expect(plan.format).toBe("esm");
    expect(plan.platform).toBe("node");
    expect(plan.target).toBe("node22");
    expect(plan.entries).toEqual(["api.mjs", "worker.mjs"]);
    expect(plan.loader).toBe("services-loader.mjs");
    expect(plan.prismaRuntime).toEqual([
      "modules/@prisma/client/runtime/client.js",
      "modules/@prisma/client/runtime/client.mjs",
      "modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs",
      "modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs",
    ]);
    expect(plan.extraResource).toEqual({ from: "build/services", to: "services" });
    expect(packageJson.build.extraResources).toContainEqual(plan.extraResource);
    expect(packageJson.scripts.build).toContain("bundle-services.mjs");
    const bundleStep = workflow.indexOf("bundle-services.mjs");
    const packageStep = workflow.indexOf("electron-builder");
    expect(bundleStep).toBeGreaterThan(-1);
    expect(packageStep).toBeGreaterThan(bundleStep);
    expect(workflow.indexOf("pnpm db:generate")).toBeGreaterThan(-1);
    expect(workflow.indexOf("pnpm db:generate")).toBeLessThan(bundleStep);
    expect(packageJson.main).toBe("dist/desktop-loader.mjs");
    expect(packageJson.build.extraMetadata.main).toBe("dist/desktop-loader.mjs");
    const loader = readFileSync(
      path.resolve(import.meta.dirname, "../scripts/desktop-loader.mjs"),
      "utf8",
    );
    expect(loader).toContain("stripTypeScriptTypes");
    expect(loader).toContain('await import("./main.js")');
  });
});
