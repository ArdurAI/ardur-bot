import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extendActiveComputerControl } from "./computer-control.js";
import { ComputerBusyError, provisionComputer, replaceComputer } from "./computer-lifecycle.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "recovery",
  traceId: "recovery",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: "fake" | "desktop" = "fake") {
  const root = await mkdtemp(path.join(tmpdir(), "ardurbot-recovery-"));
  roots.push(root);
  const sandbox: SandboxProvider =
    provider === "desktop" ? new DesktopSandboxProvider({ root }) : new FakeSandboxProvider();
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  const first = await sandbox.provision({ botId: "bot", homePath: root }, context);
  await home.writeFile("bot", "notes.txt", "checkpoint", context);
  await sandbox.writeFile(
    first,
    { path: "notes.txt", content: new TextEncoder().encode("live work") },
    context,
  );
  const row = {
    id: "computer",
    homeKey: "bot",
    scope: "dedicated",
    state: "running",
    provisioningId: null as string | null,
    providerRef: first.providerRef as string | null,
    kind: first.kind,
    controlHolder: "none",
    controlLeaseId: null as string | null,
    controlLeaseExpiresAt: null as Date | null,
    controlBotId: null as string | null,
    controlRunId: null as string | null,
    maintenanceId: null as string | null,
    homeRevision: "saved",
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };
  // Model the atomic scalar predicates used by claims, including stale references
  // as well as stale-claim timestamps and the separate end-of-boot ownership token.
  const computer = {
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }) => {
      const keys = [
        "id",
        "state",
        "providerRef",
        "kind",
        "updatedAt",
        "provisioningId",
        "controlHolder",
        "controlLeaseId",
        "controlLeaseExpiresAt",
        "controlBotId",
        "controlRunId",
      ] as const;
      const matches = keys.every((key) => {
        if (!(key in where)) return true;
        const expected = where[key];
        const actual = row[key];
        if (expected instanceof Date && actual instanceof Date) {
          return expected.getTime() === actual.getTime();
        }
        return expected === actual;
      });
      if (!matches) return { count: 0 };
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) =>
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data),
    ),
  };
  const runFindFirst = vi.fn<() => Promise<{ id: string } | null>>(async () => null);
  const deps = {
    prisma: {
      computer,
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: runFindFirst },
    } as unknown as PrismaClient,
    sandbox,
    home,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: root,
  };
  return { deps, row, computer, first, root, runFindFirst };
}

describe("computer recovery preserves live work", () => {
  it.each([false, true])(
    "finishes reconnect after a teaching lease renewal (provider fails: %s)",
    async (fails) => {
      const { deps, row, first } = await fixture();
      Object.assign(row, {
        controlHolder: "user",
        controlLeaseId: "teaching-lease",
        controlBotId: "bot",
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      });
      deps.jobs = { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as JobPublisher;
      const failure = new Error("provider preparation failed");
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      vi.spyOn(deps.sandbox, "prepare").mockImplementation(async () => {
        expect(row.state).toBe("booting");
        const claimedAt = row.updatedAt;
        expect(
          await extendActiveComputerControl(
            deps.prisma,
            deps.jobs,
            row,
            "bot",
            new Date(Date.now() + 30 * 60_000),
          ),
        ).toBe(true);
        expect(row.updatedAt.getTime()).toBeGreaterThan(claimedAt.getTime());
        if (fails) throw failure;
      });

      const reconnect = provisionComputer(deps, row.id, context);
      if (fails) await expect(reconnect).rejects.toBe(failure);
      else await expect(reconnect).resolves.toMatchObject({ providerRef: first.providerRef });
      expect(row.state).toBe("running");
      expect(row.provisioningId).toBeNull();
      expect(row.controlHolder).toBe("user");
      expect(row.controlLeaseId).toBe("teaching-lease");
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("cannot activate or clear a newer provisioning owner's claim", async () => {
    const { deps, row } = await fixture();
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    vi.spyOn(deps.sandbox, "prepare").mockImplementation(async () => {
      expect(row.provisioningId).toEqual(expect.any(String));
      row.provisioningId = "new-owner";
    });
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(row.state).toBe("booting");
    expect(row.provisioningId).toBe("new-owner");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("preserves a teaching control release during a fresh boot", async () => {
    const { deps, row } = await fixture();
    Object.assign(row, {
      state: "stopped",
      controlHolder: "user",
      controlLeaseId: "teaching-lease",
      controlBotId: "bot",
      controlLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.spyOn(deps.sandbox, "prepare").mockImplementation(async () => {
      await deps.prisma.computer.updateMany({
        where: { id: row.id },
        data: {
          controlHolder: "bot",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        },
      });
    });
    await provisionComputer(deps, row.id, context);
    expect(row).toMatchObject({
      state: "running",
      provisioningId: null,
      controlHolder: "bot",
      controlLeaseId: null,
      controlBotId: null,
    });
  });

  it("does not disturb a concurrent replacement claim while clearing fresh-boot control", async () => {
    const { deps, row, computer, runFindFirst } = await fixture();
    row.state = "stopped";
    row.providerRef = null;
    const updateMany = computer.updateMany.getMockImplementation();
    if (!updateMany) throw new Error("missing updateMany implementation");
    let claimCommittedResolve: (() => void) | undefined;
    const claimCommitted = new Promise<void>((resolve) => {
      claimCommittedResolve = resolve;
    });
    let clearFinishedResolve: (() => void) | undefined;
    const clearFinished = new Promise<void>((resolve) => {
      clearFinishedResolve = resolve;
    });
    let replacement: ReturnType<typeof replaceComputer> | undefined;
    runFindFirst.mockImplementation(async () => {
      await clearFinished;
      return { id: "active-run" };
    });
    computer.updateMany.mockImplementation(async (args) => {
      const where = args.where as Record<string, unknown>;
      const data = args.data as Record<string, unknown>;
      const isActivation =
        where.state === "booting" && data.state === "running" && data.provisioningId === null;
      const isReplacementClaim = data.state === "suspending";
      const isControlClear = "controlHolder" in where && data.controlLeaseId === null;
      if (isControlClear) await claimCommitted;
      const result = await updateMany(args);
      if (isActivation && result.count === 1) {
        replacement = replaceComputer(deps, row.id, "recover", context);
      }
      if (isReplacementClaim && result.count === 1) claimCommittedResolve?.();
      if (isControlClear) clearFinishedResolve?.();
      return result;
    });

    await expect(provisionComputer(deps, row.id, context)).resolves.toBeTruthy();
    await expect(replacement).rejects.toBeInstanceOf(ComputerBusyError);
    expect(row.state).toBe("running");
  });

  it("retries a failed fresh-boot control clear when reconnecting", async () => {
    const { deps, row, computer } = await fixture();
    Object.assign(row, {
      state: "stopped",
      providerRef: null,
      controlHolder: "user",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: "bot",
      controlRunId: "stale-run",
    });
    const updateMany = computer.updateMany.getMockImplementation();
    if (!updateMany) throw new Error("missing updateMany implementation");
    const clearFailure = new Error("control clear failed");
    let clearFailed = false;
    computer.updateMany.mockImplementation(async (args) => {
      if (
        !clearFailed &&
        "controlHolder" in args.where &&
        (args.data as { controlLeaseId?: unknown }).controlLeaseId === null
      ) {
        clearFailed = true;
        throw clearFailure;
      }
      return updateMany(args);
    });

    await expect(provisionComputer(deps, row.id, context, "bot")).rejects.toBe(clearFailure);
    expect(row).toMatchObject({
      state: "running",
      controlHolder: "user",
      controlLeaseId: null,
    });

    await expect(provisionComputer(deps, row.id, context, "bot")).resolves.toBeTruthy();
    expect(row).toMatchObject({
      state: "running",
      controlHolder: "bot",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    });
  });

  it("blocks competing maintenance and boots while an update owns the computer", async () => {
    const { deps, row } = await fixture();
    row.maintenanceId = "other-update";
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    for (const mode of ["update", "recover", "reset"] as const) {
      await expect(replaceComputer(deps, row.id, mode, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("claims a running computer before concurrent workers can create competing replacements", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    // Both workers read the original row before either claims it; later reads
    // (claim stamp, activation) must see the live row so updatedAt fencing works.
    const original = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) return { ...original };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const results = await Promise.allSettled([
      provisionComputer(deps, row.id, context),
      provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
    expect(provision).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(row.providerRef).toBe(successful[0]?.value.providerRef);
    expect(row.state).toBe("running");
  });

  it("rejects a delayed reconnect whose original reference was already replaced", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    const stale = { ...row };
    const winner = await provisionComputer(deps, row.id, context);
    await deps.sandbox.writeFile(
      winner,
      { path: "notes.txt", content: new TextEncoder().encode("winner work") },
      context,
    );
    computer.findUniqueOrThrow.mockResolvedValue(stale);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(winner.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(winner, "notes.txt", context)),
    ).toBe("winner work");
  });

  it("claims an abandoned booting computer only once when callers have no screenLeaseId", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "booting";
    row.providerRef = null;
    const observed = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      // First two reads are the concurrent observations before either claims.
      if (reads <= 2) return { ...observed };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      const results = await Promise.allSettled([
        provisionComputer(deps, row.id, context),
        provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
      expect(provision).toHaveBeenCalledOnce();
      expect(row.state).toBe("running");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves the reference and workspace through an uncertain reconnect and a retry", async () => {
    const { deps, row, first } = await fixture();
    const error = new Error("fetch failed");
    vi.spyOn(deps.sandbox, "provision").mockRejectedValueOnce(error);
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBe(error);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
    expect(restore).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("live work");
  });

  it.each(["running", "error", "stopped", "suspended"])(
    "reconnects desktop files after an adapter restart from %s without importing an old checkpoint",
    async (state) => {
      const { deps, row, root, first } = await fixture("desktop");
      row.state = state;
      deps.sandbox = new DesktopSandboxProvider({ root });
      const restore = vi.spyOn(deps.sandbox, "importWorkspace");
      const reconnected = await provisionComputer(deps, row.id, context);
      expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
      expect(restore).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
      ).toBe("live work");
    },
  );

  it("restores the checkpoint when a desktop workspace is actually absent after restart", async () => {
    const { deps, row, root, first } = await fixture("desktop");
    expect(first.fresh).toBe(true);
    await rm(first.providerRef, { recursive: true });
    deps.sandbox = new DesktopSandboxProvider({ root });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: true });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it.each([
    "Path notes.txt not found",
    "404: file not found",
    "command not found",
    "checkpoint directory does not exist",
    "export process killed",
    "ECONNRESET",
    "Sandbox not found",
  ])("aborts update and its retry when checkpoint fails with %s", async (message) => {
    const { deps, row, first } = await fixture();
    const error = new Error(message);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw error;
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(error);
      expect(row).toMatchObject({
        state: "error",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it.each(["running", "error"])(
    "updates a %s computer only after saving its current workspace",
    async (state) => {
      const { deps, row } = await fixture();
      row.state = state;
      const updated = await replaceComputer(deps, row.id, "update", context);
      expect(updated.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it("resets a computer stuck suspending after a hung stop", async () => {
    const { deps, row } = await fixture();
    row.state = "suspending";
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("refuses Reset while a suspend claim is still live", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "suspending";
    row.updatedAt = new Date();
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(computer.updateMany).not.toHaveBeenCalled();
    expect(row.state).toBe("suspending");
  });

  it("resets a missing computer after idempotent provider teardown", async () => {
    const { deps, row, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the reference when reset teardown fails ambiguously", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("404: configuration file not found");
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBe(failure);
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(first.providerRef);
  });
});
