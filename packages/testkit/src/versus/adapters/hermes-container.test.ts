import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gradeOutcome } from "../../scoreboard/graders/outcome.js";
import { contentDigest } from "../../scoreboard/manifest.js";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../../scoreboard/tasks/reference.js";
import { BudgetLedger } from "../budget.js";
import {
  probeRetainedWorkspace,
  retainsReceiptsWithoutWorkspace,
} from "../containers/qualification.js";
import { createTrialDirectory, destroyOwnedDirectory } from "../isolation.js";
import { selfTestBudget } from "../self-test.js";
import { HermesContainerAdapter } from "./hermes-container.js";

const inspectImage = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
vi.mock("../containers/session.js", () => ({
  inspectImage,
  ContainerSession: { open },
}));

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function retain(
  entries: Record<string, string | { kind: "link" }>,
  cancelled: boolean,
  snapshot: () => Promise<unknown> = async () => entries,
) {
  inspectImage.mockResolvedValue({ id: `sha256:${"ab".repeat(32)}`, revision: null });
  let active = true;
  const order: string[] = [];
  const session = {
    policy: {},
    proof: {},
    write: async () => undefined,
    read: async () => Buffer.from(""),
    file: async () => {
      if (!active) throw new Error("Container closed");
      return snapshot();
    },
    snapshot: async () => {
      order.push(active ? "snapshot" : "snapshot-closed");
      return session.file();
    },
    exec: async () => {
      if (!active) throw new Error("Container closed");
      throw new Error("must not start");
    },
    destroy: async () => {
      order.push("destroy");
      active = false;
    },
    bindRelay: () => ({
      providerUrl: "http://127.0.0.1:18080/provider",
      brokerUrl: "http://127.0.0.1:18080/broker",
    }),
  };
  open.mockResolvedValue(session);
  const parent = await mkdtemp(path.join(tmpdir(), "hermes-workspace-"));
  parents.push(parent);
  const trial = await createTrialDirectory(parent);
  const id = cancelled ? "container-cancel" : "container-loss";
  const task = getTask("task-04");
  const budget = selfTestBudget();
  const ledger = new BudgetLedger(budget);
  ledger.open(id);
  const adapter = new HermesContainerAdapter({
    ledger,
    standin: "raise RuntimeError('must not start')",
  });
  try {
    await adapter.prepare({
      id,
      pairId: id,
      task,
      workspace: trial.workspace,
      stateDirectory: trial.state,
      budget,
      providerUrl: "http://127.0.0.1:9/provider",
      brokerUrl: "unused",
      revokeProvider: () => undefined,
      emit: () => undefined,
      signal: new AbortController().signal,
    });
    const args = referenceSolution(task).updates[0]!;
    adapter.broker!.decide(contentDigest({ trialId: id, name: "SCOREBOARD_UPDATE", args }), true);
    await adapter.broker!.call("SCOREBOARD_UPDATE", args);
    const probed = await probeRetainedWorkspace(adapter, cancelled);
    const workspace = probed.workspace;
    const artifact = probed.artifact;
    const files = workspace ? workspace.files : artifact.observation.files;
    const links = workspace ? workspace.links : artifact.observation.links;
    const passed = retainsReceiptsWithoutWorkspace({
      cancelled,
      terminal: artifact.observation.terminal,
      effects: workspace ? workspace.effects : artifact.observation.effects,
      files,
      links,
      snapshot: workspace ? undefined : { error: "The workspace could not be inspected." },
      providerRequests: 0,
      gradedPassed: gradeOutcome(
        task,
        workspace
          ? {
              ...artifact.observation,
              files: workspace.files,
              links: workspace.links,
              snapshot: undefined,
            }
          : artifact.observation,
      ).passed,
    });
    return { links, files, passed, observation: artifact.observation, order };
  } finally {
    await adapter.destroy();
    await destroyOwnedDirectory(trial);
  }
}

it("fails container-cancel-retains-receipts-and-nonsuccess and container-loss-retains-receipts-and-nonsuccess when the workspace contains only a symlink", async () => {
  for (const cancelled of [true, false]) {
    const retained = await retain({ leak: { kind: "link" } }, cancelled);
    expect(retained.files).toEqual({});
    expect(retained.links).toEqual(["leak"]);
    expect(retained.passed).toBe(false);
    expect(retained.order.indexOf("snapshot")).toBeGreaterThanOrEqual(0);
    expect(retained.order.indexOf("snapshot")).toBeLessThan(retained.order.indexOf("destroy"));
  }
});

it("fails both retention probes when a non-UTF-8 file prevents the snapshot", async () => {
  for (const cancelled of [true, false]) {
    const retained = await retain({}, cancelled, async () => {
      throw new Error("Container operation refused: UnicodeDecodeError");
    });
    const observation = retained.observation as typeof retained.observation & {
      snapshot?: { error?: string };
    };
    expect(observation.snapshot?.error).toBe("The workspace could not be inspected.");
    expect(retained.passed).toBe(false);
    expect(retained.links).not.toEqual([]);
    expect(retained.files).not.toEqual({});
  }
  expect(
    retainsReceiptsWithoutWorkspace({
      cancelled: true,
      terminal: "cancelled",
      effects: [{}],
      files: {},
      links: undefined,
      providerRequests: 0,
      gradedPassed: false,
    }),
  ).toBe(false);
  expect(
    retainsReceiptsWithoutWorkspace({
      cancelled: false,
      terminal: "uncertain",
      effects: [{}],
      files: {},
      links: undefined,
      providerRequests: 0,
      gradedPassed: false,
    }),
  ).toBe(false);
});

it("passes cancel and loss retention when the workspace snapshot is empty", async () => {
  for (const cancelled of [true, false]) {
    const retained = await retain({}, cancelled);
    expect(retained.links).toEqual([]);
    expect(retained.passed).toBe(true);
    expect(retained.order.indexOf("snapshot")).toBeGreaterThanOrEqual(0);
    expect(retained.order.indexOf("snapshot")).toBeLessThan(retained.order.indexOf("destroy"));
  }
});
