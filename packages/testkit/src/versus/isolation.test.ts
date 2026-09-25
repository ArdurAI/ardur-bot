import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentDigest } from "../scoreboard/manifest.js";
import { getTask } from "../scoreboard/tasks/catalog.js";
import { startBroker, TrialBroker } from "./broker.js";
import { BudgetLedger } from "./budget.js";
import {
  assertIsolation,
  assertOwnedTrial,
  createTrialDirectory,
  destroyOwnedDirectory,
  minimalEnvironment,
  nativeProfile,
  proveNativeIsolation,
  safeFile,
} from "./isolation.js";
import { selfTestBudget } from "./self-test.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), "versus-isolation-test-"));
  roots.push(root);
  return root;
}
describe("isolated authority", () => {
  it("creates separate workspaces and state and refuses forged cleanup ownership", async () => {
    const root = await temporary();
    const a = await createTrialDirectory(root);
    const b = await createTrialDirectory(root);
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.state).not.toBe(a.workspace);
    await expect(assertOwnedTrial(a.workspace, a.state)).resolves.toBeUndefined();
    await expect(assertOwnedTrial(a.workspace, b.state)).rejects.toThrow("invocation-owned");
    await expect(destroyOwnedDirectory({ ...a, owner: "wrong" })).rejects.toThrow("ownership");
    await destroyOwnedDirectory(a);
    await expect(assertOwnedTrial(a.workspace, a.state)).rejects.toThrow("invocation-owned");
    expect(await readFile(path.join(b.root, ".versus-owner"), "utf8")).toBe(b.owner);
  });
  it("refuses traversal and symlink escapes before IO", async () => {
    const root = await temporary();
    const trial = await createTrialDirectory(root);
    await writeFile(path.join(root, "canary"), "synthetic");
    await symlink(root, path.join(trial.workspace, "escape"));
    for (const name of ["../canary", "/etc/passwd", "a/../../canary", "escape/canary", "a\0b"])
      await expect(safeFile(trial.workspace, name, true)).rejects.toThrow();
    expect(await safeFile(trial.workspace, "nested/result.json", true)).toContain(
      "nested/result.json",
    );
  });
  it("uses exact loopback egress and never accepts a caller-supplied passing canary", () => {
    const policy = {
      root: "/trial",
      readRoots: ["/install"],
      ports: [12345],
      forbiddenRoots: ["/hidden-grader"],
    };
    const profile = nativeProfile(policy);
    expect(profile).toContain('(remote ip "localhost:12345")');
    expect(profile).not.toContain("network*");
    expect(profile).toContain("auth[.]json");
    expect(() =>
      assertIsolation(
        {
          result: { passed: true } as never,
          profilePath: "fake",
          policyHash: contentDigest(policy),
        },
        policy,
      ),
    ).toThrow();
    expect(minimalEnvironment("/trial/state", "/install/bin/hermes")).not.toHaveProperty(
      "SSH_AUTH_SOCK",
    );
  });
  it("runs benign OS canaries and binds the result to the exact policy", async () => {
    const root = await temporary();
    const trial = await createTrialDirectory(root);
    const policy = { root: trial.root, readRoots: [], ports: [], forbiddenRoots: [] };
    const proof = await proveNativeIsolation(policy);
    expect(proof.result.mechanism).toBe("macos-sandbox-exec");
    if (proof.result.passed) {
      expect(Object.values(proof.result.checks).every(Boolean)).toBe(true);
      expect(() => assertIsolation(proof, policy)).not.toThrow();
      expect(() => assertIsolation(proof, { ...policy, ports: [9000] })).toThrow();
    } else expect(() => assertIsolation(proof, policy)).toThrow();
    expect(proof.result.resourceEnforcement).toBe("watchdog-only");
  });
});
describe("private semantic effect broker", () => {
  async function setup() {
    const root = await temporary();
    const trial = await createTrialDirectory(root);
    const ledger = new BudgetLedger(selfTestBudget());
    ledger.open("test-trial");
    const events: { kind: string; source: string; data: Record<string, unknown> }[] = [];
    const options = {
      trialId: "test-trial",
      task: getTask("task-04"),
      workspace: trial.workspace,
      journal: path.join(root, "effects.jsonl"),
      ledger,
      emit: (kind: string, source: string, data: Record<string, unknown>) => {
        events.push({ kind, source, data });
      },
    };
    const broker = new TrialBroker(options);
    await broker.prepare();
    return { broker, options, events, root };
  }
  it("requires an exact decision, persists a receipt once, and safely replays recovery", async () => {
    const { broker, options, events } = await setup();
    const args = { id: "case-a", revision: 7, value: { status: "resolved" } };
    await expect(broker.call("SCOREBOARD_UPDATE", args)).rejects.toThrow("decision");
    const hash = contentDigest({ trialId: options.trialId, name: "SCOREBOARD_UPDATE", args });
    broker.decide(hash, true);
    await expect(
      broker.call("SCOREBOARD_UPDATE", { ...args, value: { status: "deleted" } }),
    ).rejects.toThrow("decision");
    const receipt = await broker.call("SCOREBOARD_UPDATE", args);
    expect(receipt).toMatchObject({ id: "case-a", revision: 8, authorized: true });
    await expect(broker.call("SCOREBOARD_UPDATE", args)).rejects.toThrow("Stale");
    const recovered = new TrialBroker(options);
    await recovered.recover();
    expect((await recovered.snapshot()).effects).toHaveLength(1);
    expect(
      events
        .filter((event) => event.kind === "approval-decision")
        .every(
          (event) => event.source === "effect-broker" && event.data.productPrevention === false,
        ),
    ).toBe(true);
  });
  it("serializes racing effects, rejects unauthorized tools, and retains unsolicited artifacts", async () => {
    const { broker, options } = await setup();
    const args = { id: "case-a", revision: 7, value: { status: "resolved" } };
    broker.decide(
      contentDigest({ trialId: options.trialId, name: "SCOREBOARD_UPDATE", args }),
      true,
    );
    const outcomes = await Promise.allSettled([
      broker.call("SCOREBOARD_UPDATE", args),
      broker.call("SCOREBOARD_UPDATE", args),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(broker.call("execute", { command: "anything" })).rejects.toThrow("unauthorized");
    await writeFile(path.join(options.workspace, "unsolicited.json"), "{}");
    expect((await broker.snapshot()).files).toHaveProperty("unsolicited.json");
    broker.revoke();
    await expect(broker.call("SCOREBOARD_READ", {})).rejects.toThrow("revoked");
  });
  it("MCP exposes only the task's tools and no grader or foreign trial authority", async () => {
    const { broker } = await setup();
    const server = await startBroker(broker);
    try {
      const response = await fetch(server.url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = (await response.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((tool) => tool.name)).toEqual(getTask("task-04").allowedTools);
      expect(JSON.stringify(body)).not.toContain("grader");
      expect(
        (await fetch(server.url.replace(/cap_.+$/, "cap_invalid"), { method: "POST", body: "{}" }))
          .status,
      ).toBe(403);
    } finally {
      await server.close();
    }
  });
});
