import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import type { Budget } from "../budget.js";
import { BudgetLedger, requireValue } from "../budget.js";
import { TrialAdmission } from "./admission.js";
import { ContainerComputer } from "./computer.js";
import type { ContainerSession } from "./session.js";

interface CounterProbe {
  cap: number;
  admitted: number;
  nextRefused: boolean;
  refusal: string | null;
  effectAfterRefusal: boolean;
}

function refusalOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** In-process tool and helper caps. The counters are the budget file's per-trial limits. */
export async function probeToolAndHelperCaps(budget: Budget) {
  return {
    toolCalls: await probeToolCap(budget),
    helpers: await probeHelperCap(budget),
  };
}

async function probeToolCap(budget: Budget): Promise<CounterProbe> {
  const cap = budget.perTrial.toolCalls;
  const ledger = new BudgetLedger(budget);
  ledger.open("tool-cap");
  const baseUrl = `http://127.0.0.1:1/c/cap_${"b".repeat(48)}/v1`;
  const admission = new TrialAdmission("tool-cap", ledger, () => undefined, ["write_file"]);
  admission.bindModel(baseUrl, budget.model.id);
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
  let effects = 0;
  const request: AgentRunRequest = {
    botId: "synthetic-bot",
    threadId: "synthetic",
    runId: "tool-cap",
    prompt: "synthetic",
    instructions: "",
    history: [],
    tools: "none",
    model: { id: budget.model.id, provider: "custom", baseUrl },
    executeTool: async () => {
      effects++;
      return {};
    },
  };
  for await (const _event of runtime.run(request)) {
    /* Install the production boundary. */
  }
  for (let index = 0; index < cap; index++) {
    await wrapped.authorizeTool!("write_file");
    await wrapped.executeTool!("write_file", { path: "result.json" }, `tool-${index}`);
  }
  const before = effects;
  let refusal: string | null = null;
  try {
    await wrapped.authorizeTool!("write_file");
    await wrapped.executeTool!("write_file", { path: "result.json" }, "tool-overflow");
  } catch (error) {
    refusal = refusalOf(error);
  }
  return {
    cap,
    admitted: before,
    nextRefused: refusal === "budget-exhausted: toolCalls" && effects === before,
    refusal,
    effectAfterRefusal: effects !== before,
  };
}

async function probeHelperCap(budget: Budget): Promise<CounterProbe> {
  const cap = budget.perTrial.descendants;
  requireValue(budget.perTrial.toolCalls > cap, "Helper refusal must be the descendant counter");
  const ledger = new BudgetLedger(budget);
  ledger.open("helper-cap");
  const baseUrl = `http://127.0.0.1:1/c/cap_${"c".repeat(48)}/v1`;
  const admission = new TrialAdmission("helper-cap", ledger, () => undefined, ["run_subagent"]);
  admission.bindModel(baseUrl, budget.model.id);
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
  let effects = 0;
  const request: AgentRunRequest = {
    botId: "synthetic-bot",
    threadId: "synthetic",
    runId: "helper-cap",
    prompt: "synthetic",
    instructions: "",
    history: [],
    tools: "none",
    model: { id: budget.model.id, provider: "custom", baseUrl },
    admitHelper: async (executionId) => {
      effects++;
      return {
        id: executionId,
        tokens: 1,
        deadlineAt: new Date(Date.now() + 1000).toISOString(),
      };
    },
  };
  for await (const _event of runtime.run(request)) {
    /* Install the production boundary. */
  }
  for (let index = 0; index < cap; index++) {
    await wrapped.authorizeTool!("run_subagent");
    await wrapped.admitHelper!(`helper-${index}`, "helper", "synthetic");
  }
  const before = effects;
  let refusal: string | null = null;
  try {
    await wrapped.authorizeTool!("run_subagent");
    await wrapped.admitHelper!("helper-overflow", "helper", "synthetic");
  } catch (error) {
    refusal = refusalOf(error);
  }
  return {
    cap,
    admitted: before,
    nextRefused: refusal === "budget-exhausted: descendants" && effects === before,
    refusal,
    effectAfterRefusal: effects !== before,
  };
}

/** Count command descendants to the budget cap inside the stand-in computer, then refuse one more. */
export async function probeBudgetAdmission(session: ContainerSession, budget: Budget) {
  const toolCalls = await probeToolCap(budget);
  const helpers = await probeHelperCap(budget);
  const commands = await probeCommandCap(session, budget);
  const passed =
    toolCalls.nextRefused &&
    !toolCalls.effectAfterRefusal &&
    toolCalls.admitted === toolCalls.cap &&
    helpers.nextRefused &&
    !helpers.effectAfterRefusal &&
    helpers.admitted === helpers.cap &&
    commands.unadmittedDenied &&
    commands.nextRefused &&
    !commands.effectAfterRefusal &&
    commands.admitted === commands.cap;
  return {
    passed,
    evidence: { toolCalls, descendants: { helpers, commands } },
  };
}

async function probeCommandCap(session: ContainerSession, budget: Budget) {
  const cap = budget.perTrial.descendants;
  requireValue(budget.perTrial.toolCalls > cap, "Command refusal must be the descendant counter");
  const ledger = new BudgetLedger(budget);
  ledger.open("command-cap");
  const admission = new TrialAdmission("command-cap", ledger, () => undefined, ["shell"]);
  const baseUrl = `http://127.0.0.1:1/c/cap_${"d".repeat(48)}/v1`;
  admission.bindModel(baseUrl, budget.model.id);
  const computer = new ContainerComputer(session, getTask("task-01"), admission);
  const context: AdapterContext = {
    operationId: "command-cap",
    traceId: "command-cap",
    spaceId: "synthetic",
    userId: "synthetic",
    botId: "synthetic-bot",
    signal: new AbortController().signal,
  };
  const ref = await computer.provision({ botId: "synthetic-home", homePath: "unused" }, context);
  let request!: AgentRunRequest;
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: false, compaction: false, tools: true, scripted: true },
    }),
    run: async function* (value) {
      request = value;
      yield { type: "done" };
    },
    abort: async () => undefined,
  };
  admission.install(runtime);
  let effects = 0;
  const initial: AgentRunRequest = {
    botId: "synthetic-bot",
    threadId: "synthetic",
    runId: "command-cap",
    prompt: "synthetic",
    instructions: "",
    history: [],
    tools: "none",
    model: { id: budget.model.id, provider: "custom", baseUrl },
    executeTool: async (_name, args) => {
      for await (const event of computer.execute(
        ref,
        {
          argv: [
            "/usr/bin/python3",
            "-I",
            "-S",
            "-c",
            `open('/opt/data/workspace/${String(args.file)}','w').write('bounded-effect')`,
          ],
          cwd: "/opt/data/workspace",
          timeoutMs: 5000,
        },
        context,
      )) {
        if (event.type === "exit" && event.code === 0) effects++;
      }
      return {};
    },
  };
  for await (const _event of runtime.run(initial)) {
    /* Install the production boundary. */
  }
  let unadmittedDenied = false;
  try {
    await request.executeTool!("shell", { file: "unadmitted" }, "unadmitted");
  } catch {
    unadmittedDenied = true;
  }
  for (let index = 0; index < cap; index++) {
    await request.authorizeTool!("shell");
    await request.executeTool!("shell", { file: `command-${index}` }, `command-${index}`);
  }
  const before = effects;
  let refusal: string | null = null;
  try {
    await request.authorizeTool!("shell");
    await request.executeTool!("shell", { file: "command-overflow" }, "command-overflow");
  } catch (error) {
    refusal = refusalOf(error);
  }
  const files = await session.snapshot();
  const overflowWritten = "command-overflow" in files;
  return {
    cap,
    admitted: before,
    unadmittedDenied,
    nextRefused: refusal === "budget-exhausted: descendants" && !overflowWritten,
    refusal,
    effectAfterRefusal: effects !== before || overflowWritten,
  };
}
