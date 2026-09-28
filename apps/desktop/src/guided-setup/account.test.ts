import { describe, expect, it, vi } from "vitest";
import { accountGuidedSteps } from "./account.js";
import { SetupEngine } from "./engine.js";
import type { JournalFileBoundary } from "./store.js";
import { SetupJournalStore } from "./store.js";

const signal = new AbortController().signal;
const context = { runId: "fixture" };

describe("account guided steps", () => {
  it("distinguishes a saved connection from a checked connection", async () => {
    let model: "saved" | "checked" = "saved";
    const steps = accountGuidedSteps({
      read: async () => ({ scope: "account-a", model, firstBot: false }),
      target: () => "target-a",
      machineReady: async () => true,
      appMounted: async () => true,
      now: () => 100,
    });
    expect(await steps[0]!.check(context, signal)).toMatchObject({
      kind: "satisfied",
      details: [{ code: "connection-saved", text: "Connection saved" }],
    });
    model = "checked";
    expect(await steps[0]!.check(context, signal)).toMatchObject({
      kind: "satisfied",
      details: [{ code: "connection-checked", text: "Connection checked" }],
    });
  });

  it("refuses stale target and account deferrals", async () => {
    let scope = "account-a";
    let target = "target-a";
    const steps = accountGuidedSteps({
      read: async () => ({ scope, model: "missing", firstBot: false }),
      target: () => target,
      machineReady: async () => true,
      appMounted: async () => true,
      now: () => 100,
    });
    const receipt = await steps[0]!.defer!(context);
    expect(receipt).toEqual({ kind: "owned", proof: "deferred:target-a:account-a" });
    scope = "account-b";
    expect(await steps[0]!.recheck!(context, signal, receipt)).toMatchObject({
      reasonCode: "account-scope-changed",
    });
    scope = "account-a";
    target = "target-b";
    expect(await steps[0]!.recheck!(context, signal, receipt)).toMatchObject({
      reasonCode: "account-scope-changed",
    });
  });

  it("requires a mounted document, saved target, and current machine health before finish", async () => {
    let mounted = false;
    const machineReady = vi.fn(async () => true);
    const steps = accountGuidedSteps({
      read: async () => null,
      target: () => "target-a",
      machineReady,
      appMounted: async () => mounted,
      now: () => 100,
    });
    expect(await steps[2]!.check(context, signal)).toMatchObject({ reasonCode: "app-not-mounted" });
    mounted = true;
    expect(await steps[2]!.check(context, signal)).toMatchObject({ kind: "satisfied" });
    expect(machineReady).toHaveBeenCalledTimes(2);
  });

  it("finishes honestly after deferral, then verifies saved goals without a second create", async () => {
    let raw: string | null = null;
    let model: "missing" | "saved" = "missing";
    let firstBot = false;
    let scope = "account-a";
    const files: JournalFileBoundary = {
      read: async () => raw,
      write: async (_file, value) => {
        raw = value;
      },
      exists: async () => raw !== null,
      ensure: async () => undefined,
    };
    const ready = async () => ({ kind: "satisfied" as const, checkedAt: 100, evidence: "ready" });
    const noRun = vi.fn(async () => ({ kind: "verified" as const, proof: "ready" }));
    const machine = [
      { id: "prerequisites" as const, requires: [] as const },
      { id: "database" as const, requires: ["prerequisites"] as const },
      { id: "migrations" as const, requires: ["database"] as const },
      { id: "command" as const, requires: ["migrations"] as const },
      { id: "services" as const, requires: ["migrations"] as const },
      { id: "engines" as const, requires: ["services"] as const },
    ].map((entry) => ({
      ...entry,
      revision: 1,
      canSkip: false,
      check: ready,
      recheck: ready,
      run: noRun,
      verify: ready,
      cancel: async () => undefined,
    }));
    const account = accountGuidedSteps({
      read: async () => ({ scope, model, firstBot }),
      target: () => "target-a",
      machineReady: async () => true,
      appMounted: async () => true,
      now: () => 100,
    });
    const engine = await SetupEngine.open(new SetupJournalStore("/fixture", files), [
      ...machine,
      ...account,
    ]);
    expect((await engine.start()).steps[6]?.status).toBe("waiting-input");
    await engine.skip("model");
    expect(engine.snapshot().steps[7]?.status).toBe("waiting-input");
    await engine.skip("first-bot");
    expect(engine.snapshot()).toMatchObject({
      machineReady: true,
      accountReady: false,
      complete: false,
    });
    expect(engine.snapshot().steps[8]?.status).toBe("succeeded");
    model = "saved";
    firstBot = true;
    const completed = await engine.recheckAccount();
    expect(completed).toMatchObject({ machineReady: true, accountReady: true, complete: true });
    expect(noRun).not.toHaveBeenCalled();
    expect((await engine.recheckAll()).complete).toBe(true);
    expect(noRun).not.toHaveBeenCalled();
    scope = "account-b";
    const stale = await engine.recheckAccount();
    expect(stale.steps[6]).toMatchObject({
      status: "waiting-input",
      reasonCode: "account-scope-changed",
    });
    expect(stale.steps[7]?.status).toBe("pending");
    expect(stale.steps[8]?.status).toBe("pending");
    expect(stale.complete).toBe(false);
  });
});
