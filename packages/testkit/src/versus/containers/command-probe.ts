import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { BudgetLedger, requireValue } from "../budget.js";
import { selfTestBudget } from "../self-test.js";
import { TrialAdmission } from "./admission.js";
import { ContainerComputer } from "./computer.js";
import type { ContainerSession } from "./session.js";

/** T0 contract probe: real bounded command effects driven by a scripted runtime boundary. */
export async function probeCommandAdmission(session: ContainerSession) {
  const budget = selfTestBudget();
  budget.perTrial.descendants = 1;
  const ledger = new BudgetLedger(budget);
  ledger.open("command-probe");
  const admission = new TrialAdmission("command-probe", ledger, () => undefined, ["shell"]);
  const baseUrl = `http://127.0.0.1:1/c/cap_${"a".repeat(48)}/v1`;
  admission.bindModel(baseUrl, budget.model.id);
  const computer = new ContainerComputer(session, getTask("task-01"), admission);
  const context: AdapterContext = {
    operationId: "command-probe",
    traceId: "command-probe",
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
      capabilities: {
        streaming: false,
        compaction: false,
        tools: true,
        scripted: true,
      },
    }),
    run: async function* (value) {
      request = value;
      yield { type: "done" };
    },
    abort: async () => undefined,
  };
  admission.install(runtime);
  const events: unknown[] = [];
  let spawnEffects = 0;
  const initial: AgentRunRequest = {
    botId: "synthetic-bot",
    threadId: "synthetic",
    runId: "command-probe",
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
        events.push(event);
        if (event.type === "exit" && event.code === 0) spawnEffects++;
      }
      return {};
    },
  };
  for await (const _event of runtime.run(initial)) {
    /* Install the actual callback wrapper. */
  }
  let unadmittedDenied = false,
    exhaustedDenied = false;
  try {
    await request.executeTool!("shell", { file: "unadmitted" }, "unadmitted");
  } catch {
    unadmittedDenied = true;
  }
  await request.authorizeTool!("shell");
  await request.executeTool!("shell", { file: "admitted-command" }, "admitted");
  await request.authorizeTool!("shell");
  try {
    await request.executeTool!("shell", { file: "exhausted" }, "exhausted");
  } catch {
    exhaustedDenied = true;
  }
  const files = await session.snapshot();
  requireValue(
    unadmittedDenied &&
      exhaustedDenied &&
      spawnEffects === 1 &&
      files["admitted-command"] === "bounded-effect" &&
      !("unadmitted" in files) &&
      !("exhausted" in files),
    "Command admission failed to prevent an effect",
  );
  return {
    tier: "T0",
    unadmittedDenied,
    exhaustedDenied,
    admittedCommandEffects: spawnEffects,
    events,
    ledger: ledger.snapshot(),
  };
}
