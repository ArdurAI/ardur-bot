import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { enqueueComputerRunRetry } from "./computer-run-retry.js";

function fixture(state = "suspending", status = "queued") {
  const row = {
    status,
    cancelRequestedAt: null as Date | null,
    runtimeComputer: null,
    bot: { computer: { state, maintenanceId: null as string | null } },
  };
  let pending: Parameters<JobPublisher["enqueue"]>[0] | undefined;
  const enqueue = vi.fn(async (job: Parameters<JobPublisher["enqueue"]>[0]) => {
    pending = job;
  });
  const deps = {
    prisma: { run: { findUnique: vi.fn(async () => row) } } as unknown as PrismaClient,
    jobs: { enqueue } as unknown as JobPublisher,
  };
  return { row, deps, enqueue, pending: () => pending };
}

it("corrects a late delayed publication that overwrites an immediate idle wake", async () => {
  const harness = fixture();
  let publish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    publish = resolve;
  });
  const original = harness.enqueue.getMockImplementation()!;
  harness.enqueue.mockImplementationOnce(async (job) => {
    await barrier;
    await original(job);
  });
  const retry = enqueueComputerRunRetry(harness.deps, "incoming", 8000);
  await vi.waitFor(() => expect(harness.enqueue).toHaveBeenCalled());
  harness.row.bot.computer.state = "running";
  await harness.deps.jobs.enqueue(runContinueJob("incoming"));
  publish();
  await retry;
  expect(harness.pending()).toEqual(runContinueJob("incoming"));
  expect(harness.enqueue).toHaveBeenCalledTimes(3);
});

it.each(["running", "suspended"])(
  "starts promptly when a worker requeues after the computer becomes %s",
  async (state) => {
    const harness = fixture(state, "running");
    // The idle worker's queued-run query could not see this still-running worker.
    harness.row.status = "queued";
    await enqueueComputerRunRetry(harness.deps, "incoming", 8000);
    expect(harness.pending()).toEqual(runContinueJob("incoming"));
  },
);

it("leaves a save excluded until the idle worker releases it and publishes the wake", async () => {
  const harness = fixture();
  await enqueueComputerRunRetry(harness.deps, "incoming", 8000);
  expect(harness.pending()?.availableAt).toBeInstanceOf(Date);
  expect(harness.enqueue).toHaveBeenCalledOnce();
  harness.row.bot.computer.state = "running";
  await harness.deps.jobs.enqueue(runContinueJob("incoming"));
  expect(harness.pending()).toEqual(runContinueJob("incoming"));
});

it.each(["cancelled", "running", "maintenance"])(
  "does not wake a %s run prematurely",
  async (outcome) => {
    const harness = fixture("running", outcome === "maintenance" ? "queued" : outcome);
    if (outcome === "maintenance") harness.row.bot.computer.maintenanceId = "update";
    await enqueueComputerRunRetry(harness.deps, "incoming", 8000);
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.pending()?.availableAt).toBeInstanceOf(Date);
  },
);
