import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/performance.yml", import.meta.url),
  "utf8",
);
const step = workflow
  .split("      - name: Measure current revision and retain traces\n")[1]
  ?.split("\n      - ")[0];
const script = step
  ?.split("        run: |\n")[1]
  ?.split("\n")
  .map((line) => line.slice(10))
  .join("\n");
if (!script) throw new Error("Missing candidate measurement script");

function measure(bundleStatus: number, failPhase = "") {
  return spawnSync(
    "bash",
    [
      "-c",
      `
node() { printf 'node %s\n' "$*"; return "$BUNDLE_STATUS"; }
pnpm() {
  printf 'pnpm %s\n' "$*"
  if [[ -n "$FAIL_PHASE" && "$*" == *"$FAIL_PHASE"* ]]; then return 7; fi
}
${script}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, BUNDLE_STATUS: String(bundleStatus), FAIL_PHASE: failPhase },
    },
  );
}

describe("advisory performance workflow", () => {
  it.each([0, 1, 2])(
    "collects candidate browser measurements after bundle verdict %s",
    (status) => {
      const result = measure(status);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "pnpm --filter @ardurbot/web exec playwright test --config playwright.performance.config.ts",
      );
      if (status) expect(result.stdout).toContain("::warning");
    },
  );
  it("does not mask unexpected command failures", () => {
    const result = measure(7);
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("playwright test");
  });
  it.each(["perf:proxy", "build"])("does not mask a failed %s prerequisite", (phase) => {
    const result = measure(0, phase);
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("playwright test");
  });
});
