import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { contentDigest } from "../scoreboard/manifest.js";
import { getTask } from "../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../scoreboard/tasks/reference.js";
import type { VersusEvent } from "./adapters/types.js";
import { budgetTemplate, parseBudget } from "./budget.js";
import { COMPUTER_IMAGE, HERMES_IMAGE } from "./containers/policy.js";
import { validateEvidenceDirectory, writeEvidence } from "./evidence.js";
import { APPROVED_CANARY, containerHermesIdentity, liveVerdict } from "./live.js";
import { liveChildTimeoutMs, runLiveChild } from "./live-products.js";
import * as provenance from "./provenance.js";
import { planPairs } from "./scheduler.js";
import { createBuildFixture } from "./test-build-fixture.js";

vi.mock("./manifest.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RESEARCH_BASELINE: "refs/tags/research-baseline",
}));

// GitHub CI has no Docker engine or cached images; this lane runs only where both exist.
const imagesReady = (() => {
  try {
    for (const image of [COMPUTER_IMAGE, HERMES_IMAGE, "postgres:16-alpine"])
      execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
        stdio: "ignore",
        timeout: 8000,
      });
    return true;
  } catch {
    return false;
  }
})();

type Message = { role: string; content?: unknown };
/**
 * A fake OpenAI-compatible upstream and /api/ps. Requests offering Ardur's plain tool names follow
 * the W0 reference script, one action per tool result so far; anything else gets plain text.
 */
async function fakeUpstream() {
  const tasks = APPROVED_CANARY.tasks.map(getTask);
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url}`);
      if (request.url === "/api/ps") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            models: [
              {
                name: APPROVED_CANARY.model.id,
                digest: APPROVED_CANARY.model.digest,
                context_length: APPROVED_CANARY.contextSize,
              },
            ],
          }),
        );
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        messages: Message[];
        tools?: { function: { name: string } }[];
      };
      const transcript = JSON.stringify(body.messages);
      const task = tasks.find((item) =>
        transcript.includes(JSON.stringify(item.prompt.split("\n")[1]).slice(1, -1)),
      );
      const plainTools = body.tools?.some((tool) => tool.function.name === "write_file");
      const actions: ({ name: string; arguments: unknown } | { text: string })[] = [];
      if (task && plainTools) {
        const solution = referenceSolution(task);
        for (const file of Object.keys(task.files))
          actions.push({ name: "read_file", arguments: { path: file } });
        if (task.initialState.length) actions.push({ name: "SCOREBOARD_READ", arguments: {} });
        for (const update of solution.updates)
          actions.push({ name: "SCOREBOARD_UPDATE", arguments: update });
        for (const [file, content] of Object.entries(solution.files))
          actions.push({ name: "write_file", arguments: { path: file, content } });
      }
      const step = body.messages.filter((message) => message.role === "tool").length;
      const action = actions[step] ?? { text: "Saved the requested result." };
      const usage = { prompt_tokens: 1000, completion_tokens: 20 };
      const id = `call-${step + 1}`;
      if (!body.stream) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            model: APPROVED_CANARY.model.id,
            choices: [
              {
                index: 0,
                message:
                  "text" in action
                    ? { role: "assistant", content: action.text }
                    : {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id,
                            type: "function",
                            function: {
                              name: action.name,
                              arguments: JSON.stringify(action.arguments),
                            },
                          },
                        ],
                      },
                finish_reason: "text" in action ? "stop" : "tool_calls",
              },
            ],
            usage,
          }),
        );
        return;
      }
      const chunk = (delta: unknown, finish: string | null, extra = {}) =>
        `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: APPROVED_CANARY.model.id, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        chunk({ role: "assistant", content: "" }, null) +
          ("text" in action
            ? chunk({ content: action.text }, null) + chunk({}, "stop", { usage })
            : chunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id,
                      type: "function",
                      function: { name: action.name, arguments: "" },
                    },
                  ],
                },
                null,
              ) +
              chunk(
                {
                  tool_calls: [
                    { index: 0, function: { arguments: JSON.stringify(action.arguments) } },
                  ],
                },
                null,
              ) +
              chunk({}, "tool_calls", { usage })) +
          "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

let repository: string;
beforeAll(async () => {
  repository = await createBuildFixture();
});
afterAll(async () => {
  if (repository) await fs.rm(repository, { recursive: true, force: true });
});

it.skipIf(!imagesReady)(
  "runs the canary's real composition in the allowlisted child (skipped when the Docker engine or the cached computer, Hermes or postgres:16-alpine image is absent; CI does not provide this lane)",
  async () => {
    const upstream = await fakeUpstream();
    // The child must never reach a development database named in the parent's environment.
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://development@127.0.0.1:5433/development";
    const out = await fs.mkdtemp(path.join(tmpdir(), "versus-live-composition-"));
    try {
      const budget = parseBudget({
        ...budgetTemplate(),
        endpoint: { origin: upstream.origin, protocol: "ollama-openai", paid: false },
        contextSize: APPROVED_CANARY.contextSize,
        model: {
          ...APPROVED_CANARY.model,
          serverVersion: "0.0.0-test",
          tokenizerHash: contentDigest("synthetic-tokenizer"),
          templateHash: contentDigest("synthetic-template"),
        },
      });
      const plan = planPairs(budget.cohort);
      const build = await provenance.inspectBuild(repository);
      const started = performance.now();
      // The child starts its own disposable PostgreSQL testcontainer with Ryuk disabled.
      const run = await runLiveChild({ budget, plan, graderHash: build.graderHash });
      expect(performance.now() - started).toBeLessThan(liveChildTimeoutMs(budget));
      expect(liveChildTimeoutMs(budget)).toBe(budget.global.wallMs + 600000);

      expect(run.protocolResults.childExitCode).toBe(0);
      expect(run.protocolResults.classifications).toMatchObject({ completed: 4 });
      expect(liveVerdict(run).code).toBe(0);
      const products = run.protocolResults.products as {
        networkConfinement: string;
        databases: { trialId: string; port: number; disposableLease: boolean }[];
      };
      expect(products.networkConfinement).toBe("loopback-only while a product runs");
      expect(products.databases).toHaveLength(2);
      for (const database of products.databases) {
        expect(database.disposableLease).toBe(true);
        expect(database.port).not.toBe(5433);
      }
      for (const trial of run.trials.filter((item) => item.product === "ardur")) {
        // Ardur ran live through the gateway, its container computer and pre-effect admission.
        expect(trial.grade.passed).toBe(true);
        const events = trial.events as VersusEvent[];
        expect(
          events.some(
            (event) => event.kind === "admission" && event.source === "application-database",
          ),
        ).toBe(true);
        expect(
          events.filter(
            (event) => event.kind === "tool-intent" && event.data.preEffectBudgetAdmission === true,
          ).length,
        ).toBeGreaterThan(1);
      }
      for (const trial of run.trials.filter((item) => item.product === "hermes")) {
        const proof = (trial.events as VersusEvent[]).find((event) => event.data.proof)?.data
          .proof as { mechanism: string } | undefined;
        expect(proof?.mechanism).toBe("linux-cgroup-v2");
      }
      expect(upstream.seen.filter((line) => line.endsWith("/v1/chat/completions")).length).toBe(
        run.protocolResults.forwardedModelRequests,
      );

      // The run survives the child's JSON round trip as valid live evidence.
      await writeEvidence(path.join(out, "evidence"), {
        mode: "live",
        build,
        hermes: containerHermesIdentity(null),
        plan,
        budget,
        trials: run.trials,
        results: run.results,
        prerequisites: [],
        launchPlan: { mode: "live" },
        budgetEvidence: run.budgetEvidence,
        protocolResults: run.protocolResults,
      });
      await validateEvidenceDirectory(path.join(out, "evidence"), build.build, build.graderHash);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await upstream.close();
      await fs.rm(out, { recursive: true, force: true });
    }
  },
  600000,
);
