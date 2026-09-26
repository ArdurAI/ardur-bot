import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateTaskContract } from "../scoreboard/graders/contracts.js";
import { contentDigest } from "../scoreboard/manifest.js";
import type { ReplayFixture } from "../scoreboard/replay/protocol.js";
import { StrictReplay } from "../scoreboard/replay/protocol.js";
import { DEPARTMENT_TASKS, getTask } from "../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../scoreboard/tasks/reference.js";
import type { Emit, VersusEvent } from "./adapters/types.js";
import { SEMANTIC_TOOLS, startBroker, TrialBroker } from "./broker.js";
import { BudgetLedger, budgetTemplate, parseBudget, requireValue } from "./budget.js";
import type { EvidenceTrial } from "./evidence.js";
import { readJson, startGateway } from "./gateway.js";
import { blindPacket, gradeBlind } from "./grading.js";
import { createTrialDirectory, destroyOwnedDirectory, proveNativeIsolation } from "./isolation.js";
import { frozenInputs } from "./manifest.js";
import type { PairedResult, PairPlan } from "./scheduler.js";

export function selfTestBudget() {
  const template = budgetTemplate();
  return parseBudget({
    ...template,
    model: {
      id: "scripted-fixture",
      digest: contentDigest("scripted-fixture-model"),
      quantization: "virtual",
      serverVersion: "virtual",
      tokenizerHash: contentDigest("no-tokenizer-virtual"),
      templateHash: contentDigest("synthetic-wire-v1"),
    },
    global: {
      requests: 256,
      logicalInput: 5000000,
      output: 500000,
      totalTokens: 5500000,
      wallMs: 2400000,
      toolCalls: 2000,
      descendants: 256,
    },
    cohort: {
      tasks: DEPARTMENT_TASKS.map((task) => task.id),
      repetitions: 1,
      history: "short",
      cacheState: "virtual-no-model-cache",
    },
  });
}

/** Deterministic product doubles consume reviewed W0 fixtures; neither product is invoked. */
export async function runOfflineSelfTest(plan: PairPlan[], graderHash: string) {
  const root = await mkdtemp(path.join(tmpdir(), "versus-self-test-"));
  const budget = selfTestBudget();
  if (plan.some((pair) => pair.history === "long")) {
    // A declared virtual envelope for the actual long fixture, never a live-budget expansion.
    budget.contextSize = 128000;
    budget.perTrial.logicalInput = 256000;
    budget.perTrial.totalTokens = 268000;
  }
  const inputs = { short: frozenInputs("short"), long: frozenInputs("long") };
  const messages = (pair: PairPlan) => [
    ...inputs[pair.history].find((input) => input.taskId === pair.taskId)!.material.history,
    { role: "user", content: getTask(pair.taskId).prompt },
  ];
  const trials: EvidenceTrial[] = [];
  const results: PairedResult[] = [];
  const contracts = DEPARTMENT_TASKS.map(validateTaskContract);
  requireValue(
    contracts.every((contract) => contract.passed),
    "W0-5 task contract failed",
  );
  const fixtures: ReplayFixture[] = plan.flatMap((pair) =>
    pair.order.map(() => {
      const task = getTask(pair.taskId);
      const solution = referenceSolution(task);
      return {
        version: 1,
        protocol: "openai-chat-sse",
        route: {
          provider: "loopback-scripted",
          model: budget.model.id,
          runtime: "scripted-double",
          protocolVersion: "1",
        },
        initial: "start",
        terminal: ["done"],
        exchanges: [
          {
            id: "answer",
            from: "start",
            to: "done",
            variables: [],
            request: {
              model: budget.model.id,
              messages: messages(pair),
              tools: SEMANTIC_TOOLS.filter((tool) => task.allowedTools.includes(tool.name)),
              max_tokens: budget.maxOutputTokens,
              temperature: budget.temperature,
              seed: budget.seed,
              n: 1,
              stream: false,
            },
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              chunks: [
                JSON.stringify({
                  model: budget.model.id,
                  choices: [{ message: { role: "assistant", content: JSON.stringify(solution) } }],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 50,
                    prompt_tokens_details: { cached_tokens: 20, cache_creation_tokens: 10 },
                    completion_tokens_details: { reasoning_tokens: 5 },
                  },
                }),
              ],
              end: "complete",
            },
          },
        ],
      };
    }),
  );
  let requestIndex = 0;
  let activeFixture = 0;
  const strict = fixtures.map((fixture) => new StrictReplay(fixture));
  const errors: string[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      requireValue(
        request.url === "/v1/chat/completions" && request.method === "POST",
        "Unexpected fake provider route",
      );
      const body = await readJson(request);
      requestIndex++;
      const fixture = strict[activeFixture];
      requireValue(fixture, "Extra upstream request after script completion");
      const step = fixture.accept(body);
      response.writeHead(step.response.status, step.response.headers);
      response.end(step.response.chunks.join(""));
    })().catch((error) => {
      errors.push(error instanceof Error ? error.message : "Replay failed");
      response.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  budget.endpoint.origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const ledger = new BudgetLedger(budget);
  const gateway = await startGateway({ budget, ledger, evidenceKind: "virtual" });
  let isolation: unknown;
  try {
    const canary = await createTrialDirectory(root);
    try {
      isolation = (
        await proveNativeIsolation({
          root: canary.root,
          readRoots: [],
          ports: [],
          forbiddenRoots: [],
        })
      ).result;
    } finally {
      await destroyOwnedDirectory(canary);
    }
    for (const pair of plan)
      for (const product of pair.order) {
        const task = getTask(pair.taskId);
        const id = `trial-${pair.id}-${product}`;
        const directory = await createTrialDirectory(root);
        const events: VersusEvent[] = [];
        const emit: Emit = (kind, source, data) =>
          events.push({
            sequence: events.length,
            trialId: id,
            kind,
            source,
            clock: "virtual",
            at: events.length,
            data,
          });
        ledger.open(id);
        const broker = new TrialBroker({
          trialId: id,
          task,
          workspace: directory.workspace,
          journal: path.join(directory.state, "effects.jsonl"),
          ledger,
          emit,
        });
        await broker.prepare();
        const mcp = await startBroker(broker);
        const providerUrl = gateway.capability(id, "main", emit);
        let reason = "scripted-contract-completed";
        let terminal: "completed" | "failed" = "completed";
        let reply = "";
        try {
          emit("admission", "scripted-double", { virtual: true, durableProductAdmission: false });
          // The actual loopback MCP protocol is exercised without exposing the grader.
          const catalogResponse = await fetch(mcp.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          });
          requireValue(catalogResponse.ok, "MCP catalog failed");
          const catalog = (await catalogResponse.json()) as { result: { tools: unknown[] } };
          const response = await fetch(`${providerUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: budget.model.id,
              messages: messages(pair),
              tools: catalog.result.tools,
              stream: false,
            }),
          });
          requireValue(response.ok, "Scripted gateway request failed");
          const message = (await response.json()) as {
            choices: { message: { content: string } }[];
          };
          reply = message.choices[0]!.message.content;
          requireValue(typeof reply === "string", "Scripted assistant reply missing");
          const script = JSON.parse(reply) as ReturnType<typeof referenceSolution>;
          for (const name of Object.keys(task.files))
            await broker.call("read_file", { path: name });
          for (const update of script.updates) {
            await broker.call("SCOREBOARD_READ", {});
            const intentHash = contentDigest({
              trialId: id,
              name: "SCOREBOARD_UPDATE",
              args: update,
            });
            broker.decide(intentHash, true);
            await broker.call("SCOREBOARD_UPDATE", update);
          }
          for (const [name, content] of Object.entries(script.files))
            await broker.call("write_file", { path: name, content });
        } catch (error) {
          terminal = "failed";
          reason = error instanceof Error ? error.message : "scripted-contract-failed";
        } finally {
          gateway.revoke(id);
          await mcp.close();
        }
        emit("terminal", "scripted-double", { terminal, reason, virtual: true });
        const snapshot = await broker.snapshot();
        let result: unknown = null;
        try {
          result = JSON.parse(snapshot.files["result.json"] ?? "null");
        } catch {
          /* Wrong artifacts remain failed. */
        }
        const fixtureHash = frozenInputs(pair.history).find(
          (item) => item.taskId === task.id,
        )!.hash;
        const packet = blindPacket({
          taskId: task.id,
          trialId: id,
          fixtureHash,
          graderHash,
          observation: {
            ...snapshot,
            result,
            reply,
            expectedPin: { model: "scripted-fixture" },
            observedPin: { model: "scripted-fixture" },
            elapsedMs: 0,
            terminal,
          },
        });
        const grade = gradeBlind(packet, { fixtureHash, graderHash });
        if (grade.uninspected) throw new Error("The workspace could not be inspected.");
        trials.push({
          product,
          taskId: task.id,
          trialId: id,
          sessionId: `session-${contentDigest(id).slice(0, 16)}`,
          traceId: `trace-${contentDigest(id).slice(0, 16)}`,
          pairId: pair.id,
          fixtureHash,
          graderHash,
          outcome: grade.passed ? "success" : "failed",
          // The throw above already refused an uninspected grade, so deadline is a real check.
          grade: { ...grade, withinDeadline: grade.withinDeadline! },
          events,
          raw: {
            packet,
            grade,
            clock: "virtual",
            submittedInputHash: contentDigest(messages(pair)),
            liveAgentSuccess: null,
          },
        });
        results.push({
          pairId: pair.id,
          product,
          taskId: task.id,
          cluster: pair.cluster,
          accepted: grade.passed,
          criticalPassed: grade.criticalPassed,
          reason: grade.passed ? reason : "scripted-grade-failed",
          tier: "T0",
          elapsedMs: null,
          logicalInput: null,
          cost: null,
        });
        await destroyOwnedDirectory(directory);
        activeFixture++;
      }
    for (const replay of strict)
      try {
        replay.assertComplete();
      } catch {
        errors.push("Strict fixture incomplete");
      }
    return {
      trials,
      results,
      budget,
      budgetEvidence: { ...ledger.snapshot(), gatewayRequests: gateway.requests },
      isolation,
      protocolResults: {
        tier: "T0",
        clock: "virtual",
        passed: errors.length === 0,
        errors,
        contracts: contracts.map((contract) => ({
          taskId: contract.taskId,
          passed: contract.passed,
          negativeControls: contract.negativeControls,
        })),
        strictReplayRequests: requestIndex,
        productCalls: 0,
        parity: [
          { id: "H06", layer: "MCP-broker-protocol", status: "executed-T0-subset" },
          { id: "H07", layer: "synthetic-isolation-canaries", status: "see-isolation" },
        ],
        productQualification: "not-run",
      },
    };
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
    await rm(root, { recursive: true });
  }
}
