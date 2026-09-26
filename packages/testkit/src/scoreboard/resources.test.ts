import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TraceBatch } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PerformanceEvidenceReport } from "../performance-report.js";
import { parsePerformanceEvidenceEnvelope } from "../performance-report.js";
import {
  CRASH_BOUNDARIES,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "./manifest.js";
import { runPackagedCli } from "./packaged/cli.js";
import type { ClientCapture } from "./packaged/evidence.js";
import {
  attachPackagedCapture,
  ingestClientCapture,
  ingestMobileCapture,
  ingestWebCapture,
} from "./packaged/evidence.js";
import { createPackagedPlan, packagedCoverage } from "./packaged/plan.js";
import { runPackagedPlan, writeImmutableReport } from "./packaged/runner.js";
import { replayCancellation } from "./replay/services.js";
import { collectPackagedArtifacts, inventoryArtifact } from "./resources/artifacts.js";
import { summarizeResourceAttempts } from "./resources/collector.js";
import type { ProcessReading, ResourceInventory } from "./resources/contracts.js";
import { attributeResources, measured, unavailable } from "./resources/contracts.js";
import type { EnergyBinding, PhysicalEnergyCapture } from "./resources/energy.js";
import { ingestPhysicalEnergy } from "./resources/energy.js";
import { createProcessSampler, parseCpuTime } from "./resources/process.js";
import { collectResourceProfile, RESOURCE_PROFILES } from "./resources/profiles.js";

const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), "packaged-contract-"));
  directories.push(result);
  return result;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { force: true, recursive: true });
});
const hash = (value: string) => contentDigest(value);

function inventory(): ResourceInventory {
  return {
    roles: {
      electron: "required",
      host: "required",
      api: "required",
      worker: "required",
      database: "required",
      vm: "required",
      "local-model": "not-applicable",
    },
    processes: [
      { id: "desktop", roles: ["electron"], domain: "host", coveredBy: null },
      { id: "host-service", roles: ["host"], domain: "host", coveredBy: null },
      { id: "services", roles: ["api", "worker"], domain: "host", coveredBy: null },
      { id: "container-vm", roles: ["vm"], domain: "host", coveredBy: null },
      { id: "postgres", roles: ["database"], domain: "guest", coveredBy: "container-vm" },
    ],
  };
}
function frame() {
  return {
    atMs: 100,
    processes: inventory().processes.map(
      (identity): ProcessReading => ({
        ...identity,
        memoryMetric: "rss",
        memoryBytes: measured(identity.id === "postgres" ? 800 : 100),
        highWaterBytes: unavailable(),
        cpuTimeMs: measured(0),
        wakeups: unavailable("unsupported"),
        diskWriteBytes: unavailable("unsupported"),
        networkBytes: unavailable("unsupported"),
      }),
    ),
  };
}

describe("whole-stack accounting", () => {
  it("refuses PID aliases and guest PIDs before reading any native process", () => {
    const declared = inventory();
    expect(() =>
      createProcessSampler([
        { pid: 1, identity: declared.processes[0]! },
        { pid: 1, identity: declared.processes[1]! },
      ]),
    ).toThrow(/aliases/);
    expect(() => createProcessSampler([{ pid: 1, identity: declared.processes[4]! }])).toThrow(
      /guest-side/,
    );
    expect(() =>
      attributeResources({ ...declared, extra: "not-exportable" } as ResourceInventory, frame()),
    ).toThrow(/fields/);
  });
  it("retains CPU counter resets and incomplete windows rather than reporting partial means", () => {
    const attempts = [0, 1, 2].map((n) => {
      const data = frame();
      data.atMs = n * 1000;
      data.processes.forEach((p) => {
        p.cpuTimeMs = measured([20, 5, 40][n]!);
      });
      return { scheduledMs: n * 1000, atMs: n * 1000, frame: data, status: "measured" as const };
    });
    const result = summarizeResourceAttempts(inventory(), attempts, true);
    expect(result.idleMeanBytes.value).toBe(400);
    expect(result.cpuTimeMs.value).toBeNull();
    expect(summarizeResourceAttempts(inventory(), attempts, false).idleMeanBytes.value).toBeNull();
  });
  it("counts co-located roles once and excludes guest memory already inside the VM", () => {
    const result = attributeResources(inventory(), frame());
    expect(result.memoryBytes.value).toBe(400);
    expect(result.excludedGuests).toEqual(["postgres"]);
    expect(result.sharedPagesMayOverlap).toBe(true);
    expect(result.wholeMachineIncremental.value).toBeNull();
  });
  it("retains measured zero while missing roles and unreadable processes make totals unknown", () => {
    const data = frame();
    data.processes.forEach((p) => {
      p.memoryBytes = measured(0);
    });
    expect(attributeResources(inventory(), data).memoryBytes.value).toBe(0);
    data.processes.pop();
    const result = attributeResources(inventory(), data);
    expect(result.memoryBytes.value).toBeNull();
    expect(result.missingRoles).toEqual(["database"]);
  });
  it("does not mix private bytes, RSS or a partial read into a complete footprint", () => {
    const data = frame();
    data.processes[0]!.memoryMetric = "private-bytes";
    expect(attributeResources(inventory(), data).memoryBytes.value).toBeNull();
    data.processes[0]!.memoryMetric = "rss";
    data.processes[2]!.memoryBytes = unavailable("invalid-trial");
    expect(attributeResources(inventory(), data).memoryBytes.value).toBeNull();
  });
  it("rejects undeclared, duplicate, cyclic and reclassified processes", () => {
    const data = frame();
    data.processes.push(data.processes[0]!);
    expect(() => attributeResources(inventory(), data)).toThrow(/duplicate/);
    const declared = inventory();
    declared.processes[3]!.coveredBy = "container-vm";
    expect(() => attributeResources(declared, frame())).toThrow();
    const changed = frame();
    changed.processes[0]!.roles = ["api"];
    expect(() => attributeResources(inventory(), changed)).toThrow(/changed/);
  });
  it.each([NaN, Infinity, -1])("rejects invalid resource values %s", (value) => {
    const data = frame();
    data.processes[0]!.memoryBytes.value = value;
    expect(() => attributeResources(inventory(), data)).toThrow();
  });
  it("parses cumulative CPU time without turning a percentage into joules", () => {
    expect(parseCpuTime("02:03.50")).toBe(123500);
    expect(parseCpuTime("1-02:03:04")).toBe(93784000);
    expect(() => parseCpuTime("25%")).toThrow();
  });
});

describe("stabilized profiles", () => {
  it.each(["stabilized-idle", "quiet-extension", "mixed-soak"] as const)(
    "retains the entire %s window and never overlaps samples",
    async (profile) => {
      let now = 0,
        active = false,
        work = 0;
      const times: number[] = [];
      const result = await collectResourceProfile({
        profile,
        signal: new AbortController().signal,
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
        sample: async () => {
          expect(active).toBe(false);
          active = true;
          await Promise.resolve();
          active = false;
          return { atMs: now, processes: [] };
        },
        mixedWork:
          profile === "mixed-soak"
            ? async () => {
                work++;
              }
            : undefined,
        onAttempt: async (attempt) => {
          times.push(attempt.scheduledMs);
        },
      });
      expect(result.complete).toBe(true);
      expect(times[0]).toBe(0);
      expect(times.at(-1)).toBe(RESOURCE_PROFILES[profile].durationMs);
      expect(result.attempts).toBe(RESOURCE_PROFILES[profile].durationMs / 1000 + 1);
      if (profile === "mixed-soak") expect(work).toBe(7200);
    },
  );
  it("records missed intervals and sampler failures without extending until green", async () => {
    let now = 0,
      count = 0;
    const statuses: string[] = [];
    const result = await collectResourceProfile({
      profile: "stabilized-idle",
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => {
        if (++count === 1) now += 3500;
        if (count === 2) throw new Error("gone");
        return { atMs: now, processes: [] };
      },
      onAttempt: async (attempt) => {
        statuses.push(attempt.status);
      },
    });
    expect(result.complete).toBe(false);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("missed");
    expect(result.attempts).toBe(901);
  });
  it("refuses a soak without work and retains cancellation as incomplete", async () => {
    const controller = new AbortController();
    let now = 0;
    await expect(
      collectResourceProfile({
        profile: "mixed-soak",
        signal: controller.signal,
        sample: async () => frame(),
        onAttempt: async () => {},
      }),
    ).rejects.toThrow(/workload/);
    const result = await collectResourceProfile({
      profile: "quiet-extension",
      signal: controller.signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => frame(),
      onAttempt: async () => {
        controller.abort();
      },
    });
    expect(result.attempts).toBe(1);
    expect(result.complete).toBe(false);
  });
  it("keeps a fully sampled soak when the collector cancels the last workload", async () => {
    let now = 0;
    let starts = 0;
    const result = await collectResourceProfile({
      profile: "mixed-soak",
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => ({ atMs: now, processes: [] }),
      mixedWork: (signal) =>
        new Promise<void>((_resolve, reject) => {
          starts++;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      onAttempt: async () => {},
    });
    expect(starts).toBe(1);
    expect(result.attempts).toBe(RESOURCE_PROFILES["mixed-soak"].durationMs / 1000 + 1);
    expect(result.failures).toBe(0);
    expect(result.missed).toBe(0);
    expect(result.workloadFailures).toBe(0);
    expect(result.complete).toBe(true);
  });
  it("counts a workload that fails for its own reason", async () => {
    let now = 0;
    let runs = 0;
    const result = await collectResourceProfile({
      profile: "mixed-soak",
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => ({ atMs: now, processes: [] }),
      mixedWork: async () => {
        runs++;
        if (runs === 1) throw new Error("workload broke");
      },
      onAttempt: async () => {},
    });
    expect(runs).toBeGreaterThan(1);
    expect(result.workloadFailures).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
    expect(result.attempts).toBe(RESOURCE_PROFILES["mixed-soak"].durationMs / 1000 + 1);
  });
  it("counts an unrelated workload failure raised during collector shutdown", async () => {
    let now = 0;
    const result = await collectResourceProfile({
      profile: "mixed-soak",
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => ({ atMs: now, processes: [] }),
      mixedWork: (signal) =>
        new Promise<void>((_resolve, reject) => {
          const cancel = () => reject(new Error("workload state corrupted during shutdown"));
          if (signal.aborted) {
            cancel();
            return;
          }
          signal.addEventListener("abort", cancel, { once: true });
        }),
      onAttempt: async () => {},
    });
    expect(result.attempts).toBe(RESOURCE_PROFILES["mixed-soak"].durationMs / 1000 + 1);
    expect(result.failures).toBe(0);
    expect(result.missed).toBe(0);
    expect(result.workloadFailures).toBe(1);
    expect(result.complete).toBe(false);
  });
  it("keeps the replay service's signal-bound cancellation shape", async () => {
    let now = 0;
    const result = await collectResourceProfile({
      profile: "mixed-soak",
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => ({ atMs: now, processes: [] }),
      mixedWork: (signal) =>
        new Promise<void>((_resolve, reject) => {
          const cancel = () => reject(replayCancellation(signal));
          if (signal.aborted) {
            cancel();
            return;
          }
          signal.addEventListener("abort", cancel, { once: true });
        }),
      onAttempt: async () => {},
    });
    expect(result.workloadFailures).toBe(0);
    expect(result.complete).toBe(true);
  });
  it("counts a late unrelated AbortError after the window as a workload failure", async () => {
    let now = 0;
    let rejectLater: ((error: unknown) => void) | undefined;
    const duration = RESOURCE_PROFILES["mixed-soak"].durationMs;
    const result = await collectResourceProfile({
      profile: "mixed-soak",
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      sample: async () => ({ atMs: now, processes: [] }),
      mixedWork: () =>
        new Promise<void>((_resolve, reject) => {
          rejectLater = reject;
        }),
      onAttempt: async (attempt) => {
        if (attempt.scheduledMs === duration)
          setTimeout(() => {
            rejectLater?.(new DOMException("The operation was aborted.", "AbortError"));
          }, 0);
      },
    });
    expect(result.attempts).toBe(duration / 1000 + 1);
    expect(result.workloadFailures).toBe(1);
    expect(result.complete).toBe(false);
  });
});

const energyBinding: EnergyBinding = {
  artifactHash: hash("app"),
  environmentHash: hash("environment"),
  workloadHash: hash("task"),
  platform: "darwin",
  hardwareClass: "physical-laptop",
  conditionsHash: hash("display-radios-power"),
  durationMs: 2000,
};
function energy(linkIdle = true): PhysicalEnergyCapture {
  return {
    version: 1,
    binding: energyBinding,
    physical: true,
    measuredAt: "2026-09-25T00:00:00.000Z",
    instrument: {
      id: "meter-01",
      method: "power-meter",
      scope: "whole-system",
      calibrationHash: hash("calibration"),
      calibratedAt: "2026-09-24T00:00:00.000Z",
      validUntil: "2026-09-26T00:00:00.000Z",
      uncertaintyPercent: 2,
    },
    samples: [
      { atMs: 0, value: 5 },
      { atMs: 1000, value: 7 },
      { atMs: 2000, value: 9 },
    ],
    idleControlHash: linkIdle ? contentDigest(energy(false)) : null,
  };
}
const idle = () => energy(false);
describe("physical energy ingestion", () => {
  it("integrates actual instrument watts and preserves scope and calibration", () => {
    const result = ingestPhysicalEnergy(energy(), energyBinding, idle());
    expect(result.joules.value).toBe(14);
    expect(result.averageWatts.value).toBe(7);
    expect(result.uncertaintyPercent).toBe(2);
  });
  it("accepts measured zero and refuses to equate CPU-package energy with system energy", () => {
    const data = energy();
    data.instrument.method = "joule-counter";
    data.instrument.scope = "cpu-package";
    data.samples.forEach((sample) => {
      sample.value = 20;
    });
    const control = { ...idle(), instrument: data.instrument };
    data.idleControlHash = contentDigest(control);
    const result = ingestPhysicalEnergy(data, energyBinding, control);
    expect(result.joules.value).toBe(0);
    expect(result.systemEnergy.value).toBeNull();
  });
  it.each(["calibration", "gap", "counter-reset", "binding", "idle", "fake", "unknown-field"])(
    "rejects %s evidence",
    (fault) => {
      const data = energy();
      const control = idle();
      if (fault === "calibration") data.instrument.validUntil = data.measuredAt;
      if (fault === "gap") data.samples.splice(1, 1);
      if (fault === "counter-reset") {
        data.instrument.method = "joule-counter";
        data.samples[1]!.value = 0;
      }
      if (fault === "binding") data.binding = { ...data.binding, artifactHash: hash("another") };
      if (fault === "idle")
        control.binding = { ...control.binding, conditionsHash: hash("changed-brightness") };
      if (fault === "fake") Object.assign(data, { physical: false });
      if (fault === "unknown-field") Object.assign(data, { batteryPercent: 50 });
      expect(() => ingestPhysicalEnergy(data, energyBinding, control)).toThrow();
    },
  );
});

describe("packaged artifacts", () => {
  it("hashes actual bytes, follows only static imports, and preserves missing native categories", async () => {
    const root = await directory();
    await mkdir(path.join(root, ".vite"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), '<script src="/assets/main.js"></script>');
    await writeFile(path.join(root, "assets/main.js"), 'import "./shared.js";');
    await writeFile(path.join(root, "assets/shared.js"), "export const x=1;");
    await writeFile(path.join(root, "assets/lazy.js"), "export const lazy=1;");
    await writeFile(path.join(root, "assets/style.css"), "body{}");
    await writeFile(
      path.join(root, ".vite/manifest.json"),
      JSON.stringify({
        main: {
          file: "assets/main.js",
          isEntry: true,
          imports: ["shared"],
          dynamicImports: ["lazy"],
        },
        shared: { file: "assets/shared.js" },
        lazy: { file: "assets/lazy.js" },
      }),
    );
    const first = await collectPackagedArtifacts({ renderer: root });
    expect(first.initialFiles).toEqual(["assets/main.js", "assets/shared.js"]);
    expect(first.categories.css.value).toBe(6);
    expect(first.categories.fonts.value).toBe(0);
    expect(first.categories.installer.value).toBeNull();
    expect(first.categories.host.value).toBeNull();
    const before = first.sha256;
    await writeFile(path.join(root, "assets/lazy.js"), "changed-lazy-asset");
    expect((await collectPackagedArtifacts({ renderer: root })).sha256).not.toBe(before);
    expect(first.raw).not.toContain(root);
  });
  it("retains internal links and refuses escaping links", async (context) => {
    const root = await directory();
    await writeFile(path.join(root, "binary"), "synthetic");
    // Symbolic links may need an explicit Windows development privilege; directory junctions are not the same artifact.
    try {
      await symlink("binary", path.join(root, "current"));
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      )
        context.skip("Windows runner lacks symbolic-link privileges; no link coverage claimed");
      throw error;
    }
    expect((await inventoryArtifact(root)).entries).toHaveLength(2);
    const outside = await directory();
    await writeFile(path.join(outside, "file"), "outside");
    await symlink(path.join(outside, "file"), path.join(root, "escape"));
    await expect(inventoryArtifact(root)).rejects.toThrow(/escapes/);
  });
});

function capture(): ClientCapture {
  const trial = createPackagedPlan({ mode: "commit", strata: ["chromium-cache-cold"] })[0]!;
  const boundaries = [
    "client.submitted",
    "admission.started",
    "admission.committed",
    "job.submitted",
    "job.enqueued",
    "job.dequeued",
    "lease.acquired",
    "context.ready",
    "provider.started",
    "provider.transport",
    "provider.text",
    "text.safe",
    "text.published",
    "client.acknowledged",
    "client.received",
    "client.text.painted",
    "tool.started",
    "tool.finished",
    "provider.finished",
    "terminal.committed",
    "client.terminal.painted",
  ] as const;
  const batch: TraceBatch = {
    version: 1,
    processId: "process-a",
    counters: { recorded: boundaries.length, dropped: 0, sampledOut: 0, invalid: 0 },
    points: boundaries.map((boundary, sequence) => ({
      traceId: "opaque-run",
      processId: "process-a",
      sequence,
      at: sequence * 10,
      boundary,
      ...(["provider.started", "provider.finished"].includes(boundary)
        ? { operationId: "request-1" }
        : {}),
      ...(["tool.started", "tool.finished"].includes(boundary) ? { operationId: "tool-1" } : {}),
      ...(boundary === "terminal.committed" ? { outcome: "success" as const } : {}),
    })),
  };
  return {
    version: 1,
    client: "desktop",
    target: "desktop-linux-x64",
    artifactHash: hash("app"),
    environmentHash: hash("environment"),
    fixtureHash: hash("fixture"),
    trial,
    reset: { id: trial.resetId, profileIsolated: true, stateRestored: true, cache: trial.stratum },
    runtime: "ordinary-replay",
    productionBuild: true,
    physicalDevice: false,
    outcome: "success",
    startup: {
      "first-window": 10,
      "usable-shell": 30,
      "restored-transcript": 40,
      "working-turn": 200,
    },
    batches: [batch],
    calibrations: [],
  };
}

describe("client strata and immutable attempts", () => {
  it("predeclares 20 paired commit and 100 release observations per stratum and build", () => {
    const commit = createPackagedPlan({ mode: "commit" });
    const release = createPackagedPlan({ mode: "release" });
    expect(commit).toHaveLength(6 * 20 * 3);
    expect(release).toHaveLength(6 * 100 * 3);
    expect(new Set(release.map((t) => t.resetId)).size).toBe(release.length);
    expect(() => createPackagedPlan({ mode: "commit", samples: 5 })).toThrow();
    expect(commit.slice(0, 3).map((t) => t.build)).not.toEqual(
      commit.slice(3, 6).map((t) => t.build),
    );
  });
  it("uses W0-4 trace derivation for TTFT and scrubs raw process identities", () => {
    const data = capture();
    const result = ingestClientCapture(data, data);
    expect(result.trace.metrics.find((m) => m.id === "m01.user-ttft")!.observations[0]!.value).toBe(
      150,
    );
    expect(result.raw).not.toContain("opaque-run");
    expect(JSON.stringify(result.trace.raw)).not.toContain("process-a");
    expect(result.startupMetrics).toHaveLength(4);
  });
  it("keeps web and mobile evidence separate and rejects simulated mobile acceptance", () => {
    const data = capture();
    expect(() => ingestWebCapture(data, data)).toThrow();
    data.client = "mobile";
    data.target = "mobile-ios-device";
    expect(() => ingestMobileCapture(data, data)).toThrow(/physical/);
    data.physicalDevice = true;
    expect(ingestMobileCapture(data, data).startupMetrics).toEqual([]);
    const coverage = packagedCoverage([
      { target: "desktop-linux-x64", artifactHash: hash("app"), physicalEnergy: false },
    ]);
    expect(coverage.find((r) => r.target === "mobile-ios-device")!.packaged).toBe("not-measured");
    expect(coverage.find((r) => r.target === "desktop-linux-x64")!.energy).toBe("not-measured");
  });
  it.each(["reset", "reverse", "NaN", "artifact", "scripted"])(
    "rejects invalid %s startup evidence",
    (fault) => {
      const data = capture();
      const expected = { ...data };
      if (fault === "reset") data.reset.stateRestored = false;
      if (fault === "reverse") data.startup["usable-shell"] = 1;
      if (fault === "NaN") data.startup["working-turn"] = NaN;
      if (fault === "artifact") data.artifactHash = hash("wrong");
      if (fault === "scripted") Object.assign(data, { runtime: "scripted" });
      expect(() => ingestClientCapture(data, expected)).toThrow();
    },
  );
  it("never converts a missing paint or dropped telemetry into a complete trace", () => {
    const data = capture();
    data.batches[0]!.counters.dropped = 1;
    const result = ingestClientCapture(data, data);
    expect(result.complete).toBe(false);
    expect(result.trace.metrics.every((m) => m.coverage.observed === 0)).toBe(true);
  });
  it("rejects a reset cache that contradicts the planned stratum", () => {
    const data = capture();
    expect(data.trial.stratum).toBe("chromium-cache-cold");
    data.reset.cache = "warm-relaunch";
    expect(() => ingestClientCapture(data, data)).toThrow(/planned stratum/);
  });
  it.each(["failed", "cancelled", "timed-out", "uncertain"] as const)(
    "rejects a working turn when the terminal trace is %s",
    (outcome) => {
      const data = capture();
      const terminal = data.batches[0]!.points.find(
        (point) => point.boundary === "terminal.committed",
      );
      expect(terminal?.outcome).toBe("success");
      terminal!.outcome = outcome;
      expect(() => ingestClientCapture(data, data)).toThrow(/terminal trace/);
    },
  );
  it("does not keep contradictory startup evidence as a complete trial", async () => {
    const output = await directory();
    const warm = capture();
    warm.reset.cache = "warm-relaunch";
    const failedTerminal = capture();
    const terminal = failedTerminal.batches[0]!.points.find(
      (point) => point.boundary === "terminal.committed",
    );
    terminal!.outcome = "failed";
    for (const data of [warm, failedTerminal]) {
      const result = await runPackagedPlan({
        output,
        plan: [data.trial],
        signal: new AbortController().signal,
        expected: { parent: data, candidate: data, "fixed-release": data },
        driver: {
          run: async () => data,
          close: async () => {},
        },
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ status: "incomplete" });
    }
  });
  it("retains failures and remaining cancelled slots and closes the driver", async () => {
    const output = await directory();
    const data = capture();
    const controller = new AbortController();
    let closed = false;
    const plan = createPackagedPlan({ mode: "commit", strata: ["chromium-cache-cold"] }).slice(
      0,
      3,
    );
    const result = await runPackagedPlan({
      output,
      plan,
      signal: controller.signal,
      expected: { parent: data, candidate: data, "fixed-release": data },
      driver: {
        run: async () => {
          controller.abort();
          throw new Error("private content must not escape");
        },
        close: async () => {
          closed = true;
        },
      },
    });
    expect(result.results).toHaveLength(3);
    expect(closed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(await readFile(path.join(output, result.artifact.file), "utf8")).toContain(
      "cancelled-before-measurement",
    );
  });
  it("uses content-addressed writes without replacing corrupt or colliding bytes", async () => {
    const dir = await directory();
    const value = { measured: 0 };
    const first = await writeImmutableReport(dir, value);
    expect(await writeImmutableReport(dir, value)).toEqual(first);
    await writeFile(path.join(dir, first.file), "corrupt");
    await expect(writeImmutableReport(dir, value)).rejects.toThrow();
  });
  it("refuses workstation desktop launch before opening apps or provisioning infrastructure", async () => {
    await expect(
      runPackagedCli(["--action=run-desktop", `--output=${await directory()}`]),
    ).rejects.toThrow(/isolated/);
  });
});

function report(data: ClientCapture): PerformanceEvidenceReport {
  const environment: PerformanceEvidenceReport["environment"] = {
    platform: "linux",
    arch: "x64",
    hardwareClass: "synthetic",
    osVersion: "fixture",
    runtimeVersions: [{ id: "node", version: "fixture" }],
    containerDigests: [],
    buildMode: "production",
    powerMode: "fixed",
    thermalState: "nominal",
    backgroundLoad: "isolated",
    memoryAccounting: "rss",
    resourceLimitsHash: hash("limits"),
    sampleIntervalMs: 1000,
  };
  data.environmentHash = contentDigest(environment);
  return {
    schemaVersion: 3,
    id: "report-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    manifestHash: contentDigest(SCOREBOARD_MANIFEST),
    build: {
      commit: "a".repeat(40),
      parentCommit: "b".repeat(40),
      fixedReleaseCommit: "c".repeat(40),
      dirty: true,
      diffDigest: hash("diff"),
      artifactHash: data.artifactHash,
    },
    hashes: {
      benchmark: hash("benchmark"),
      fixture: data.fixtureHash,
      grader: hash("grader"),
      dependencyLock: hash("lock"),
    },
    environment,
    environmentHash: data.environmentHash,
    scenario: {
      id: "desktop-chromium-cache-cold",
      tier: "T2",
      comparisonMode: "controlled-harness",
      timingMode: "fixed-delay",
      cacheState: data.reset.cache,
      loadScheduleHash: hash("schedule"),
      routeHash: hash("route"),
      deadlineMs: 60_000,
    },
    artifacts: [],
    traces: [],
    metrics: METRIC_DEFINITIONS.map((m) => ({
      id: m.id,
      unit: m.unit,
      direction: m.direction,
      applicability: "applicable",
      missingReason: "not-measured",
      coverage: { expected: 0, observed: 0 },
      observations: [],
    })),
    tasks: TASK_DEFINITIONS.map(({ id }) => ({
      id,
      status: "incomplete",
      missingReason: "not-measured",
      fixtureHash: null,
      graderHash: null,
      trials: [],
    })),
    experiments: EXPERIMENT_DEFINITIONS.map(({ id, variants }) => ({
      id,
      variants: variants.map((variant) => ({
        id: variant,
        status: "incomplete",
        missingReason: "not-measured",
        traceIds: [],
      })),
    })),
    crashes: CRASH_BOUNDARIES.map(({ id }) => ({
      id,
      status: "incomplete",
      missingReason: "not-measured",
      recovery: null,
      safetyPassed: null,
      taskCompleted: null,
      traceIds: [],
    })),
    usageCoverage: { expected: 0, observed: 0 },
    usage: [],
  };
}
it("attaches to the full W0-1 contract without erasing tasks, crashes, usage or coverage gaps", () => {
  const data = capture();
  const initial = report(data);
  const envelope = attachPackagedCapture(initial, data);
  const parsed = parsePerformanceEvidenceEnvelope(envelope);
  expect(parsed.report.tasks).toEqual(initial.tasks);
  expect(parsed.report.crashes).toEqual(initial.crashes);
  expect(parsed.report.metrics).toHaveLength(METRIC_DEFINITIONS.length);
  expect(parsed.report.metrics.find((m) => m.id === "m14.task-energy")!.coverage.observed).toBe(0);
  expect(() => attachPackagedCapture(parsed.report, data)).toThrow(/overwrite/);
});
