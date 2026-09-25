import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createTrialDirectory, destroyOwnedDirectory } from "../isolation.js";
import { selfTestBudget } from "../self-test.js";
import { qualifyCancellation, qualifyOrdinaryExecution } from "./ordinary.js";
import { COMPUTER_IMAGE } from "./policy.js";
import { ContainerSession } from "./session.js";

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

it.skipIf(!imageReady)(
  "drives ordinary executor work in the confined lane (skipped when the cached computer image or local Docker engine is absent; CI does not provide this lane)",
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "versus-ordinary-"));
    const resource = await createTrialDirectory(parent);
    const budget = selfTestBudget();
    budget.resources = {
      ...budget.resources,
      memoryBytes: 100663296,
      diskBytes: 8388608,
      processes: 24,
      cpuMs: 20000,
    };
    budget.perTrial = { ...budget.perTrial, wallMs: 120000 };
    const open = () =>
      ContainerSession.open({
        root: resource.state,
        image: COMPUTER_IMAGE,
        budget,
        wallMs: 60000,
      });
    const sessions: ContainerSession[] = [];
    try {
      const session = await open();
      sessions.push(session);
      const checks = await qualifyOrdinaryExecution(session);
      const cancellation = await open();
      sessions.push(cancellation);
      checks.push(...(await qualifyCancellation(cancellation)));
      const failed = checks.filter((check) => !check.passed);
      expect(failed).toEqual([]);
    } finally {
      for (const session of sessions) await session.destroy().catch(() => undefined);
      await destroyOwnedDirectory(resource).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  },
  180_000,
);
