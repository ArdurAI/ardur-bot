import type { DesktopLocalStackState } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ArdurCommandInstaller } from "./command.js";
import type { GuidedStepsDependencies, PrerequisiteBoundary } from "./steps.js";
import { firstGuidedSteps, MIN_FREE_BYTES } from "./steps.js";

function fixture() {
  let owned = false;
  let ready = false;
  const prerequisites: PrerequisiteBoundary = {
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    binaries: async () => true,
    writable: async () => true,
    freeBytes: async () => MIN_FREE_BYTES,
    translated: async () => false,
    now: () => 100,
  };
  const stop = vi.fn(async () => undefined);
  const localMode = {
    databaseReady: async () => owned,
    migrationsReady: async () => ready,
    prepareDatabase: async () => {
      owned = true;
      return { phase: "database" } as DesktopLocalStackState;
    },
    applyMigrations: async () => {
      ready = true;
      return { phase: "migrations" } as DesktopLocalStackState;
    },
    stop,
  };
  const command = {
    check: async () => "needed",
    install: async () => ({ kind: "owned", proof: "owned-link" }),
    reconcile: async () => undefined,
  } as unknown as ArdurCommandInstaller;
  const deps: GuidedStepsDependencies = { prerequisites, localMode, command };
  return {
    deps,
    localMode,
    stop,
    setOwned: (value: boolean) => {
      owned = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}
const context = { runId: "test-run" };

describe("first guided steps", () => {
  it("blocks unsupported or incomplete computers and records macOS notices as data", async () => {
    const f = fixture();
    const step = firstGuidedSteps(f.deps)[0]!;
    const signal = new AbortController().signal;
    expect((await step.check(context, signal)).kind).toBe("satisfied");
    f.deps.prerequisites.translated = async () => true;
    expect(await step.check(context, signal)).toMatchObject({
      details: [
        { text: "This preview is unsigned and not notarized." },
        { text: "This app is running with Rosetta." },
        { text: "Download the Apple Silicon version" },
      ],
    });
    f.deps.prerequisites.arch = "other";
    expect(await step.check(context, signal)).toMatchObject({
      kind: "blocked",
      reasonCode: "unsupported-computer",
    });
    f.deps.prerequisites.arch = "arm64";
    f.deps.prerequisites.freeBytes = async () => MIN_FREE_BYTES - 1;
    expect(await step.check(context, signal)).toMatchObject({
      kind: "blocked",
      reasonCode: "insufficient-space",
    });
  });

  it("adopts a database only after the owned folder responds", async () => {
    const f = fixture();
    const database = firstGuidedSteps(f.deps)[1]!;
    const signal = new AbortController().signal;
    expect(await database.check(context, signal)).toMatchObject({ kind: "needed" });
    const receipt = await database.run(context, signal);
    expect(await database.verify(context, receipt, signal)).toMatchObject({
      kind: "satisfied",
      evidence: "owned-data-folder",
    });
    f.setOwned(false);
    expect(await database.verify(context, receipt, signal)).toMatchObject({
      kind: "blocked",
      reasonCode: "database-ownership-unconfirmed",
    });
  });

  it("records database ownership only when this setup starts it", async () => {
    const f = fixture();
    const ownership = { databaseStartedHere: false };
    f.deps.ownership = ownership;
    const database = firstGuidedSteps(f.deps)[1]!;
    const signal = new AbortController().signal;
    expect(await database.check(context, signal)).toMatchObject({ kind: "needed" });
    expect(ownership.databaseStartedHere).toBe(false);
    await database.run(context, signal);
    expect(ownership.databaseStartedHere).toBe(true);
    f.setOwned(true);
    const existing = { databaseStartedHere: false };
    f.deps.ownership = existing;
    const adopted = firstGuidedSteps(f.deps)[1]!;
    expect(await adopted.check(context, signal)).toMatchObject({ kind: "satisfied" });
    expect(existing.databaseStartedHere).toBe(false);
  });

  it("passes cancellation into the migration wrapper and waits for its settlement", async () => {
    const f = fixture();
    f.setOwned(true);
    let resolve!: (value: DesktopLocalStackState) => void;
    let observedSignal: AbortSignal | undefined;
    f.localMode.applyMigrations = async (signal) => {
      observedSignal = signal;
      return new Promise<DesktopLocalStackState>((done) => {
        resolve = done;
      });
    };
    const migrations = firstGuidedSteps(f.deps)[2]!;
    const controller = new AbortController();
    const running = migrations.run(context, controller.signal);
    controller.abort();
    expect(observedSignal?.aborted).toBe(true);
    await migrations.cancel(context, null);
    expect(f.stop).toHaveBeenCalledOnce();
    resolve({ phase: "idle" } as DesktopLocalStackState);
    await running;
  });

  it("leaves the untested Windows command unavailable and skippable", async () => {
    const f = fixture();
    f.deps.prerequisites.platform = "win32";
    const command = firstGuidedSteps(f.deps)[3]!;
    expect(command.canSkip).toBe(true);
    expect(await command.check(context, new AbortController().signal)).toMatchObject({
      kind: "notApplicable",
    });
  });

  it("describes available actions for a command owned by another app", async () => {
    const f = fixture();
    f.deps.command.check = async () => "collision";
    const command = firstGuidedSteps(f.deps)[3]!;
    expect(await command.check(context, new AbortController().signal)).toEqual({
      kind: "blocked",
      reasonCode: "command-collision",
      details: [
        {
          code: "command-collision",
          text: "Another app owns the ardur command. Skip this step, or remove or rename that command and retry.",
        },
      ],
    });
  });
});
