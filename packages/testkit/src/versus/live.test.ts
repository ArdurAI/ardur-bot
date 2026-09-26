import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePerformanceEvidenceReport } from "../performance-report.js";
import { contentDigest } from "../scoreboard/manifest.js";
import type { TaskContract } from "../scoreboard/tasks/catalog.js";
import { getTask } from "../scoreboard/tasks/catalog.js";
import type { referenceSolution } from "../scoreboard/tasks/reference.js";
import { HermesContainerAdapter } from "./adapters/hermes-container.js";
import type { TrialArtifacts, TrialContext, VersusAdapter, VersusEvent } from "./adapters/types.js";
import { TrialBroker } from "./broker.js";
import type { Budget } from "./budget.js";
import { BudgetLedger, parseBudget, requireValue } from "./budget.js";
import { runCli } from "./cli.js";
import {
  COMPUTER_IMAGE,
  HERMES_CONTAINER_CHECKS,
  HERMES_CONTAINER_REVISION,
  HERMES_IMAGE,
} from "./containers/policy.js";
import { STANDIN } from "./containers/qualification.js";
import { validateEvidenceDirectory } from "./evidence.js";
import type { LiveProducts, LiveTrialSetup } from "./live.js";
import { APPROVED_CANARY, canaryDifferences, liveVerdict, runLiveTrials } from "./live.js";
import * as provenance from "./provenance.js";
import { inspectLocalRoute } from "./qualification.js";
import type { PairPlan } from "./scheduler.js";
import { planPairs } from "./scheduler.js";
import { ServingWitness } from "./serving.js";

// Build identity comes from a self-contained Git fixture, never this checkout's history.
vi.mock("./manifest.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RESEARCH_BASELINE: "refs/tags/research-baseline",
}));
const inspectRepositoryBuild = provenance.inspectBuild;

// GitHub CI has no cached computer image and must not require Docker.
const imageReady = (() => {
  try {
    childProcess.execFileSync(
      "docker",
      ["image", "inspect", COMPUTER_IMAGE, "--format", "{{.Id}}"],
      {
        stdio: "ignore",
        timeout: 8000,
      },
    );
    return true;
  } catch {
    return false;
  }
})();

const directories: string[] = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "versus-live-test-"));
  directories.push(root);
  return root;
}

const pinnedImage = {
  id: `sha256:${contentDigest("synthetic-hermes-image")}`,
  platform: "linux/arm64" as const,
  revision: HERMES_CONTAINER_REVISION,
};
const inspect = async () => pinnedImage;
function productReport(status = "product-qualified") {
  const counter = { cap: 2, admitted: 2, nextRefused: true, effectAfterRefusal: false };
  const evidence: Record<string, unknown> = {
    "aggregate-disk-cap": { mechanism: "tmpfs-size", capBytes: 8388608, containerAlive: true },
    "tool-and-descendant-admission": {
      toolCalls: counter,
      descendants: { helpers: counter, commands: counter },
    },
    "dependency-manifest": { missingPackages: [], missingBytes: 0 },
  };
  return {
    status,
    image: HERMES_IMAGE,
    imageDigest: pinnedImage.id,
    runtimeRevision: HERMES_CONTAINER_REVISION,
    realModelCalls: 0,
    imagePulls: 0,
    packageDownloads: 0,
    checks: HERMES_CONTAINER_CHECKS.map((name) => ({
      name,
      passed: true,
      evidence: evidence[name] ?? {},
    })),
  };
}

/** A fake Ollama: metadata plus an OpenAI-compatible route answering with the reference script. */
async function fakeOllama() {
  const state = {
    psContext: 65536,
    requests: [] as string[],
    chat: [] as string[],
    afterChat: undefined as (() => void) | undefined,
  };
  const tag = { name: APPROVED_CANARY.model.id, digest: APPROVED_CANARY.model.digest, size: 100 };
  const tasks = APPROVED_CANARY.tasks.map(getTask);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      state.requests.push(`${request.method} ${request.url}`);
      const json = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/api/tags") return json({ models: [tag] });
      if (request.url === "/api/version") return json({ version: "0.0.0-test" });
      if (request.url === "/api/show")
        return json({
          template: "synthetic-template",
          details: { quantization_level: APPROVED_CANARY.model.quantization },
          model_info: {
            "general.architecture": "llama",
            "llama.context_length": 131072,
            "tokenizer.ggml.tokens": ["synthetic"],
          },
          capabilities: ["completion", "tools"],
        });
      if (request.url === "/api/ps")
        return json({ models: [{ ...tag, context_length: state.psContext }] });
      requireValue(request.url === "/v1/chat/completions", "Unexpected fake route");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: { content: string }[];
      };
      const content = body.messages[0]!.content;
      const task = tasks.find((item) => content.startsWith(item.prompt))!;
      state.chat.push(task.id);
      state.afterChat?.();
      const { referenceSolution } = await import("../scoreboard/tasks/reference.js");
      const solution = referenceSolution(task);
      json({
        model: APPROVED_CANARY.model.id,
        choices: [
          {
            message: {
              role: "assistant",
              // The in-process double sends the bare prompt and follows the whole script; the
              // container double sends the product query and saves the reply as result.json.
              content: JSON.stringify(content === task.prompt ? solution : solution.result),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

type Behavior = "reference" | "loop" | "hang";
/** In-process product double speaking to the live gateway capability, as a product would. */
class StandInAdapter implements VersusAdapter {
  readonly product;
  context: TrialContext | null = null;
  broker: TrialBroker | null = null;
  cancelled = false;
  refusal = "";
  private reply = "";
  private terminal: TrialArtifacts["observation"]["terminal"] = "uncertain";
  private elapsedMs = 0;
  constructor(
    private readonly setup: LiveTrialSetup,
    private readonly behavior: Behavior,
  ) {
    this.product = setup.product;
  }
  async inspect() {
    return { cohort: "in-process-live-standin", scripted: true };
  }
  async prepare(context: TrialContext) {
    this.context = context;
    this.broker = new TrialBroker({
      trialId: context.id,
      task: context.task,
      workspace: context.workspace,
      journal: path.join(context.stateDirectory, "effects.jsonl"),
      ledger: this.setup.ledger,
      emit: context.emit,
      preapproveConsent: true,
    });
    await this.broker.prepare();
  }
  private chat(task: TaskContract) {
    return fetch(`${this.context!.providerUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.context!.budget.model.id,
        messages: [{ role: "user", content: task.prompt }],
        stream: false,
      }),
    });
  }
  async submit() {
    const context = this.context!;
    const broker = this.broker!;
    const started = performance.now();
    try {
      if (this.behavior === "hang") {
        await new Promise((resolve) =>
          context.signal.addEventListener("abort", resolve, { once: true }),
        );
        this.terminal = "cancelled";
        return;
      }
      if (this.behavior === "loop") {
        for (;;) {
          const response = await this.chat(context.task);
          if (!response.ok) {
            this.refusal = await response.text();
            break;
          }
          await response.json();
        }
        this.terminal = "failed";
        return;
      }
      const response = await this.chat(context.task);
      requireValue(response.ok, "Stand-in request refused");
      const message = (await response.json()) as { choices: { message: { content: string } }[] };
      this.reply = message.choices[0]!.message.content;
      const script = JSON.parse(this.reply) as ReturnType<typeof referenceSolution>;
      for (const name of Object.keys(context.task.files))
        await broker.call("read_file", { path: name });
      for (const update of script.updates) {
        await broker.call("SCOREBOARD_READ", {});
        await broker.call("SCOREBOARD_UPDATE", update);
      }
      for (const [name, content] of Object.entries(script.files))
        await broker.call("write_file", { path: name, content });
      this.terminal = "completed";
    } finally {
      this.elapsedMs = performance.now() - started;
      context.revokeProvider();
    }
  }
  async resume(): Promise<never> {
    throw new Error("Not selected");
  }
  async cancel() {
    this.cancelled = true;
  }
  async collect(): Promise<TrialArtifacts> {
    const snapshot = await this.broker!.snapshot();
    let result: unknown = null;
    try {
      result = JSON.parse(snapshot.files["result.json"] ?? "null");
    } catch {
      /* Invalid artifacts stay failed. */
    }
    const budget = this.context!.budget;
    return {
      observation: {
        ...snapshot,
        result,
        reply: this.reply,
        expectedPin: {
          endpoint: budget.endpoint.origin,
          model: budget.model.id,
          digest: budget.model.digest,
        },
        observedPin: this.setup.observedRoute(),
        elapsedMs: this.elapsedMs,
        terminal: this.terminal,
      },
      outcomeReason: this.terminal,
      sessionId: null,
      userTtft: null,
      userTtftMissingReason: "in-process stand-in",
    };
  }
  async destroy() {}
}

function standIns(behavior: (setup: LiveTrialSetup) => Behavior) {
  const created: StandInAdapter[] = [];
  const products: LiveProducts = {
    async create(setup) {
      const adapter = new StandInAdapter(setup, behavior(setup));
      created.push(adapter);
      return { adapter };
    },
    async close() {},
  };
  return { created, products };
}

describe("live container canary", () => {
  let repository: string;
  let ollama: Awaited<ReturnType<typeof fakeOllama>>;
  let budget: Budget;
  let budgetFile: string;
  let reportFile: string;
  let metadataBaseline: number;
  beforeAll(async () => {
    repository = await fs.mkdtemp(path.join(tmpdir(), "versus-live-build-"));
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
  beforeEach(async () => {
    vi.spyOn(provenance, "inspectBuild").mockImplementation(() =>
      inspectRepositoryBuild(repository),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ollama = await fakeOllama();
    // The owner's flow: the planner derives canary-budget.json from the served model.
    budget = (
      await inspectLocalRoute({
        origin: ollama.origin,
        model: APPROVED_CANARY.model.id,
        digest: APPROVED_CANARY.model.digest,
        quantization: APPROVED_CANARY.model.quantization,
        contextSize: APPROVED_CANARY.contextSize,
      })
    ).budget;
    const root = await directory();
    budgetFile = path.join(root, "canary-budget.json");
    reportFile = path.join(root, "container-qualification.json");
    await fs.writeFile(budgetFile, JSON.stringify(budget));
    await fs.writeFile(reportFile, JSON.stringify(productReport()));
    metadataBaseline = ollama.state.requests.length;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await ollama.close();
    for (const root of directories.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });
  const args = async (...extra: string[]) => [
    "--live",
    "--lane",
    "container",
    "--budget",
    budgetFile,
    "--container-report",
    reportFile,
    "--out",
    path.join(await directory(), "evidence"),
    ...extra,
  ];
  function runner(behavior: (setup: LiveTrialSetup) => Behavior, before?: () => void) {
    const doubles = standIns(behavior);
    return {
      doubles,
      runTrials: async (input: { budget: Budget; plan: PairPlan[]; graderHash: string }) => {
        before?.();
        return runLiveTrials({
          ...input,
          products: doubles.products,
          serving: new ServingWitness(input.budget),
          root: await directory(),
        });
      },
    };
  }
  const outOf = (list: string[]) => list[list.indexOf("--out") + 1]!;

  it("pins exactly the owner-approved canary", () => {
    expect(canaryDifferences(budget)).toEqual([]);
    const larger = parseBudget({ ...budget, perTrial: { ...budget.perTrial, requests: 13 } });
    expect(canaryDifferences(larger)).toEqual([
      "The budget's per-run limits is not the owner-approved canary's",
    ]);
    const other = parseBudget({ ...budget, model: { ...budget.model, id: "qwen3:8b" } });
    expect(canaryDifferences(other)).toContain(
      "The budget's model identity is not the owner-approved canary's",
    );
  });

  it("treats task consent as a standing decision only for consented records", async () => {
    const root = await directory();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const task = getTask("task-04");
    const ledger = new BudgetLedger(budget);
    ledger.open("consent");
    const events: string[] = [];
    const broker = new TrialBroker({
      trialId: "consent",
      task,
      workspace,
      journal: path.join(root, "effects.jsonl"),
      ledger,
      emit: (_kind, _source, data) => events.push(String(data.layer)),
      preapproveConsent: true,
    });
    await broker.prepare();
    await expect(
      broker.call("SCOREBOARD_UPDATE", {
        id: "case-b",
        revision: 2,
        value: { status: "resolved" },
      }),
    ).rejects.toThrow("Record outside task consent");
    await broker.call("SCOREBOARD_UPDATE", {
      id: "case-a",
      revision: 7,
      value: { status: "resolved" },
    });
    expect(broker.effects).toHaveLength(1);
    expect(events).toContain("task-consent-policy");
  });

  it("refuses without approval before contacting the endpoint or starting a product", async () => {
    const { doubles, runTrials } = runner(() => "reference");
    const list = await args();
    expect(await runCli(list, { inspect, runTrials })).toBe(2);
    expect(ollama.state.requests.length).toBe(metadataBaseline);
    expect(doubles.created).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Container cohort approval is absent"),
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(outOf(list), "versus-manifest.json"), "utf8"),
    );
    expect(manifest.mode).toBe("dry-run");
    await expect(
      runCli(await args("--container-cohort-approval", "yes"), { inspect, runTrials }),
    ).rejects.toThrow("explicit value approved");
    await expect(
      runCli(["--live", "--budget", budgetFile, "--container-cohort-approval", "approved"]),
    ).rejects.toThrow("--lane container");
  });

  it.each([
    ["an unqualified container report", "report"],
    ["a budget other than the approved canary", "budget"],
    ["an absent pinned image", "image"],
  ])("refuses %s before contacting the endpoint", async (_name, change) => {
    if (change === "report")
      await fs.writeFile(
        reportFile,
        JSON.stringify(productReport("container-boundary-qualified-product-unqualified")),
      );
    if (change === "budget")
      await fs.writeFile(
        budgetFile,
        JSON.stringify({ ...budget, perTrial: { ...budget.perTrial, toolCalls: 31 } }),
      );
    const absent = async () => {
      throw new Error("Pinned Hermes image absent. Owner must approve the pull.");
    };
    const { doubles, runTrials } = runner(() => "reference");
    expect(
      await runCli(await args("--container-cohort-approval", "approved"), {
        inspect: change === "image" ? absent : inspect,
        runTrials,
      }),
    ).toBe(2);
    expect(ollama.state.requests.length).toBe(metadataBaseline);
    expect(doubles.created).toHaveLength(0);
  });

  it("refuses when the served context does not match at planning, with metadata reads only", async () => {
    ollama.state.psContext = 32768;
    const { doubles, runTrials } = runner(() => "reference");
    expect(
      await runCli(await args("--container-cohort-approval", "approved"), { inspect, runTrials }),
    ).toBe(2);
    expect(ollama.state.requests.length).toBeGreaterThan(metadataBaseline);
    expect(ollama.state.requests.every((line) => !line.includes("/v1/"))).toBe(true);
    expect(doubles.created).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Loaded serving context 32768 does not match declared context 65536"),
    );
  });

  it("runs the canary end to end in manifest order and writes validated evidence labelled live", async () => {
    const { doubles, runTrials } = runner(() => "reference");
    const list = await args("--container-cohort-approval", "approved");
    expect(await runCli(list, { inspect, runTrials })).toBe(0);
    const out = outOf(list);
    await validateEvidenceDirectory(out);
    const manifest = JSON.parse(await fs.readFile(path.join(out, "versus-manifest.json"), "utf8"));
    expect(manifest.mode).toBe("live");
    const plan = planPairs(budget.cohort);
    expect(doubles.created.map((adapter) => adapter.context!.id)).toEqual(
      plan.flatMap((pair) => pair.order.map((product) => `live-${pair.id}-${product}`)),
    );
    expect(manifest.results.map((result: { tier: string }) => result.tier)).toEqual(
      Array(4).fill("T3"),
    );
    expect(manifest.results.every((result: { accepted: boolean }) => result.accepted)).toBe(true);
    for (const product of ["ardur", "hermes"] as const) {
      const report = parsePerformanceEvidenceReport(
        JSON.parse(await fs.readFile(path.join(out, `${product}-schema3.json`), "utf8")),
        product,
      );
      expect(report.scenario.tier).toBe("T3");
      expect(report.scenario.timingMode).toBe("live");
    }
    const events = (await fs.readFile(path.join(out, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as VersusEvent);
    expect(events.every((event) => event.clock === "monotonic")).toBe(true);
    const serving = manifest.budgetEvidence.serving as { stage: string; admitted: boolean }[];
    expect(serving.every((observation) => observation.admitted)).toBe(true);
    expect(serving.filter((observation) => observation.stage === "trial-admission")).toHaveLength(
      4,
    );
    expect(ollama.state.chat).toHaveLength(4);
    expect(manifest.protocolResults).toMatchObject({
      plannedRuns: 4,
      executedRuns: 4,
      retries: 0,
      forwardedModelRequests: 4,
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Live canary: 4/4 runs executed; accepted ardur 2/2, hermes 2/2"),
    );
  });

  it("retains planning evidence and exits 2 when the run itself does not finish", async () => {
    const list = await args("--container-cohort-approval", "approved");
    const runTrials = async () => {
      throw new Error("The live child wrote no run");
    };
    expect(await runCli(list, { inspect, runTrials })).toBe(2);
    const manifest = JSON.parse(
      await fs.readFile(path.join(outOf(list), "versus-manifest.json"), "utf8"),
    );
    expect(manifest.mode).toBe("dry-run");
    expect(manifest.prerequisites).toEqual([
      "The live run did not finish: The live child wrote no run",
    ]);
  });

  it("refuses trial admission with zero model requests when the context changes after planning", async () => {
    const { doubles, runTrials } = runner(
      () => "reference",
      () => {
        ollama.state.psContext = 32768;
      },
    );
    const list = await args("--container-cohort-approval", "approved");
    expect(await runCli(list, { inspect, runTrials })).toBe(2);
    expect(ollama.state.chat).toHaveLength(0);
    expect(doubles.created).toHaveLength(0);
    const out = outOf(list);
    await validateEvidenceDirectory(out);
    const manifest = JSON.parse(await fs.readFile(path.join(out, "versus-manifest.json"), "utf8"));
    expect(manifest.mode).toBe("live");
    expect(manifest.protocolResults.classifications).toMatchObject({
      servingRefused: 4,
      completed: 0,
    });
    const trials = (await fs.readFile(path.join(out, "trials.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trials.map((trial) => trial.outcome)).toEqual(Array(4).fill("uncertain"));
    expect(manifest.budgetEvidence.gatewayRequests).toHaveLength(0);
  });

  it("labels a trial whose model reload changed the served context as invalid infrastructure", async () => {
    const { runTrials } = runner(
      () => "reference",
      () => {
        ollama.state.afterChat = () => {
          ollama.state.psContext = 4096;
        };
      },
    );
    const list = await args("--container-cohort-approval", "approved");
    expect(await runCli(list, { inspect, runTrials })).toBe(2);
    expect(ollama.state.chat).toHaveLength(1);
    const manifest = JSON.parse(
      await fs.readFile(path.join(outOf(list), "versus-manifest.json"), "utf8"),
    );
    expect(manifest.results[0].reason).toMatch(
      /^invalid-infrastructure: serving state changed during the trial/,
    );
    expect(manifest.results[0].accepted).toBe(false);
    expect(manifest.protocolResults.classifications).toMatchObject({
      invalidInfrastructure: 1,
      servingRefused: 3,
    });
  });

  it("stops the thirteenth request at the per-run cap and records the trial as capped", async () => {
    const { doubles, runTrials } = runner((setup) =>
      setup.product === "ardur" && setup.task.id === "task-01" ? "loop" : "reference",
    );
    const list = await args("--container-cohort-approval", "approved");
    expect(await runCli(list, { inspect, runTrials })).toBe(1);
    const looping = doubles.created.find(
      (adapter) => adapter.product === "ardur" && adapter.context!.task.id === "task-01",
    )!;
    // Twelve admitted requests from the capped run plus Hermes's one; the thirteenth never left.
    expect(ollama.state.chat.filter((task) => task === "task-01")).toHaveLength(12 + 1);
    expect(looping.refusal).toContain("budget-exhausted: requests");
    const manifest = JSON.parse(
      await fs.readFile(path.join(outOf(list), "versus-manifest.json"), "utf8"),
    );
    const capped = manifest.results.find(
      (result: { product: string; taskId: string }) =>
        result.product === "ardur" && result.taskId === "task-01",
    );
    expect(capped).toMatchObject({ reason: "budget-exhausted: requests", accepted: false });
    const trialId = looping.context!.id;
    expect(
      manifest.budgetEvidence.gatewayRequests.filter(
        (request: { trialId: string }) => request.trialId === trialId,
      ),
    ).toHaveLength(12);
    expect(manifest.budgetEvidence.refusals).toContainEqual({
      trialId,
      reason: "budget-exhausted: requests",
    });
    expect(manifest.budgetEvidence.gatewayRefusals).toContainEqual({
      trialId,
      reason: "budget-exhausted: requests",
    });
    expect(manifest.protocolResults.classifications).toMatchObject({ cap: 1, completed: 3 });
  });

  it("stops a run at the wall deadline, cancels the product and records it as timed out", async () => {
    const short = parseBudget({
      ...budget,
      perTrial: { ...budget.perTrial, wallMs: 1500 },
      global: { ...budget.global, wallMs: 6000 },
      cohort: { ...budget.cohort, tasks: ["task-01"] },
    });
    const { created: doubles, products } = standIns((setup) =>
      setup.product === "hermes" ? "hang" : "reference",
    );
    const plan = planPairs(short.cohort);
    const started = performance.now();
    const run = await runLiveTrials({
      budget: short,
      plan,
      graderHash: contentDigest("synthetic-grader"),
      products,
      serving: new ServingWitness(short),
      root: await directory(),
    });
    expect(performance.now() - started).toBeLessThan(10000);
    const hung = doubles.find((adapter) => adapter.product === "hermes")!;
    expect(hung.cancelled).toBe(true);
    const trial = run.trials.find((item) => item.product === "hermes")!;
    expect(trial.outcome).toBe("timed-out");
    expect(run.results.find((item) => item.product === "hermes")!.reason).toMatch(/^deadline/);
    expect(run.protocolResults.classifications).toMatchObject({ deadline: 1, completed: 1 });
    expect(liveVerdict(run).code).toBe(1);
  });

  it.skipIf(!imageReady)(
    "drives a confined container trial through the live gateway (skipped when the cached computer image or local Docker engine is absent; CI does not provide this lane)",
    async () => {
      const oneTask = parseBudget({ ...budget, cohort: { ...budget.cohort, tasks: ["task-01"] } });
      const inProcess = standIns(() => "reference");
      const products: LiveProducts = {
        async create(setup) {
          if (setup.product === "ardur") return inProcess.products.create(setup);
          return {
            adapter: new HermesContainerAdapter({
              ledger: setup.ledger,
              standin: STANDIN.replace("'brief.md'", JSON.stringify("policy.json")),
              observedRoute: setup.observedRoute,
              preapproveConsent: true,
            }),
          };
        },
        async close() {},
      };
      const run = await runLiveTrials({
        budget: oneTask,
        plan: planPairs(oneTask.cohort),
        graderHash: contentDigest("synthetic-grader"),
        products,
        serving: new ServingWitness(oneTask),
        root: await directory(),
      });
      expect(run.protocolResults.classifications).toMatchObject({ completed: 2 });
      const hermes = run.trials.find((trial) => trial.product === "hermes")!;
      expect(hermes.grade.passed).toBe(true);
      const proof = hermes.events.find((event) => event.data.proof)?.data.proof as {
        mechanism: string;
      };
      expect(proof.mechanism).toBe("linux-cgroup-v2");
      expect(
        hermes.events.filter(
          (event) => event.kind === "usage" && event.source === "provider-gateway",
        ),
      ).toHaveLength(1);
      expect(liveVerdict(run).code).toBe(0);
    },
    120000,
  );
});
