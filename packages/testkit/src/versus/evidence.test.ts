import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePerformanceEvidenceReport } from "../performance-report.js";
import { gradeOutcome } from "../scoreboard/graders/outcome.js";
import { contentDigest, SCOREBOARD_MANIFEST } from "../scoreboard/manifest.js";
import { DEPARTMENT_TASKS, getTask } from "../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../scoreboard/tasks/reference.js";
import { parseArguments, runCli } from "./cli.js";
import { validateEvidenceDirectory, writeEvidence } from "./evidence.js";
import { blindPacket, gradeBlind } from "./grading.js";
import * as provenance from "./provenance.js";
import { inspectBuild, inspectHermes } from "./provenance.js";
import { planPairs } from "./scheduler.js";
import { runOfflineSelfTest, selfTestBudget } from "./self-test.js";

// Inspect real Git objects and source bytes in a self-contained fixture. The
// checkout running these offline tests may have no parent or research baseline.
vi.mock("./manifest.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RESEARCH_BASELINE: "refs/tags/research-baseline",
}));
const inspectRepositoryBuild = inspectBuild;

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of directories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "versus-evidence-test-"));
  directories.push(root);
  return root;
}
describe("zero-inference dry run", () => {
  let repository: string;
  beforeAll(async () => {
    repository = await fs.mkdtemp(path.join(tmpdir(), "versus-build-fixture-"));
    const sources = path.join(repository, "packages/testkit/src/versus");
    await fs.mkdir(sources, { recursive: true });
    await fs.writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const source = path.join(sources, "fixture.ts");
    await fs.writeFile(source, 'export const revision = "baseline";\n');
    const git = (...args: string[]) =>
      childProcess.execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: repository, stdio: "ignore" },
      );
    git("init");
    git("add", ".");
    git("commit", "-m", "Research baseline fixture");
    git("update-ref", "refs/tags/research-baseline", "HEAD");
    await fs.writeFile(source, 'export const revision = "candidate";\n');
    git("commit", "-am", "Candidate fixture");
  });
  beforeEach(() => {
    vi.spyOn(provenance, "inspectBuild").mockImplementation(() =>
      inspectRepositoryBuild(repository),
    );
  });
  afterAll(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  it("labels non-generating qualification separately and forbids trial observations", async () => {
    const out = await directory();
    const input = {
      mode: "qualification" as const,
      build: await inspectBuild(),
      hermes: (await inspectHermes()).identity,
      plan: planPairs(selfTestBudget().cohort),
      budget: selfTestBudget(),
      trials: [],
      results: [],
      prerequisites: ["Hard resource enforcement remains unqualified"],
      launchPlan: { startsProducts: false },
      protocolResults: { productLaunches: 0, modelCalls: 0, status: "blocked" },
    };
    await writeEvidence(out, input);
    await validateEvidenceDirectory(out);
    const manifest = JSON.parse(await fs.readFile(path.join(out, "versus-manifest.json"), "utf8"));
    expect(manifest.mode).toBe("qualification");
    const checksums = JSON.parse(await fs.readFile(path.join(out, "checksums.json"), "utf8"));
    expect(checksums.map((item: { name: string }) => item.name)).toContain("qualification.json");
    expect(checksums.map((item: { name: string }) => item.name)).toContain("canary-budget.json");
    await expect(writeEvidence(out, { ...input, trials: [{} as never] })).rejects.toThrow(
      "cannot contain product trials",
    );
  });
  it("rejects accidental live invocation before any product startup", async () => {
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Unexpected subprocess");
    });
    expect(parseArguments([]).mode).toBe("help");
    expect(parseArguments(["--out", "out"]).mode).toBe("dry-run");
    expect(() => parseArguments(["--dry-run", "--live"])).toThrow();
    await expect(runCli(["--live"])).rejects.toThrow("--budget");
    expect(() => parseArguments(["--self-test", "--budget", "budget.json"])).toThrow(
      "virtual budget",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it("rejects a wrong live revision without opening a socket or spawning a product", async () => {
    const root = await directory();
    const budget = path.join(root, "budget.json");
    await fs.writeFile(budget, JSON.stringify(selfTestBudget()));
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
      throw new Error("Unexpected socket");
    });
    const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("Unexpected network");
    });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Unexpected product");
    });
    await expect(
      runCli([
        "--live",
        "--budget",
        budget,
        "--expected-hermes-revision",
        "0".repeat(40),
        "--hermes-executable",
        path.join(root, "absent-executable"),
      ]),
    ).rejects.toThrow("revision mismatch");
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it("opens no sockets, spawns no product, reads no forbidden state and preserves every empty schema entry", async () => {
    const out = await directory();
    const originalRead = fs.readFile;
    const reads: string[] = [];
    vi.spyOn(fs, "readFile").mockImplementation((async (
      file: fs.FileHandle | Parameters<typeof fs.readFile>[0],
      options?: unknown,
    ) => {
      const filename = String(file);
      reads.push(filename);
      if (
        /(^|\/)(auth\.json|\.env(?:\.[^/]*)?|tokens|cookies|sessions|histories|caches)(\/|$)/.test(
          filename,
        )
      )
        throw new Error("Forbidden state read");
      return originalRead(file as Parameters<typeof fs.readFile>[0], options as never);
    }) as typeof fs.readFile);
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
      throw new Error("Unexpected socket");
    });
    const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("Unexpected network");
    });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Unexpected product");
    });
    expect(await runCli(["--dry-run", "--out", out])).toBe(0);
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    const parsed = parsePerformanceEvidenceReport(
      JSON.parse(await fs.readFile(path.join(out, "ardur-schema3.json"), "utf8")),
      "dry",
    );
    expect(parsed.manifestHash).toBe(contentDigest(SCOREBOARD_MANIFEST));
    expect(parsed.tasks).toHaveLength(24);
    expect(
      parsed.tasks.every((task) => task.status === "incomplete" && task.trials.length === 0),
    ).toBe(true);
    expect(parsed.traces).toEqual([]);
    expect(parsed.usage).toEqual([]);
    expect(
      parsed.metrics.every(
        (metric) => metric.observations.length === 0 && metric.missingReason === "not-measured",
      ),
    ).toBe(true);
    expect(reads.some((file) => file.includes("versus"))).toBe(true);
    await validateEvidenceDirectory(out, (await inspectBuild()).build);
  });
  it("refuses registry, build, fixture, tier and raw-artifact forgeries", async () => {
    const out = await directory();
    await runCli(["--dry-run", "--out", out]);
    const filename = path.join(out, "ardur-schema3.json");
    const original = JSON.parse(await fs.readFile(filename, "utf8"));
    const build = (await inspectBuild()).build;
    for (const mutate of [
      (report: typeof original) => {
        report.manifestHash = "a".repeat(64);
      },
      (report: typeof original) => {
        report.build.commit = "a".repeat(40);
      },
      (report: typeof original) => {
        report.hashes.fixture = "b".repeat(64);
      },
      (report: typeof original) => {
        report.scenario.tier = "T3";
        report.scenario.timingMode = "live";
      },
      (report: typeof original) => {
        report.artifacts[0].bytes++;
      },
    ]) {
      const forged = structuredClone(original);
      mutate(forged);
      await fs.writeFile(filename, JSON.stringify(forged));
      await expect(validateEvidenceDirectory(out, build)).rejects.toThrow();
    }
    await fs.writeFile(filename, JSON.stringify(original));
    await expect(runCli(["--dry-run", "--out", out])).rejects.toThrow("empty");
  });
  it("keeps history cohorts separate and rejects a missing usage category rewritten as zero", async () => {
    const out = await directory();
    const build = await inspectBuild();
    const plan = planPairs({
      ...selfTestBudget().cohort,
      tasks: ["task-01"],
      repetitions: 2,
      history: "balanced",
    });
    const tested = await runOfflineSelfTest(plan, build.graderHash);
    expect(
      tested.protocolResults.contracts.every((contract) =>
        contract.negativeControls.some(
          (control) => control.id === "reply-redaction" && control.rejected,
        ),
      ),
    ).toBe(true);
    for (const trial of tested.trials)
      for (const event of trial.events)
        if (event.kind === "usage")
          (event.data.usage as Record<string, unknown>).cacheWriteInput = null;
    await writeEvidence(out, {
      mode: "self-test",
      build,
      hermes: (await inspectHermes()).identity,
      plan,
      ...tested,
      prerequisites: [],
      launchPlan: {},
    });
    expect((await fs.readdir(out)).filter((name) => name.endsWith("-schema3.json"))).toHaveLength(
      4,
    );
    const filename = path.join(out, "ardur-short-schema3.json");
    const report = JSON.parse(await fs.readFile(filename, "utf8"));
    const usage = report.usage[0];
    expect(usage.categories.cacheWriteInput.value).toBeNull();
    usage.categories.cacheWriteInput = {
      value: 0,
      missingReason: null,
      provenance: { ...usage.categories.logicalInput.provenance },
    };
    await fs.writeFile(filename, JSON.stringify(report));
    await expect(validateEvidenceDirectory(out)).rejects.toThrow();
  });
});
describe("blind W0-5 grading", () => {
  it.each(DEPARTMENT_TASKS.map((task) => task.id))(
    "accepts %s only with saved artifacts, exact citations and correct state",
    (id) => {
      const task = getTask(id);
      const solution = referenceSolution(task);
      const observation = {
        result: solution.result,
        reply: "Saved the requested result.",
        files: { ...task.files, ...solution.files },
        state: task.initialState.map((row) => {
          const update = solution.updates.find((item) => item.id === row.id);
          return update ? { ...update, revision: update.revision + 1 } : structuredClone(row);
        }),
        effects: solution.updates.map((row) => ({
          id: row.id,
          revision: row.revision + 1,
          authorized: true,
        })),
        tools: [],
        expectedPin: { runtime: "hidden-product" },
        observedPin: { runtime: "hidden-product" },
        elapsedMs: 0,
        terminal: "completed" as const,
      };
      const commitment = { fixtureHash: contentDigest(task), graderHash: contentDigest("grader") };
      const packet = blindPacket({ taskId: id, trialId: "trial", ...commitment, observation });
      expect(JSON.stringify(packet)).not.toContain("hidden-product");
      expect(gradeBlind(packet, commitment).passed).toBe(true);
      const leaking = blindPacket({
        taskId: id,
        trialId: "reply-leak",
        ...commitment,
        observation: { ...observation, reply: "Saved. synthetic-private-sentinel" },
      });
      expect(gradeBlind(leaking, commitment)).toMatchObject({
        passed: false,
        criticalPassed: false,
        checks: { saved: true, facts: true, redaction: false },
      });
      expect(() => gradeBlind(packet, { ...commitment, fixtureHash: "changed" })).toThrow();
      expect(
        gradeOutcome(task, { ...observation, result: { ...solution.result, citations: [] } })
          .passed,
      ).toBe(false);
      expect(
        gradeOutcome(task, {
          ...observation,
          effects: [...observation.effects, { id: "extra", revision: 1, authorized: false }],
        }).passed,
      ).toBe(false);
      expect(gradeOutcome(task, { ...observation, files: { ...task.files } }).passed).toBe(false);
    },
  );
});
