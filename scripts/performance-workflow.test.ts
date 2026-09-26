import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function stepScript(name: string) {
  const body = workflow
    .split(`      - name: ${name}\n`)[1]
    ?.split("\n      - ")[0]
    ?.split("        run: |\n")[1]
    ?.split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  if (!body) throw new Error(`Missing step ${name}`);
  return body;
}

const HARNESS = [
  "apps/web/playwright.performance.config.ts",
  "apps/web/e2e/shell-performance.spec.ts",
  "apps/web/e2e/performance-fixture.ts",
  "apps/web/src/lib/performance-proxy.test.tsx",
];
const PRODUCTION = "apps/web/src/components/ShellSkeleton.tsx";

async function prepareBase(decision: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "performance-base-"));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner");
  await mkdir(runnerTemp, { recursive: true });
  for (const file of [...HARNESS, PRODUCTION]) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), "candidate\n");
  }
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
git() {
  if [[ "$1" == worktree ]]; then
    for file in ${[...HARNESS, PRODUCTION].join(" ")}; do
      mkdir -p "$4/$(dirname "$file")"
      echo base > "$4/$file"
    done
  fi
}
node() { echo "$DECISION"; }
pnpm() { printf 'pnpm %s in %s\n' "$*" "$PWD"; }
${stepScript("Prepare independent base tree")}`,
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        DECISION: decision,
        BASE_SHA: "b".repeat(40),
        GITHUB_SHA: "a".repeat(40),
        RUNNER_SHA: "a".repeat(40),
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: path.join(root, "output"),
        GITHUB_WORKSPACE: workspace,
      },
    },
  );
  const base = path.join(runnerTemp, "performance-base");
  const read = (file: string) => readFile(path.join(base, file), "utf8");
  return { root, base, result, read };
}

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
  it("measures the base revision with the candidate's harness and its own production code", async () => {
    const measured = await prepareBase("measure");
    try {
      expect(measured.result.status, measured.result.stderr).toBe(0);
      for (const file of HARNESS) expect(await measured.read(file), file).toBe("candidate\n");
      expect(await measured.read(PRODUCTION)).toBe("base\n");
      expect(measured.result.stdout).toContain(
        `pnpm install --frozen-lockfile in ${measured.base}`,
      );
    } finally {
      await rm(measured.root, { recursive: true, force: true });
    }
    const pending = await prepareBase("pending:benchmark-runner-incompatible");
    try {
      expect(pending.result.status, pending.result.stderr).toBe(0);
      for (const file of HARNESS) expect(await pending.read(file), file).toBe("base\n");
      expect(pending.result.stdout).not.toContain("pnpm install");
    } finally {
      await rm(pending.root, { recursive: true, force: true });
    }
  });
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
