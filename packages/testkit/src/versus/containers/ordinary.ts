import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  ComputerRef,
} from "@ardurbot/adapter-kit";
import {
  backgroundShellArgv,
  createCommandRecording,
  prepareDelegationWorkspace,
  toComputerRef,
} from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { BudgetLedger } from "../budget.js";
import { selfTestBudget } from "../self-test.js";
import { TrialAdmission } from "./admission.js";
import { ContainerComputer } from "./computer.js";
import type { ContainerSession } from "./session.js";

export interface LaneCheck {
  name: string;
  passed: boolean;
  evidence: unknown;
}

const storedComputerId = "ordinary-computer";
const runId = "ordinary-run";

function routeFor(trial: string) {
  const suffix = Buffer.from(trial).toString("hex").padEnd(48, "a").slice(0, 48);
  return `http://127.0.0.1:1/c/cap_${suffix}/v1`;
}

async function capture(checks: LaneCheck[], name: string, action: () => Promise<unknown>) {
  try {
    checks.push({ name, passed: true, evidence: await action() });
  } catch (error) {
    checks.push({
      name,
      passed: false,
      evidence: error instanceof Error ? error.message : String(error),
    });
  }
}

function shellArgv(executionId: string, command: string) {
  return backgroundShellArgv(storedComputerId, runId, executionId, command);
}

async function admittedRuntime(
  session: ContainerSession,
  trial: string,
  tools: string[],
  signal: AbortSignal,
  prepare?: (
    computer: ContainerComputer,
    persisted: ComputerRef,
    context: AdapterContext,
  ) => AgentRunRequest["admitHelper"],
) {
  const budget = selfTestBudget();
  budget.perTrial = { ...budget.perTrial, toolCalls: 12, descendants: 8 };
  budget.global = {
    ...budget.global,
    toolCalls: Math.max(budget.global.toolCalls, 12),
    descendants: Math.max(budget.global.descendants, 8),
  };
  const ledger = new BudgetLedger(budget);
  ledger.open(trial);
  const admission = new TrialAdmission(trial, ledger, () => undefined, tools);
  const baseUrl = routeFor(trial);
  admission.bindModel(baseUrl, budget.model.id);
  const computer = new ContainerComputer(session, getTask("task-01"), admission);
  const context: AdapterContext = {
    operationId: trial,
    traceId: trial,
    spaceId: "synthetic",
    userId: "synthetic",
    botId: "synthetic-bot",
    runId,
    signal,
  };
  const provisioned = await computer.provision(
    { botId: "synthetic-home", homePath: "unused" },
    context,
  );
  const persisted = toComputerRef({
    homeKey: provisioned.botId,
    kind: provisioned.kind,
    providerRef: provisioned.providerRef,
    networkEgress: false,
  });
  const recording = createCommandRecording({
    events: { append: async () => undefined } as unknown as Parameters<
      typeof createCommandRecording
    >[0]["events"],
    sandbox: computer,
    computer: persisted,
    storedComputer: {
      id: storedComputerId,
      scope: "dedicated",
      homeKey: persisted.botId,
      kind: persisted.kind,
      providerRef: persisted.providerRef,
    },
    context: { ...context, runId, botId: persisted.botId },
    threadId: "ordinary-thread",
    attemptId: "attempt-1",
    fence: 1,
    secrets: [],
  });
  let wrapped!: AgentRunRequest;
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: false, compaction: false, tools: true, scripted: true },
    }),
    run: async function* (value) {
      wrapped = value;
      yield { type: "done" };
    },
    abort: async () => undefined,
  };
  admission.install(runtime);
  const request: AgentRunRequest = {
    botId: "synthetic-bot",
    threadId: "ordinary-thread",
    runId,
    prompt: "synthetic",
    instructions: "",
    history: [],
    tools: "none",
    model: { provider: "custom", id: budget.model.id, baseUrl },
    admitHelper: prepare?.(computer, persisted, context),
    executeTool: async (name, args, executionId) =>
      recording.invoke(name, args, executionId, async (_name, toolArgs, id) =>
        recording.execute(id, shellArgv(id, String(toolArgs.command ?? "")), undefined, {}),
      ),
  };
  for await (const _event of runtime.run(request)) {
    /* Install the production admission wrapper. */
  }
  return { computer, context, persisted, run: wrapped, ledger };
}

async function shell(
  run: AgentRunRequest,
  command: string,
  executionId: string,
): Promise<{ stdout: string; stderr: string; code: number | null; error?: string }> {
  await run.authorizeTool!("shell");
  return (await run.executeTool!("shell", { command }, executionId)) as {
    stdout: string;
    stderr: string;
    code: number | null;
    error?: string;
  };
}

/** Ordinary Ardur shell, files, helper, and stop through the production executor boundary. */
export async function qualifyOrdinaryExecution(session: ContainerSession): Promise<LaneCheck[]> {
  const checks: LaneCheck[] = [];
  const row = {
    rootTaskId: "rootTask",
    workspacePath: null as string | null,
    workspaceKind: null as string | null,
  };
  const prisma = {
    delegation: {
      findUniqueOrThrow: async () => row,
      update: async ({ data }: { data: { workspacePath: string; workspaceKind: string } }) => {
        row.workspacePath = data.workspacePath;
        row.workspaceKind = data.workspaceKind;
        return row;
      },
    },
  } as unknown as PrismaClient;
  const { computer, context, persisted, run } = await admittedRuntime(
    session,
    "ordinary",
    ["shell", "run_subagent"],
    new AbortController().signal,
    (sandbox, computerRef, current) => async () => {
      const directory = await prepareDelegationWorkspace(
        prisma,
        sandbox,
        computerRef,
        current,
        "helper1",
        ".",
      );
      return {
        id: "helper1",
        tokens: 32,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        prompt: directory,
      };
    },
  );
  await capture(checks, "persisted-identity-and-directory-listing", async () => {
    if (persisted.id !== persisted.providerRef)
      throw new Error("computer id drifted from provider");
    await computer.writeFile(
      persisted,
      { path: "reports/result.json", content: Buffer.from("{}") },
      context,
    );
    const nested = await computer.listFiles(persisted, "reports", context);
    const root = await computer.listFiles(persisted, "", context);
    const bytes = await computer.readFile(persisted, "reports/result.json", context);
    if (new TextDecoder().decode(bytes) !== "{}") throw new Error("file round trip mismatch");
    const file = nested.find(
      (entry) => entry.path === "reports/result.json" && entry.kind === "file",
    );
    const directory = root.find((entry) => entry.path === "reports" && entry.kind === "dir");
    if (file?.size !== 2 || !directory)
      throw new Error(`listing ${JSON.stringify({ nested, root })}`);
    return { id: persisted.id, nested: nested.length, root: root.length };
  });
  await capture(checks, "ordinary-shell-launcher", async () => {
    const result = await shell(run, "printf 'ordinary-shell\\n'", "print-1");
    if (result.code !== 0 || !result.stdout.includes("ordinary-shell"))
      throw new Error(`shell ${result.code}: ${result.stderr || result.error || result.stdout}`);
    return { code: result.code, stdout: result.stdout };
  });
  await capture(checks, "product-files-remain-writable", async () => {
    const created = await shell(
      run,
      'exec /usr/bin/python3 -I -S -c \'import os; os.makedirs("made", exist_ok=True); open("made/file.txt","w").write("product"); open("plain.txt","w").write("product")\'',
      "product-files",
    );
    if (created.code !== 0)
      throw new Error(`product create ${created.code}: ${created.stderr || created.error}`);
    await computer.writeFile(
      persisted,
      { path: "plain.txt", content: Buffer.from("relay") },
      context,
    );
    await computer.writeFile(
      persisted,
      { path: "made/relay.txt", content: Buffer.from("relay") },
      context,
    );
    const plain = new TextDecoder().decode(
      await computer.readFile(persisted, "plain.txt", context),
    );
    const nested = new TextDecoder().decode(
      await computer.readFile(persisted, "made/relay.txt", context),
    );
    if (plain !== "relay" || nested !== "relay") throw new Error(`overwrite ${plain}/${nested}`);
    return { plain, nested };
  });
  await capture(checks, "admitted-helper-workspace", async () => {
    await run.authorizeTool!("run_subagent");
    const admitted = await run.admitHelper!("child-1", "helper", "synthetic task");
    if (!("id" in admitted) || admitted.id !== "helper1")
      throw new Error("helper was not admitted");
    const entries = await computer.listFiles(persisted, "tasks/rootTask", context);
    const directory = entries.find(
      (entry) => entry.path === "tasks/rootTask/helper1" && entry.kind === "dir",
    );
    if (!directory || row.workspaceKind !== "artifacts")
      throw new Error(`workspace ${row.workspaceKind} ${JSON.stringify(entries)}`);
    return { id: admitted.id, kind: row.workspaceKind };
  });
  await capture(checks, "persisted-stop-and-destroy", async () => {
    await computer.stop(persisted);
    await computer.destroy(persisted);
    let refused = false;
    try {
      await computer.readFile(persisted, "reports/result.json", context);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("destroyed computer still served files");
    return { refused };
  });
  return checks;
}

/** Abort during command startup must not report a successful product effect. */
export async function qualifyCancellation(session: ContainerSession): Promise<LaneCheck[]> {
  const checks: LaneCheck[] = [];
  const controller = new AbortController();
  const { run } = await admittedRuntime(
    session,
    "cancel01",
    ["shell"],
    controller.signal,
    undefined,
  );
  await capture(checks, "ordinary-command-cancellation", async () => {
    const pending = shell(
      run,
      'exec /usr/bin/python3 -I -S -c \'import time; time.sleep(8); open("cancelled.txt","w").write("no")\'',
      "cancel-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    try {
      const result = await pending;
      throw new Error(`command finished with ${result.code}: ${result.stdout}${result.stderr}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The production recorder reports an aborted command as an incomplete recording.
      if (
        !controller.signal.aborted ||
        !/cancelled|aborted|destroyed|deadline|complete recording/i.test(message)
      )
        throw error;
      return { message };
    }
  });
  return checks;
}
