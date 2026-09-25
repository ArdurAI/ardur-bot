import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { BudgetLedger } from "../budget.js";
import { createTrialDirectory, destroyOwnedDirectory } from "../isolation.js";
import { selfTestBudget } from "../self-test.js";
import { TrialAdmission } from "./admission.js";
import { ContainerComputer } from "./computer.js";
import { SYMLINK_REFUSAL } from "./guest.js";
import { COMPUTER_IMAGE } from "./policy.js";
import { ContainerSession, docker } from "./session.js";

const UNCERTAIN = "The command's cancellation timed out, so its outcome is uncertain.";

// GitHub CI has no cached computer image and must not require Docker.
const imageReady = (() => {
  try {
    execFileSync("docker", ["image", "inspect", COMPUTER_IMAGE, "--format", "{{.Id}}"], {
      stdio: "ignore",
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
})();

const route = `http://127.0.0.1:1/c/cap_${"c".repeat(48)}/v1`;

function context(signal = new AbortController().signal) {
  return {
    operationId: "boundary",
    traceId: "boundary",
    spaceId: "space",
    userId: "user",
    botId: "bot-1",
    signal,
  };
}

async function openSession() {
  const parent = await mkdtemp(path.join(tmpdir(), "versus-boundary-"));
  const resource = await createTrialDirectory(parent);
  const budget = selfTestBudget();
  budget.resources = {
    ...budget.resources,
    memoryBytes: 100663296,
    diskBytes: 8388608,
    processes: 24,
    cpuMs: 20000,
  };
  budget.perTrial = { ...budget.perTrial, wallMs: 120000, descendants: 8, toolCalls: 8 };
  const session = await ContainerSession.open({
    root: resource.state,
    image: COMPUTER_IMAGE,
    budget,
    wallMs: 60000,
  });
  return {
    session,
    async close() {
      await session.destroy().catch(() => undefined);
      await destroyOwnedDirectory(resource).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function execCode(session: ContainerSession, script: string) {
  const child = await session.exec(["/usr/bin/python3", "-I", "-S", "-c", script]);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(stderr || `guest command exited ${code}`);
}

it.skipIf(!imageReady)(
  "refuses a workspace symlink into trial state for list, read, and write",
  async () => {
    const opened = await openSession();
    try {
      const budget = selfTestBudget();
      const ledger = new BudgetLedger(budget);
      ledger.open("symlink");
      const admission = new TrialAdmission("symlink", ledger, () => undefined, ["shell"]);
      const computer = new ContainerComputer(opened.session, getTask("task-01"), admission);
      const current = context();
      const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, current);
      await opened.session.write("state/config.yaml", "broker: true\n");
      await opened.session.write("state/query.txt", "synthetic query\n");
      await execCode(
        opened.session,
        "import os; os.symlink('/opt/data/state', '/opt/data/workspace/leak')",
      );
      for (const action of [
        () => computer.listFiles(ref, "leak", current),
        () => computer.readFile(ref, "leak/config.yaml", current),
        () =>
          computer.writeFile(
            ref,
            { path: "leak/config.yaml", content: Buffer.from("replaced") },
            current,
          ),
      ]) {
        const error = await action().then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(SYMLINK_REFUSAL);
        expect((error as Error).message.includes("\n")).toBe(false);
      }
      expect((await opened.session.read("state/config.yaml")).toString()).toBe("broker: true\n");
    } finally {
      await opened.close();
    }
  },
  90_000,
);

it.skipIf(!imageReady)(
  "does not resolve cancellation while the guest can still write",
  async () => {
    const opened = await openSession();
    try {
      const budget = selfTestBudget();
      const ledger = new BudgetLedger(budget);
      ledger.open("cancel-write");
      const admission = new TrialAdmission("cancel-write", ledger, () => undefined, ["shell"]);
      admission.bindModel(route, budget.model.id);
      const computer = new ContainerComputer(opened.session, getTask("task-01"), admission);
      const controller = new AbortController();
      const current = context(controller.signal);
      const ref = await computer.provision({ botId: "home-1", homePath: "unused" }, context());
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
      for await (const _event of runtime.run({
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
            {
              argv: [
                "python3",
                "-c",
                [
                  "import time",
                  "handle=open('/opt/data/workspace/started.txt','w')",
                  "handle.write('yes')",
                  "handle.flush(); handle.close()",
                  "while True:",
                  "    handle=open('/opt/data/workspace/effect.txt','w')",
                  "    handle.write('later-effect-writer\\n')",
                  "    handle.flush(); handle.close()",
                  "    time.sleep(0.05)",
                ].join("\n"),
              ],
              timeoutMs: 20_000,
            },
            current,
          ))
            events.push(event);
          return events;
        },
      })) {
        /* Install the production admission wrapper. */
      }
      await wrapped.authorizeTool!("shell");
      const pending = wrapped.executeTool!("shell", {}, "cancel-write");
      const deadline = Date.now() + 15_000;
      let started = false;
      while (Date.now() < deadline) {
        try {
          if ((await opened.session.read("workspace/started.txt")).toString().includes("yes")) {
            started = true;
            break;
          }
        } catch {
          /* The guest has not created the file yet. */
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(started).toBe(true);
      controller.abort();
      const error = await pending.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cancelled/);
      expect((error as Error).message).not.toBe(UNCERTAIN);
      let running = "gone";
      try {
        running = await docker(
          ["inspect", "--format", "{{.State.Running}}", opened.session.id],
          8000,
        );
      } catch {
        running = "gone";
      }
      let probe = "";
      try {
        probe = await docker(
          [
            "exec",
            "--user",
            opened.session.policy.productUser,
            opened.session.id,
            "/usr/bin/python3",
            "-I",
            "-S",
            "-c",
            [
              "import os,time",
              "alive=False",
              "me=str(os.getpid())",
              "for name in os.listdir('/proc'):",
              "    if not name.isdigit() or name==me: continue",
              "    try: cmd=open('/proc/'+name+'/cmdline','rb').read()",
              "    except OSError: continue",
              "    if b'later-effect-writer' in cmd: alive=True",
              "print('GUEST_ALIVE' if alive else 'GUEST_DEAD')",
              "before=open('/opt/data/workspace/effect.txt').read() if os.path.exists('/opt/data/workspace/effect.txt') else ''",
              "time.sleep(0.2)",
              "after=open('/opt/data/workspace/effect.txt').read() if os.path.exists('/opt/data/workspace/effect.txt') else ''",
              "print('GREW' if after!=before else 'STABLE')",
            ].join("\n"),
          ],
          8000,
        );
      } catch {
        probe = "not-running";
      }
      expect(running).not.toBe("true");
      expect(probe).not.toContain("GUEST_ALIVE");
      expect(probe).not.toContain("GREW");
      expect(probe === "not-running" || probe.includes("GUEST_DEAD")).toBe(true);
      expect(probe === "not-running" || probe.includes("STABLE")).toBe(true);
    } finally {
      await opened.close();
    }
  },
  90_000,
);
