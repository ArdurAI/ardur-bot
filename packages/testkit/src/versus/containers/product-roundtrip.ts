import { gradeOutcome } from "../../scoreboard/graders/outcome.js";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../../scoreboard/tasks/reference.js";
import { HermesContainerAdapter } from "../adapters/hermes-container.js";
import type { VersusEvent } from "../adapters/types.js";
import { BudgetLedger } from "../budget.js";
import { startGateway } from "../gateway.js";
import { createTrialDirectory, destroyOwnedDirectory } from "../isolation.js";
import { selfTestBudget } from "../self-test.js";
import { HERMES_CONTAINER_REVISION, HERMES_MINIMUM_CONTEXT_TOKENS } from "./policy.js";
import type { ContainerSession } from "./session.js";

const MANIFEST_MODULES = ["hermes_cli.main", "tools.mcp_tool", "mcp", "openai", "httpx", "yaml"];
const MANIFEST_SCRIPT = `
import importlib, importlib.metadata, json, sys
missing = []
for name in ${JSON.stringify(MANIFEST_MODULES)}:
    try:
        importlib.import_module(name)
    except Exception as exc:
        missing.append({"module": name, "error": type(exc).__name__})
revision = open("/opt/hermes/.hermes_build_sha", encoding="utf-8").read().strip()
print(json.dumps({
    "revision": revision,
    "python": sys.version.split()[0],
    "distributions": len(list(importlib.metadata.distributions())),
    "missing": missing,
}))
`;

async function execText(session: ContainerSession, argv: string[]) {
  const child = await session.exec(argv);
  let stdout = "",
    stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr: stderr.slice(-4000) };
}

export function mountedTmpfsBytes(mount: string) {
  const match = /(?:^|,)size=(\d+)([kKmMgG]?)/.exec(mount);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const scale = unit === "k" ? 1024 : unit === "m" ? 1048576 : unit === "g" ? 1073741824 : 1;
  const bytes = value * scale;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function assessAggregateDisk(input: {
  code: number | null;
  probe: { enospc?: boolean; sizes?: number[]; aggregateBytes?: number; mount?: string };
  capBytes: number;
  followUpCode: number | null;
}) {
  const mount = input.probe.mount ?? "";
  const mountedCapBytes = mountedTmpfsBytes(mount);
  const aggregateBytes = input.probe.aggregateBytes ?? null;
  const containerAlive = input.code === 0 && input.followUpCode === 0;
  const passed =
    containerAlive &&
    input.probe.enospc === true &&
    input.probe.sizes?.[0] === 3 * 1048576 &&
    (input.probe.sizes?.[1] ?? Number.POSITIVE_INFINITY) < 6 * 1048576 &&
    aggregateBytes !== null &&
    aggregateBytes <= input.capBytes &&
    mountedCapBytes === input.capBytes;
  return {
    passed,
    evidence: {
      mechanism: "tmpfs-size" as const,
      capBytes: input.capBytes,
      mountedCapBytes,
      enospc: input.probe.enospc === true,
      sizes: input.probe.sizes ?? [],
      aggregateBytes,
      containerAlive,
    },
  };
}

function scriptedTransport(modelId: string, resultText: string, seen: { upstream: number }) {
  return async (_url: string, init?: RequestInit) => {
    seen.upstream++;
    const body = JSON.parse(String(init?.body ?? "")) as {
      stream?: boolean;
      messages?: { role?: string; content?: unknown }[];
    };
    const toolText = (body.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    const wrote = toolText.includes("untrusted_tool_result") && toolText.includes("write_file");
    const named = toolText.match(/mcp__[A-Za-z0-9_]+write_file/);
    const call = wrote
      ? { final: "Saved the requested result.", name: "", arguments: {} }
      : named
        ? {
            final: "",
            name: "tool_call",
            arguments: {
              name: named[0],
              arguments: { path: "result.json", content: resultText },
            },
          }
        : { final: "", name: "tool_search", arguments: { queries: ["write file"] } };
    const usage = { prompt_tokens: 32, completion_tokens: 24 };
    const message = call.final
      ? { role: "assistant", content: call.final }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_probe_${seen.upstream}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        };
    if (body.stream === false) {
      return Response.json({
        model: modelId,
        choices: [{ message }],
        usage,
      });
    }
    const chunk = (delta: unknown, finish: string | null, withUsage = false) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(withUsage ? { usage } : {}),
      })}\n\n`;
    const sse = call.final
      ? `${chunk({ role: "assistant", content: "" }, null)}${chunk({ content: call.final }, null)}${chunk({}, "stop", true)}data: [DONE]\n\n`
      : `${chunk({ role: "assistant", content: "" }, null)}${chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `call_probe_${seen.upstream}`,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          },
          null,
        )}${chunk(
          {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.arguments) } }],
          },
          null,
        )}${chunk({}, "tool_calls", true)}data: [DONE]\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  };
}

export function productProbeBudget() {
  const budget = selfTestBudget();
  budget.contextSize = HERMES_MINIMUM_CONTEXT_TOKENS;
  budget.resources = {
    ...budget.resources,
    memoryBytes: 1610612736,
    diskBytes: 268435456,
    processes: 32,
    cpuMs: 180000,
  };
  budget.perTrial = { ...budget.perTrial, wallMs: 120000 };
  return budget;
}

/** One scripted Hermes tool round trip through the broker. No pull and no real model call. */
export async function qualifyHermesProduct(root: string) {
  const budget = productProbeBudget();
  const task = { ...getTask("task-01"), deadlineMs: 120000 };
  const resultText = JSON.stringify(referenceSolution(task).result);
  const directory = await createTrialDirectory(root);
  const ledger = new BudgetLedger(budget);
  ledger.open("hermes-product");
  const events: VersusEvent[] = [];
  const emit = (
    kind: VersusEvent["kind"],
    source: VersusEvent["source"],
    data: Record<string, unknown>,
  ) => {
    events.push({
      kind,
      source,
      data,
      trialId: "hermes-product",
      at: events.length,
      sequence: events.length,
      clock: "virtual",
    });
  };
  const seen = { upstream: 0 };
  const gateway = await startGateway({
    budget,
    ledger,
    evidenceKind: "virtual",
    transport: scriptedTransport(budget.model.id, resultText, seen),
  });
  const adapter = new HermesContainerAdapter({
    ledger,
    observedRoute: () => ({
      endpoint: budget.endpoint.origin,
      model: budget.model.id,
      digest: budget.model.digest,
    }),
  });
  try {
    await adapter.prepare({
      id: "hermes-product",
      pairId: "hermes-product-pair",
      task,
      workspace: directory.workspace,
      stateDirectory: directory.state,
      budget,
      providerUrl: gateway.capability("hermes-product", "main", emit),
      brokerUrl: "unused",
      revokeProvider: () => gateway.revoke("hermes-product"),
      emit,
      signal: new AbortController().signal,
    });
    const manifestRun = await execText(adapter.session!, [
      "/opt/hermes/.venv/bin/python3",
      "-c",
      MANIFEST_SCRIPT,
    ]);
    const manifestJson = JSON.parse(manifestRun.stdout) as {
      revision: string;
      python: string;
      distributions: number;
      missing: { module: string; error: string }[];
    };
    const dependencyManifest = {
      runtimeRevision: manifestJson.revision,
      revisionMatchesImageLabel: manifestJson.revision === HERMES_CONTAINER_REVISION,
      python: manifestJson.python,
      distributions: manifestJson.distributions,
      missingPackages: manifestJson.missing,
      missingBytes: manifestJson.missing.length === 0 ? 0 : null,
      packageDownloads: 0,
      lazyInstalls: "disabled",
      evidence:
        manifestJson.missing.length === 0
          ? "Pinned image imports the Hermes runtime with no missing module; nothing was downloaded"
          : "A module failed to import; its byte size was not measured because no download is performed",
    };
    if (
      manifestRun.code !== 0 ||
      manifestJson.missing.length ||
      !dependencyManifest.revisionMatchesImageLabel
    ) {
      return {
        passed: false,
        dependencyManifest,
        roundTrip: null,
        failure: "Hermes dependency manifest is incomplete",
      };
    }
    await adapter.submit();
    const artifact = await adapter.collect();
    const grade = gradeOutcome(task, artifact.observation);
    const downloadMention = events.some(
      (event) =>
        event.kind === "diagnostic" &&
        /pip install|Downloading |GET https?:/i.test(JSON.stringify(event.data)),
    );
    const passed =
      !downloadMention &&
      seen.upstream === 3 &&
      artifact.observation.tools.length === 1 &&
      artifact.observation.tools[0] === "write_file" &&
      artifact.observation.terminal === "completed" &&
      artifact.observation.reply.includes("Saved the requested result.") &&
      grade.passed === true;
    return {
      passed,
      dependencyManifest,
      roundTrip: {
        cohort: "hermes-release-linux-arm64",
        declaredContextTokens: HERMES_MINIMUM_CONTEXT_TOKENS,
        hermesMinimumContextTokens: HERMES_MINIMUM_CONTEXT_TOKENS,
        scriptedUpstreamRequests: seen.upstream,
        realModelCalls: 0,
        tools: artifact.observation.tools,
        terminal: artifact.observation.terminal,
        reply: artifact.observation.reply,
        gradePassed: grade.passed,
        elapsedMs: artifact.observation.elapsedMs,
        files: Object.keys(artifact.observation.files),
      },
      failure: passed ? null : "Hermes product tool round trip failed",
    };
  } finally {
    await adapter.destroy().catch(() => undefined);
    await gateway.close().catch(() => undefined);
    await destroyOwnedDirectory(directory).catch(() => undefined);
  }
}
