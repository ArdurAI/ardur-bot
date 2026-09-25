import { EventEmitter } from "node:events";
import type { AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import {
  prepareDelegationWorkspace,
  teamBotWorkspaceDirectory,
  toComputerRef,
} from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it } from "vitest";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { BudgetLedger } from "../budget.js";
import { selfTestBudget } from "../self-test.js";
import { TrialAdmission } from "./admission.js";
import { ContainerComputer } from "./computer.js";
import { SYMLINK_REFUSAL } from "./guest.js";
import type { ContainerSession } from "./session.js";

const route = `http://127.0.0.1:1/c/cap_${"b".repeat(48)}/v1`;

function context(signal = new AbortController().signal) {
  return {
    operationId: "ordinary",
    traceId: "ordinary",
    spaceId: "space",
    userId: "user",
    botId: "bot-1",
    signal,
  };
}

function stubSession(id = "a".repeat(64)) {
  const session = {
    id,
    policy: { wallMs: 30_000, productUser: "65532:65532" },
    assertReady: async () => undefined,
    write: async () => undefined,
    read: async () => Buffer.from("ok"),
    file: async () => true,
    snapshot: async () => ({ "result.json": "{}" }),
    exec: async () => {
      throw new Error("unexpected product exec");
    },
    destroy: async () => undefined,
  };
  return session as unknown as ContainerSession & typeof session;
}

async function startRuntime(admission: TrialAdmission, request: AgentRunRequest) {
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
  for await (const _event of runtime.run(request)) {
    /* Capture the wrapped production boundary. */
  }
  return wrapped;
}

describe("container executor contract", () => {
  it("accepts a provider reference after the persisted computer round trip", async () => {
    const session = stubSession();
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("identity");
    const admission = new TrialAdmission("identity", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const current = context();
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, current);
    expect(ref.id).toBe(ref.providerRef);
    const persisted = toComputerRef({
      homeKey: ref.botId,
      kind: ref.kind,
      providerRef: ref.providerRef,
      networkEgress: false,
    });
    await computer.writeFile(
      persisted,
      { path: "notes.txt", content: Uint8Array.from([1, 2, 3]) },
      current,
    );
    await computer.readFile(persisted, "notes.txt", current);
    await computer.stop(persisted);
    await computer.destroy(persisted);
  });

  it("lists workspace-relative children, including directories", async () => {
    const session = stubSession();
    const listed: string[] = [];
    session.file = async (op: string, file: string) => {
      listed.push(`${op}:${file}`);
      if (op !== "list") return true;
      if (file.endsWith("/reports"))
        return [
          { name: "result.json", kind: "file", size: 2 },
          { name: "nested", kind: "dir", size: 0 },
        ];
      return [
        { name: "reports", kind: "dir", size: 0 },
        { name: "notes.txt", kind: "file", size: 4, executable: true },
      ];
    };
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("listing");
    const admission = new TrialAdmission("listing", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const current = context();
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, current);
    expect(await computer.listFiles(ref, "reports")).toEqual([
      { path: "reports/nested", kind: "dir", size: 0 },
      { path: "reports/result.json", kind: "file", size: 2 },
    ]);
    expect(await computer.listFiles(ref, "")).toEqual([
      { path: "notes.txt", kind: "file", size: 4, executable: true },
      { path: "reports", kind: "dir", size: 0 },
    ]);
    expect(listed.some((entry) => entry.startsWith("list:"))).toBe(true);
  });

  it("keeps links out of listings, workspace walks, exports and snapshots", async () => {
    const session = stubSession();
    const reads: string[] = [];
    session.file = async (op: string, file: string) => {
      if (op !== "list") return true;
      if (file.endsWith("/reports")) return [{ name: "result.json", kind: "file", size: 2 }];
      return [
        { name: "reports", kind: "dir", size: 0 },
        { name: "leak", kind: "link", size: 0 },
        { name: "notes.txt", kind: "file", size: 4 },
      ];
    };
    session.read = async (file: string) => {
      reads.push(file);
      if (file.endsWith("/leak")) throw new Error(SYMLINK_REFUSAL);
      return Buffer.from("ok");
    };
    const guestSnapshot = {
      "notes.txt": "ok",
      "reports/result.json": "{}",
      leak: { kind: "link" },
    };
    session.snapshot = async () => guestSnapshot as unknown as Record<string, string>;
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("links");
    const admission = new TrialAdmission("links", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const current = context();
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, current);
    expect(await computer.listFiles(ref, "", current)).toEqual([
      { path: "notes.txt", kind: "file", size: 4 },
      { path: "reports", kind: "dir", size: 0 },
    ]);
    const walked: string[] = [];
    const pending = [""];
    while (pending.length)
      for (const entry of await computer.listFiles(ref, pending.pop()!, current)) {
        if (entry.kind === "dir") pending.push(entry.path);
        else {
          await computer.readFile(ref, entry.path, current);
          walked.push(entry.path);
        }
      }
    expect(walked.sort()).toEqual(["notes.txt", "reports/result.json"]);
    expect(reads.some((file) => file.endsWith("/leak"))).toBe(false);
    const exported: string[] = [];
    for await (const file of computer.exportWorkspace(ref)) exported.push(file.path);
    expect(exported.sort()).toEqual(["notes.txt", "reports/result.json"]);
    expect(Object.keys(await computer.snapshotFiles("home-1", "bot-1")).sort()).toEqual([
      "notes.txt",
      "reports/result.json",
    ]);
  });

  it("prepares a helper workspace through the production callback without a shell fork", async () => {
    const session = stubSession();
    const mkdirs: string[] = [];
    session.file = async (op: string, file: string) => {
      if (op === "mkdir") mkdirs.push(file);
      return true;
    };
    const budget = selfTestBudget();
    budget.perTrial.descendants = 2;
    budget.perTrial.toolCalls = 4;
    const ledger = new BudgetLedger(budget);
    ledger.open("helper");
    const admission = new TrialAdmission("helper", ledger, () => undefined, [
      "run_subagent",
      "shell",
    ]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const current = context();
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, current);
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
    const run = await startRuntime(admission, {
      botId: "bot-1",
      threadId: "thread",
      runId: "run",
      prompt: "synthetic",
      instructions: "",
      history: [],
      tools: "none",
      model: { provider: "custom", id: budget.model.id, baseUrl: route },
      admitHelper: async () => {
        const directory = await prepareDelegationWorkspace(
          prisma,
          computer,
          ref,
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
    });
    await run.authorizeTool!("run_subagent");
    const admitted = await run.admitHelper!("child-1", "helper", "synthetic");
    expect(admitted).toMatchObject({ id: "helper1", prompt: "tasks/rootTask/helper1" });
    expect(row.workspaceKind).toBe("artifacts");
    expect(mkdirs).toContain("workspace/tasks/rootTask/helper1");
    expect(ledger.snapshot().global.descendants).toBe(1);
  });

  it("cancels a command whose abort arrives while startup is still in flight", async () => {
    const session = stubSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let spawned = false;
    session.exec = async (_argv: string[], options?: { signal?: AbortSignal }) => {
      markStarted();
      await gate;
      if (options?.signal?.aborted) throw new Error("aborted before spawn");
      spawned = true;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit("close", 0), 20);
      return child;
    };
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("cancel");
    const admission = new TrialAdmission("cancel", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const controller = new AbortController();
    const current = context(controller.signal);
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, context());
    const run = await startRuntime(admission, {
      botId: "bot-1",
      threadId: "thread",
      runId: "run",
      prompt: "synthetic",
      instructions: "",
      history: [],
      tools: "none",
      model: { provider: "custom", id: budget.model.id, baseUrl: route },
      executeTool: async () => {
        const events = [];
        for await (const event of computer.execute(
          ref,
          { argv: ["printf", "must-not-finish"], timeoutMs: 5_000 },
          current,
        ))
          events.push(event);
        return events;
      },
    });
    await run.authorizeTool!("shell");
    const pending = run.executeTool!("shell", {}, "cancel-1");
    await started;
    controller.abort();
    release();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(spawned).toBe(false);
  });

  it("does not report cancellation until a running guest has stopped", async () => {
    const session = stubSession();
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    let destroyStarted = false;
    session.destroy = async () => {
      destroyStarted = true;
      await destroyGate;
    };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    session.exec = async (_argv: string[], options?: { signal?: AbortSignal }) => {
      markStarted();
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      options?.signal?.addEventListener("abort", () => child.emit("close", null), { once: true });
      return child;
    };
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("cancel-running");
    const admission = new TrialAdmission("cancel-running", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const controller = new AbortController();
    const current = context(controller.signal);
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, context());
    const run = await startRuntime(admission, {
      botId: "bot-1",
      threadId: "thread",
      runId: "run",
      prompt: "synthetic",
      instructions: "",
      history: [],
      tools: "none",
      model: { provider: "custom", id: budget.model.id, baseUrl: route },
      executeTool: async () => {
        const events = [];
        for await (const event of computer.execute(
          ref,
          { argv: ["printf", "still-running"], timeoutMs: 5_000 },
          current,
        ))
          events.push(event);
        return events;
      },
    });
    await run.authorizeTool!("shell");
    let settled = false;
    const pending = run.executeTool!("shell", {}, "cancel-running");
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await started;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      expect(destroyStarted).toBe(true);
    } finally {
      releaseDestroy();
    }
    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cancelled/);
    expect((error as Error).message).not.toMatch(/uncertain/);
  });

  it("reports a timed-out stop of a running guest as uncertain", async () => {
    const session = stubSession();
    session.destroy = () => new Promise(() => undefined);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    session.exec = async (_argv: string[], options?: { signal?: AbortSignal }) => {
      markStarted();
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      options?.signal?.addEventListener("abort", () => child.emit("close", null), { once: true });
      return child;
    };
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("cancel-uncertain");
    const admission = new TrialAdmission("cancel-uncertain", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    computer.cancelWaitMs = 80;
    const controller = new AbortController();
    const current = context(controller.signal);
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, context());
    const run = await startRuntime(admission, {
      botId: "bot-1",
      threadId: "thread",
      runId: "run",
      prompt: "synthetic",
      instructions: "",
      history: [],
      tools: "none",
      model: { provider: "custom", id: budget.model.id, baseUrl: route },
      executeTool: async () => {
        const events = [];
        for await (const event of computer.execute(
          ref,
          { argv: ["printf", "still-running"], timeoutMs: 5_000 },
          current,
        ))
          events.push(event);
        return events;
      },
    });
    await run.authorizeTool!("shell");
    const pending = run.executeTool!("shell", {}, "cancel-uncertain");
    await started;
    controller.abort();
    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "The command's cancellation timed out, so its outcome is uncertain.",
    );
    expect((error as Error).message.toLowerCase()).not.toContain("cancelled");
  });

  it("keeps the team-folder preparation outside admission and refuses other commands", async () => {
    const session = stubSession();
    const mkdirs: string[] = [];
    session.file = async (op: string, file: string) => {
      if (op === "mkdir") mkdirs.push(file);
      return true;
    };
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("boot");
    const admission = new TrialAdmission("boot", ledger, () => undefined, ["shell"]);
    admission.bindModel(route, budget.model.id);
    const computer = new ContainerComputer(session, getTask("task-01"), admission);
    const current = context();
    const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, current);
    const events = [];
    for await (const event of computer.execute(
      ref,
      { argv: ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(current.botId)] },
      current,
    ))
      events.push(event);
    expect(events).toEqual([{ type: "exit", code: 0 }]);
    expect(mkdirs).toEqual(["workspace/shared", "workspace/bots/bot-1"]);
    await expect(async () => {
      for await (const _event of computer.execute(ref, { argv: ["printf", "no"] }, current)) {
        /* Unadmitted work must not produce events. */
      }
    }).rejects.toThrow(/Unadmitted/);
  });
});
