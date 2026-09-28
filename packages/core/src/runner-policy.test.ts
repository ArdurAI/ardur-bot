import {
  defaultRunnerLimits,
  RUNNER_LIMITS,
  unknownRunnerCapabilities,
  type Runner,
  type RunnerEnvironment,
  type RunnerJobState,
} from "@ardurbot/contracts";
import {
  admitRunnerJob,
  canTransition,
  clampRunnerLimits,
  confirmRunnerCleanup,
  parseRunnerJobRequest,
  reconcileRunnerJobOnRestart,
  runnerJobDeadline,
  runnerJobRequestHash,
  RUNNER_STATE_PHASE,
  runnerJobHoldsSlot,
  stopRunnerJob,
  type RunnerAdmissionView,
} from "./runner-policy.js";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-09-28T12:00:00.000Z");

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: "runner-1",
    spaceId: "space-1",
    ownerUserId: "user-1",
    name: "Test runner",
    kind: "docker",
    connection: { connectionId: "conn-1", executionHostId: "server", revision: 3 },
    admissionState: "enabled",
    capabilities: { ...unknownRunnerCapabilities(), environments: ["env-1"] },
    capabilitiesObservedAt: NOW.toISOString(),
    capabilityRevision: 1,
    reachability: "reachable",
    lastProbeAt: NOW.toISOString(),
    probeExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    lastProbeCode: null,
    policyRevision: 1,
    sharingEnabled: true,
    defaultAccess: "deny",
    protected: true,
    limits: defaultRunnerLimits(),
    notes: "",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    retiredAt: null,
    ...overrides,
  };
}

function environment(overrides: Partial<RunnerEnvironment> = {}): RunnerEnvironment {
  return {
    id: "env-1",
    runnerId: "runner-1",
    name: "Test environment",
    kind: "image",
    profileId: null,
    requestedImage: "ardurbot-test:1",
    resolvedImageId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    resolvedDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    os: "linux",
    architecture: "arm64",
    tools: [],
    dependencyManifestHash: null,
    lockfileHash: null,
    setupArgv: null,
    networkMode: "none",
    revision: 1,
    verifiedAt: NOW.toISOString(),
    ...overrides,
  };
}

function view(overrides: Partial<RunnerAdmissionView> = {}): RunnerAdmissionView {
  return {
    spaceId: "space-1",
    runner: runner(),
    botAccess: "allow",
    environment: environment(),
    engine: { kind: "docker", connectionRevision: 3 },
    boundImageDigest: null,
    existingJob: null,
    activeBotSlotJobs: 0,
    jobsStartedToday: 0,
    runnerMillisUsedToday: 0,
    goalOrigin: false,
    now: NOW,
    ...overrides,
  };
}

const baseRequest = {
  runnerId: "runner-1",
  environmentId: "env-1",
  command: { argv: ["pnpm", "test"] },
};

describe("runner job request contracts", () => {
  it("admits a minimal request and applies the R1 defaults", () => {
    const request = parseRunnerJobRequest(baseRequest);
    expect(request.timeoutSeconds).toBe(RUNNER_LIMITS.defaultDurationSeconds);
    expect(request.filesIn).toEqual([]);
    expect(request.filesOut).toEqual([]);
    expect(request.secretGrants).toEqual([]);
    const decision = admitRunnerJob(request, view());
    expect(decision.ok).toBe(true);
    if (decision.ok && !decision.replay) {
      expect(decision.durationSeconds).toBe(300);
      // Defaults come from the runner's limits.
      expect(decision.resources.cpuMillis).toBe(RUNNER_LIMITS.cpuMillis);
      expect(decision.resources.memoryBytes).toBe(RUNNER_LIMITS.memoryBytes);
      expect(decision.resources.diskBytes).toBe(RUNNER_LIMITS.tmpfsBytes);
    }
  });

  it("rejects absolute, escaping, home and control-character paths", () => {
    for (const bad of [
      "/etc/passwd",
      "../escape",
      "a/../../b",
      "~/x",
      "a//b",
      "a/",
      "a/./b",
      "dir/../file",
      "a\nb",
      "a\x00b",
      "a\\b",
      "",
      `${"deep/".repeat(40)}file`,
    ]) {
      expect(() =>
        parseRunnerJobRequest({
          ...baseRequest,
          filesOut: [{ path: bad, required: true }],
        }),
      ).toThrow();
      expect(() =>
        parseRunnerJobRequest({
          ...baseRequest,
          filesIn: [{ source: "artifact", artifactId: "a1", path: bad, bytes: 10 }],
        }),
      ).toThrow();
      expect(() =>
        parseRunnerJobRequest({
          ...baseRequest,
          command: { argv: ["sh"], cwd: bad },
        }),
      ).toThrow();
    }
  });

  it("never accepts identity, endpoints, host paths, mounts or approval ids in a request", () => {
    for (const [key, value] of Object.entries({
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      endpoint: "tcp://engine:2376",
      hostPath: "/var/run/docker.sock",
      mounts: [{ from: "/host", to: "/container" }],
      approvalId: "appr-1",
      connectionId: "conn-1",
      image: "ubuntu:latest",
    })) {
      expect(() =>
        parseRunnerJobRequest({ ...baseRequest, [key]: value }),
      ).toThrow();
    }
  });

  it("bounds duration to the R1 cap and rejects a timeout beyond it", () => {
    expect(() =>
      parseRunnerJobRequest({ ...baseRequest, timeoutSeconds: RUNNER_LIMITS.maxDurationSeconds }),
    ).not.toThrow();
    expect(() =>
      parseRunnerJobRequest({ ...baseRequest, timeoutSeconds: RUNNER_LIMITS.maxDurationSeconds + 1 }),
    ).toThrow();
  });

  it("caps input and output counts at the R1 file limits", () => {
    expect(() =>
      parseRunnerJobRequest({
        ...baseRequest,
        filesIn: Array.from({ length: RUNNER_LIMITS.maxInputFiles + 1 }, (_, i) => ({
          source: "artifact" as const,
          artifactId: `a-${i}`,
          path: `f-${i}`,
          bytes: 1,
        })),
      }),
    ).toThrow();
    expect(() =>
      parseRunnerJobRequest({
        ...baseRequest,
        filesOut: Array.from({ length: RUNNER_LIMITS.maxArtifactFiles + 1 }, (_, i) => ({
          path: `o-${i}`,
          required: true,
        })),
      }),
    ).toThrow();
  });

  it("hashes requests canonically: defaults equal explicit defaults, any change differs", () => {
    const a = parseRunnerJobRequest(baseRequest);
    const b = parseRunnerJobRequest({ ...baseRequest, timeoutSeconds: RUNNER_LIMITS.defaultDurationSeconds });
    expect(runnerJobRequestHash(a)).toBe(runnerJobRequestHash(b));
    expect(runnerJobRequestHash(a)).not.toBe(
      runnerJobRequestHash(parseRunnerJobRequest({ ...baseRequest, command: { argv: ["pnpm", "test", "--all"] } })),
    );
    expect(runnerJobRequestHash(a)).not.toBe(
      runnerJobRequestHash(parseRunnerJobRequest({ ...baseRequest, runnerId: "runner-2" })),
    );
    expect(runnerJobRequestHash(a)).not.toBe(
      runnerJobRequestHash(
        parseRunnerJobRequest({
          ...baseRequest,
          filesIn: [{ source: "artifact", artifactId: "a1", path: "in.txt", bytes: 5 }],
        }),
      ),
    );
  });
});

describe("runner admission refusals", () => {
  const request = parseRunnerJobRequest(baseRequest);

  it("refuses a runner outside the requesting space", () => {
    const decision = admitRunnerJob(request, view({ runner: runner({ spaceId: "space-2" }) }));
    expect(decision).toMatchObject({ ok: false, code: "wrong-space" });
  });

  it("refuses disabled, paused, draining and retired runners", () => {
    expect(admitRunnerJob(request, view({ runner: runner({ admissionState: "disabled" }) })))
      .toMatchObject({ ok: false, code: "runner-disabled" });
    expect(admitRunnerJob(request, view({ runner: runner({ admissionState: "paused" }) })))
      .toMatchObject({ ok: false, code: "runner-disabled" });
    expect(admitRunnerJob(request, view({ runner: runner({ admissionState: "draining" }) })))
      .toMatchObject({ ok: false, code: "runner-draining" });
    expect(
      admitRunnerJob(request, view({ runner: runner({ retiredAt: NOW.toISOString() }) })),
    ).toMatchObject({ ok: false, code: "runner-retired" });
  });

  it("refuses when sharing is off, or the bot has no rule, or an explicit deny", () => {
    expect(admitRunnerJob(request, view({ runner: runner({ sharingEnabled: false }) })))
      .toMatchObject({ ok: false, code: "sharing-disabled" });
    expect(admitRunnerJob(request, view({ botAccess: "none" })))
      .toMatchObject({ ok: false, code: "not-shared" });
    expect(admitRunnerJob(request, view({ botAccess: "deny" })))
      .toMatchObject({ ok: false, code: "not-shared" });
  });

  it("refuses unsupported kinds and engine mismatches", () => {
    expect(admitRunnerJob(request, view({ runner: runner({ kind: "ssh" }) })))
      .toMatchObject({ ok: false, code: "unsupported-kind" });
    expect(admitRunnerJob(request, view({ engine: { kind: "podman", connectionRevision: 3 } })))
      .toMatchObject({ ok: false, code: "engine-mismatch" });
    expect(admitRunnerJob(request, view({ engine: { kind: "docker", connectionRevision: 4 } })))
      .toMatchObject({ ok: false, code: "engine-mismatch" });
  });

  it("refuses unknown, unprobed and unsupported environments", () => {
    expect(admitRunnerJob(request, view({ environment: environment({ runnerId: "runner-2" }) })))
      .toMatchObject({ ok: false, code: "environment-not-found" });
    expect(
      admitRunnerJob(
        request,
        view({ runner: runner({ capabilities: { ...unknownRunnerCapabilities(), environments: ["env-other"] } }) }),
      ),
    ).toMatchObject({ ok: false, code: "environment-unsupported" });
    expect(admitRunnerJob(request, view({ environment: environment({ verifiedAt: null }) })))
      .toMatchObject({ ok: false, code: "environment-unverified" });
    expect(
      admitRunnerJob(
        request,
        view({
          environment: environment({ resolvedImageId: null, resolvedDigest: null }),
        }),
      ),
    ).toMatchObject({ ok: false, code: "image-not-resolved" });
  });

  it("refuses an image identity mismatch between the bound digest and the environment", () => {
    const decision = admitRunnerJob(
      request,
      view({ boundImageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }),
    );
    expect(decision).toMatchObject({ ok: false, code: "image-identity-mismatch" });
  });

  it("refuses stale probes and unreachable runners", () => {
    expect(
      admitRunnerJob(
        request,
        view({ runner: runner({ probeExpiresAt: new Date(NOW.getTime() - 1).toISOString() }) }),
      ),
    ).toMatchObject({ ok: false, code: "probe-stale" });
    expect(admitRunnerJob(request, view({ runner: runner({ reachability: "unknown" }) })))
      .toMatchObject({ ok: false, code: "probe-stale" });
    expect(admitRunnerJob(request, view({ runner: runner({ reachability: "unreachable" }) })))
      .toMatchObject({ ok: false, code: "runner-unreachable" });
  });

  it("refuses oversize inputs in aggregate and per file", () => {
    const bigFile = RUNNER_LIMITS.maxInputFileBytes + 1;
    expect(
      admitRunnerJob(
        parseRunnerJobRequest({
          ...baseRequest,
          filesIn: [{ source: "artifact", artifactId: "a1", path: "f.bin", bytes: bigFile }],
        }),
        view(),
      ),
    ).toMatchObject({ ok: false, code: "input-file-too-large" });
    // Many legal files whose total exceeds the runner's aggregate cap.
    const many = Array.from({ length: 100 }, (_, i) => ({
      source: "artifact" as const,
      artifactId: `a-${i}`,
      path: `f-${i}`,
      bytes: 1024 * 1024,
    }));
    const decision = admitRunnerJob(
      parseRunnerJobRequest({ ...baseRequest, filesIn: many }),
      view({ runner: runner({ limits: { ...defaultRunnerLimits(), maxInputBytes: 10 * 1024 * 1024 } }) }),
    );
    expect(decision).toMatchObject({ ok: false, code: "input-too-large" });
  });

  it("refuses a duration over the runner's cap even under the R1 cap", () => {
    const decision = admitRunnerJob(
      parseRunnerJobRequest({ ...baseRequest, timeoutSeconds: 600 }),
      view({ runner: runner({ limits: { ...defaultRunnerLimits(), maxDurationSeconds: 300 } }) }),
    );
    expect(decision).toMatchObject({ ok: false, code: "time-cap-exceeded" });
  });

  it("refuses resources the runner cannot enforce", () => {
    const cpu = admitRunnerJob(
      parseRunnerJobRequest({
        ...baseRequest,
        resources: { cpuMillis: RUNNER_LIMITS.cpuMillis },
      }),
      view({ runner: runner({ limits: { ...defaultRunnerLimits(), cpuMillis: 1000 } }) }),
    );
    expect(cpu).toMatchObject({ ok: false, code: "resources-exceed-limits" });
    const memory = admitRunnerJob(
      parseRunnerJobRequest({
        ...baseRequest,
        resources: { memoryBytes: RUNNER_LIMITS.memoryBytes },
      }),
      view({ runner: runner({ limits: { ...defaultRunnerLimits(), memoryBytes: 1024 * 1024 * 1024 } }) }),
    );
    expect(memory).toMatchObject({ ok: false, code: "resources-exceed-limits" });
  });

  it("refuses secret grants and goal-origin jobs", () => {
    expect(
      admitRunnerJob(
        parseRunnerJobRequest({ ...baseRequest, secretGrants: ["deploy-key"] }),
        view(),
      ),
    ).toMatchObject({ ok: false, code: "secrets-unsupported" });
    expect(admitRunnerJob(request, view({ goalOrigin: true })))
      .toMatchObject({ ok: false, code: "goal-jobs-unsupported" });
  });

  it("replays an identical operation key and refuses a conflicting reuse", () => {
    const hash = runnerJobRequestHash(request);
    const replay = admitRunnerJob(
      request,
      view({ existingJob: { id: "job-1", requestHash: hash, state: "finished" } }),
    );
    expect(replay).toMatchObject({ ok: true, replay: true, existingJobId: "job-1" });
    const conflict = admitRunnerJob(
      request,
      view({ existingJob: { id: "job-1", requestHash: "0".repeat(64), state: "finished" } }),
    );
    expect(conflict).toMatchObject({ ok: false, code: "operation-key-conflict" });
  });

  it("refuses when the bot slot is occupied and at daily caps", () => {
    expect(admitRunnerJob(request, view({ activeBotSlotJobs: 1 })))
      .toMatchObject({ ok: false, code: "slot-occupied" });
    expect(admitRunnerJob(request, view({ jobsStartedToday: RUNNER_LIMITS.maxJobsPerDay })))
      .toMatchObject({ ok: false, code: "daily-job-limit" });
    expect(
      admitRunnerJob(request, view({ runnerMillisUsedToday: RUNNER_LIMITS.maxRunnerSecondsPerDay * 1000 })),
    ).toMatchObject({ ok: false, code: "daily-time-limit" });
  });
});

describe("runner job state machine", () => {
  it("allows exactly the design's edges", () => {
    const cases: Array<[RunnerJobState, RunnerJobState, boolean]> = [
      ["queued", "staging", true],
      ["queued", "failed", true],
      ["queued", "cancelled", true],
      ["queued", "running", false],
      ["queued", "collecting", false],
      ["staging", "running", true],
      ["staging", "cleaning", true],
      ["staging", "cancelled", true],
      ["staging", "collecting", false],
      ["running", "collecting", true],
      ["running", "cleaning", true],
      ["running", "cancelled", true],
      ["running", "staging", false],
      ["running", "finished", false],
      ["collecting", "cleaning", true],
      ["collecting", "cancelled", true],
      ["collecting", "running", false],
      ["cleaning", "finished", true],
      ["cleaning", "failed", true],
      ["cleaning", "cancelled", true],
      ["finished", "running", false],
      ["failed", "running", false],
      ["cancelled", "queued", false],
      ["finished", "finished", false],
    ];
    for (const [from, to, ok] of cases) {
      const check = canTransition(from, to);
      expect(check.ok, `${from} -> ${to}`).toBe(ok);
      if (!ok) expect(check.ok === false && check.reason).toBeTruthy();
    }
  });

  it("holds the slot in active states and releases it on terminal states", () => {
    for (const state of ["queued", "staging", "running", "collecting", "cleaning"] as const)
      expect(runnerJobHoldsSlot(state)).toBe(true);
    for (const state of ["finished", "failed", "cancelled"] as const)
      expect(runnerJobHoldsSlot(state)).toBe(false);
  });

  it("gives every state a phase", () => {
    for (const state of Object.keys(RUNNER_STATE_PHASE) as RunnerJobState[])
      expect(typeof RUNNER_STATE_PHASE[state]).toBe("string");
  });

  it("stops at every stage", () => {
    for (const state of ["staging", "running", "collecting", "cleaning"] as const) {
      const outcome = stopRunnerJob({ state, terminationConfirmed: false, dispatched: true });
      expect(outcome.cancelRequested).toBe(true);
      expect(outcome.cancelConfirmed).toBe(false);
      expect(outcome.phase).toBe("cancelling");
      expect(outcome.state).toBe(state);
    }
    // Queued work holds no live process: Stop resolves it at once.
    const queued = stopRunnerJob({ state: "queued", terminationConfirmed: false, dispatched: true });
    expect(queued).toMatchObject({
      cancelRequested: true,
      state: "cancelled",
      cancelConfirmed: true,
    });
  });

  it("confirms a stop only after termination is confirmed", () => {
    const outcome = stopRunnerJob({ state: "running", terminationConfirmed: true, dispatched: true });
    expect(outcome).toMatchObject({ state: "cancelled", cancelConfirmed: true, cleanupState: "pending" });
  });

  it("cancels a never-dispatched job immediately with trivial cleanup", () => {
    const outcome = stopRunnerJob({ state: "queued", terminationConfirmed: false, dispatched: false });
    expect(outcome).toMatchObject({ state: "cancelled", cancelConfirmed: true, cleanupState: "clean" });
  });

  it("ignores a stop on a terminal job", () => {
    for (const state of ["finished", "failed", "cancelled"] as const) {
      const outcome = stopRunnerJob({ state, terminationConfirmed: true, dispatched: true });
      expect(outcome.cancelRequested).toBe(false);
      expect(outcome.state).toBe(state);
    }
  });

  it("makes cleanup confirmation idempotent and keeps failures visible", () => {
    expect(confirmRunnerCleanup("pending", "clean")).toEqual({ cleanupState: "clean", changed: true });
    expect(confirmRunnerCleanup("clean", "clean")).toEqual({ cleanupState: "clean", changed: false });
    expect(confirmRunnerCleanup("pending", "failed")).toEqual({ cleanupState: "failed", changed: true });
    expect(confirmRunnerCleanup("failed", "failed")).toEqual({ cleanupState: "failed", changed: false });
    expect(confirmRunnerCleanup("failed", "clean")).toEqual({ cleanupState: "clean", changed: true });
  });

  it("derives the absolute deadline from staging + command + collection windows", () => {
    const deadline = runnerJobDeadline({ dispatchedAt: NOW, durationSeconds: 300 });
    expect(deadline.toISOString()).toBe(
      new Date(NOW.getTime() + (RUNNER_LIMITS.stagingSeconds + 300 + RUNNER_LIMITS.artifactCollectionSeconds) * 1000)
        .toISOString(),
    );
  });

  it("reconciles orphaned running jobs to cleanup and reattaches to live leases", () => {
    expect(
      reconcileRunnerJobOnRestart({
        state: "running",
        phase: "executing",
        leaseExpiresAt: new Date(NOW.getTime() - 1000),
        now: NOW,
      }),
    ).toEqual({ action: "cleanup", state: "cleaning", phase: "reconciling" });
    expect(
      reconcileRunnerJobOnRestart({
        state: "running",
        phase: "executing",
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      }),
    ).toEqual({ action: "reattach", state: "running", phase: "executing" });
    // A running row with no lease at all is an orphan: cleanup, never a second launch.
    expect(
      reconcileRunnerJobOnRestart({ state: "running", phase: "executing", leaseExpiresAt: null, now: NOW }),
    ).toEqual({ action: "cleanup", state: "cleaning", phase: "reconciling" });
    expect(
      reconcileRunnerJobOnRestart({ state: "finished", phase: "finished", leaseExpiresAt: null, now: NOW }),
    ).toEqual({ action: "none", state: "finished", phase: "finished" });
    expect(
      reconcileRunnerJobOnRestart({ state: "queued", phase: "waiting-capacity", leaseExpiresAt: null, now: NOW }),
    ).toEqual({ action: "none", state: "queued", phase: "waiting-capacity" });
  });

  it("keeps R1 to docker runners and clamps durations to the R1 cap", () => {
    expect(clampRunnerLimits(defaultRunnerLimits()).maxDurationSeconds).toBe(300);
    expect(
      clampRunnerLimits({ ...defaultRunnerLimits(), maxDurationSeconds: 4000 }).maxDurationSeconds,
    ).toBe(RUNNER_LIMITS.maxDurationSeconds);
  });
});
