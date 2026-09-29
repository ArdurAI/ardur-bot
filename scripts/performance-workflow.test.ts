import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO = fileURLToPath(new URL("..", import.meta.url));
const timingReport = (kind: string, metrics: Record<string, number>) => ({
  kind,
  machine: { platform: "fixture" },
  metrics,
});

async function compareTimings({ dependencies = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "performance-timings-"));
  const runnerTemp = path.join(root, "runner");
  await mkdir(path.join(root, ".context/performance"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await mkdir(runnerTemp);
  // A copy, not a link: the script runs its command line only when started by its own path.
  await copyFile(
    path.join(REPO, "scripts/performance-budget.mjs"),
    path.join(root, "scripts/performance-budget.mjs"),
  );
  if (dependencies) await symlink(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
  const proxy = timingReport("offline-proxy", { shellPrepareMs: 100, submitToFirstTokenMs: 50 });
  const reports = {
    [path.join(runnerTemp, "proxy-before.json")]: proxy,
    [path.join(root, ".context/performance/proxy-after.json")]: proxy,
    [path.join(runnerTemp, "browser-before.json")]: timingReport("browser-proxy", {
      coldShellPaintMs: 400,
      submitToFirstTokenMs: 200,
    }),
    [path.join(root, ".context/performance/browser.json")]: timingReport("browser-proxy", {
      coldShellPaintMs: 900,
      submitToFirstTokenMs: 600,
    }),
  };
  for (const [file, report] of Object.entries(reports))
    await writeFile(file, `${JSON.stringify(report)}\n`);
  try {
    // GitHub runs `shell: bash` steps with errexit and pipefail.
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", stepScript("Warn on timing regressions")],
      { cwd: root, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: runnerTemp } },
    );
    const annotations = (output: string) =>
      output.split("\n").filter((line) => line.startsWith("::warning"));
    return { result, stdout: annotations(result.stdout), stderr: annotations(result.stderr) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("advisory performance workflow", () => {
  it("annotates each slower metric and keeps incomplete evidence advisory", async () => {
    const { result, stdout, stderr } = await compareTimings();
    expect(result.status, result.stderr).toBe(0);
    expect(stdout).toEqual([
      "::warning title=Performance baseline::Incomplete proxy evidence; timings remain advisory.",
      "::warning title=Performance baseline::Incomplete browser evidence; timings remain advisory.",
    ]);
    // The unchanged proxy pair adds nothing; each slower browser metric gets its own annotation.
    expect(stderr).toEqual([
      "::warning title=Performance budget::browser-proxy coldShellPaintMs exceeds the proposed 5% and 25 ms advisory margin.",
      "::warning title=Performance budget::browser-proxy submitToFirstTokenMs exceeds the proposed 5% and 25 ms advisory margin.",
    ]);
  });
  it("fails the timing step when the comparison cannot run", async () => {
    const { result } = await compareTimings({ dependencies: false });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("::warning");
  });
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
