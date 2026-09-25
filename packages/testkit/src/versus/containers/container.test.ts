import type { AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { contentDigest } from "../../scoreboard/manifest.js";
import { BudgetLedger } from "../budget.js";
import { selfTestBudget } from "../self-test.js";
import { TrialAdmission } from "./admission.js";
import type { ContainerInspection } from "./policy.js";
import {
  COMPUTER_IMAGE,
  CONTAINER_SECCOMP,
  containerPolicy,
  validateContainerInspection,
} from "./policy.js";
import { assertContainerProof } from "./session.js";

function inspected() {
  const policy = containerPolicy(COMPUTER_IMAGE, COMPUTER_IMAGE, selfTestBudget(), 30000);
  const value: ContainerInspection = {
    Id: "a".repeat(64),
    Image: COMPUTER_IMAGE,
    Config: {
      User: policy.user,
      Env: [],
      Labels: { "ardur.versus.owner": "fixture", "ardur.versus.policy": contentDigest(policy) },
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      Memory: policy.memoryBytes,
      MemorySwap: policy.memoryBytes,
      PidsLimit: policy.processes,
      CpuPeriod: policy.cpuPeriodUs,
      CpuQuota: policy.cpuQuotaUs,
      Tmpfs: {
        "/opt/data": `rw,nosuid,nodev,noexec,size=${policy.diskBytes},mode=770,uid=65531,gid=65532`,
      },
      SecurityOpt: ["no-new-privileges", `seccomp=${JSON.stringify(CONTAINER_SECCOMP)}`],
      IpcMode: "none",
      CgroupnsMode: "private",
      PidMode: "",
      Binds: null,
      Devices: [],
      LogConfig: { Type: "none" },
    },
    Mounts: [],
  };
  return { policy, value };
}
describe("container authority contract (offline)", () => {
  it("freezes policy and refuses caller-forged proofs even with valid-looking cgroup values", () => {
    const { policy, value } = inspected();
    validateContainerInspection(policy, value, "fixture");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() =>
      assertContainerProof(
        {
          mechanism: "linux-cgroup-v2",
          policyHash: contentDigest(policy),
          containerHash: contentDigest(value),
          ownership: { id: value.Id, label: "fixture" },
          cgroup: {},
        },
        policy,
        value.Id,
      ),
    ).toThrow("Unissued");
  });
  it.each([
    (v: ContainerInspection) => {
      v.HostConfig.Memory = 0;
    },
    (v: ContainerInspection) => {
      v.HostConfig.MemorySwap = -1;
    },
    (v: ContainerInspection) => {
      v.HostConfig.CpuQuota = -1;
    },
    (v: ContainerInspection) => {
      v.HostConfig.PidsLimit = 0;
    },
    (v: ContainerInspection) => {
      v.HostConfig.ReadonlyRootfs = false;
    },
    (v: ContainerInspection) => {
      v.HostConfig.Privileged = true;
    },
    (v: ContainerInspection) => {
      v.HostConfig.NetworkMode = "bridge";
    },
    (v: ContainerInspection) => {
      v.HostConfig.IpcMode = "private";
    },
    (v: ContainerInspection) => {
      v.HostConfig.PidMode = "host";
    },
    (v: ContainerInspection) => {
      v.HostConfig.CapAdd = ["SYS_ADMIN"];
    },
    (v: ContainerInspection) => {
      v.HostConfig.SecurityOpt = ["seccomp=unconfined"];
    },
    (v: ContainerInspection) => {
      v.HostConfig.Tmpfs["/tmp"] = "rw,size=1m";
    },
    (v: ContainerInspection) => {
      v.HostConfig.Binds = ["/trial:/opt/data"];
    },
    (v: ContainerInspection) => {
      v.Mounts.push({ Type: "volume", Destination: "/extra", RW: true });
    },
    (v: ContainerInspection) => {
      v.HostConfig.LogConfig.Type = "json-file";
    },
    (v: ContainerInspection) => {
      v.Config.User = "0:0";
    },
    (v: ContainerInspection) => {
      v.Image = `sha256:${"0".repeat(64)}`;
    },
  ])("refuses drift before a product process is admitted (%#)", (change) => {
    const { policy, value } = inspected();
    change(value);
    expect(() => validateContainerInspection(policy, value, "fixture")).toThrow();
  });
  it("refuses mutable image references and deadlines or resources outside the finite envelope", () => {
    const budget = selfTestBudget();
    expect(() => containerPolicy("computer:latest", COMPUTER_IMAGE, budget, 30000)).toThrow();
    expect(() => containerPolicy(COMPUTER_IMAGE, COMPUTER_IMAGE, budget, Infinity)).toThrow();
    expect(() =>
      containerPolicy(COMPUTER_IMAGE, COMPUTER_IMAGE, budget, budget.perTrial.wallMs + 1),
    ).toThrow();
    budget.resources.diskBytes = 4 * 1024 * 1024 * 1024;
    expect(() => containerPolicy(COMPUTER_IMAGE, COMPUTER_IMAGE, budget, 30000)).toThrow();
  });
  it("keeps CPU bandwidth identical when product preparation consumes different wall time", () => {
    const budget = selfTestBudget();
    budget.resources.cpuMs = 20000;
    const first = containerPolicy(COMPUTER_IMAGE, COMPUTER_IMAGE, budget, 30000);
    const second = containerPolicy(COMPUTER_IMAGE, COMPUTER_IMAGE, budget, 29000);
    expect(first.cpuQuotaUs).toBe(second.cpuQuotaUs);
    expect(first.cpuPeriodUs).toBe(second.cpuPeriodUs);
  });
});

const route = `http://127.0.0.1:12345/c/cap_${"a".repeat(48)}/v1`;
function runtimeFixture() {
  const budget = selfTestBudget();
  budget.perTrial.toolCalls = 2;
  budget.perTrial.descendants = 1;
  const ledger = new BudgetLedger(budget);
  ledger.open("trial");
  const emit = vi.fn();
  const admission = new TrialAdmission("trial", ledger, emit, [
    "write_file",
    "run_subagent",
    "shell",
  ]);
  admission.bindModel(route, budget.model.id);
  let wrapped!: AgentRunRequest;
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
    run: async function* (request) {
      wrapped = request;
      yield { type: "done" };
    },
    abort: async () => undefined,
  };
  admission.install(runtime);
  const effect = vi.fn(async () => {
    admission.requireEffect("write_file");
    return { ok: true };
  });
  const helper = vi.fn(async () => ({
    id: "helper-1",
    tokens: 10,
    deadlineAt: new Date(Date.now() + 10000).toISOString(),
  }));
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "synthetic",
    instructions: "",
    history: [],
    tools: "none",
    model: { provider: "custom", id: budget.model.id, baseUrl: route },
    executeTool: effect,
    admitHelper: helper,
    executeHelperTool: effect,
  };
  const start = async (value = request) => {
    for await (const _event of runtime.run(value)) {
      /* Capture the wrapped production boundary. */
    }
    return wrapped;
  };
  return { budget, ledger, admission, start, request, effect, helper, emit };
}
describe("pre-effect and descendant admission", () => {
  it("charges before dispatch, scopes the exact intent, and never dispatches after budget denial", async () => {
    const f = runtimeFixture(),
      run = await f.start();
    await expect(run.executeTool!("write_file", {}, "unadmitted")).rejects.toThrow("skipped");
    expect(f.effect).not.toHaveBeenCalled();
    await run.authorizeTool!("write_file");
    expect(f.ledger.snapshot().global.toolCalls).toBe(1);
    await run.executeTool!("write_file", { path: "result.json" }, "admitted");
    expect(f.effect).toHaveBeenCalledTimes(1);
    expect(f.admission.current()).toBeUndefined();
    await run.authorizeTool!("write_file");
    await run.executeTool!("write_file", {}, "second");
    await expect(run.authorizeTool!("write_file")).rejects.toThrow();
    expect(f.effect).toHaveBeenCalledTimes(2);
    expect(
      f.emit.mock.calls.some(
        ([kind, , data]) =>
          kind === "tool-intent" &&
          data.preEffectBudgetAdmission &&
          data.productPrevention === false,
      ),
    ).toBe(true);
  });
  it("retains product denial without issuing an execution permit", async () => {
    const f = runtimeFixture();
    const denied = { content: [{ type: "text" as const, text: "Denied by product" }], details: {} };
    const run = await f.start({ ...f.request, authorizeTool: async () => denied });
    expect(await run.authorizeTool!("write_file")).toBe(denied);
    await expect(run.executeTool!("write_file", {}, "denied")).rejects.toThrow("skipped");
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.ledger.snapshot().global.toolCalls).toBe(1);
  });
  it("admits helper work and refuses further descendants or unadmitted helper effects", async () => {
    const f = runtimeFixture(),
      run = await f.start();
    await expect(run.executeHelperTool!("missing", "write_file", {}, "tool")).rejects.toThrow(
      "descendant",
    );
    await run.authorizeTool!("run_subagent");
    await run.admitHelper!("child-1", "helper", "synthetic");
    expect(f.ledger.snapshot().global.descendants).toBe(1);
    await run.authorizeTool!("write_file");
    await run.executeHelperTool!("helper-1", "write_file", {}, "tool");
    expect(f.effect).toHaveBeenCalledTimes(1);
    expect(() => f.admission.descendant("extra-command")).toThrow();
    expect(f.helper).toHaveBeenCalledTimes(1);
  });
  it("pins the model route for main and helper work before calling a runtime", async () => {
    const f = runtimeFixture();
    await expect(
      f.start({
        ...f.request,
        model: { ...f.request.model, baseUrl: "http://127.0.0.1:11434/v1" },
      }),
    ).rejects.toThrow("route drift");
    const run = await f.start();
    await expect(run.resolveModel!("custom", "other-model")).rejects.toThrow("route drift");
    expect(await run.resolveModel!("custom", f.budget.model.id)).toBe(f.request.model);
    expect(() => f.admission.bindModel(route, f.budget.model.id)).toThrow("already frozen");
  });
  it("counts and refuses undeclared tools and recognizes only this broker's discovered names", async () => {
    const f = runtimeFixture(),
      run = await f.start();
    await expect(run.authorizeTool!("mcp__untrusted__write_file")).rejects.toThrow("undeclared");
    expect(f.ledger.snapshot().global.toolCalls).toBe(1);
    await expect(run.authorizeTool!("mcp__scoreboard__write_file")).resolves.toBeUndefined();
  });
});
