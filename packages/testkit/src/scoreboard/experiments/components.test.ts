import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "../../../../adapters/src/fake-sandbox.js";
import { matrixExitCode } from "./catalog.js";
import { computerLifecycleExperiment } from "./components.js";

class EmptyReadSandbox extends FakeSandboxProvider {
  override async readFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

describe("computer lifecycle verdict", () => {
  it("passes when every executed check is true and keeps uncovered runners as gaps", async () => {
    const result = await computerLifecycleExperiment();
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.status).toBe("passed");
    expect(matrixExitCode([result], false)).toBe(0);
    expect(result.gaps.join(" ")).toMatch(/Docker/);
    expect(result.gaps.join(" ")).toMatch(/Kubernetes/);
  });
  it("is a finding when the desktop workspace does not retain its marker", async () => {
    const result = await computerLifecycleExperiment({ desktop: new EmptyReadSandbox() });
    expect(result.checks.retainedWorkspace).toBe(false);
    expect(result.status).toBe("finding");
    expect(matrixExitCode([result], false)).toBe(1);
    expect(result.gaps.length).toBeGreaterThan(0);
  });
});
