import { ALL_DEVICE_SCOPES, DELEGATION_LIMITS, TaskCardSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptDelegation,
  admitDelegation,
  DelegationAdmissionError,
  finishDelegation,
  requestCancel,
} from "./delegation.js";
import { rejectDelegation } from "./delegation-rework.js";
import { fixture, input, snapshot } from "./delegation-test-fixture.js";
import { deviceDigest } from "./device-grants.js";
import { startDelegation, updateWorkerTask } from "./task-cards.js";

describe("transactional delegation admission", () => {
  it("shares caps across two worker clients, persists counters, and deduplicates retries", async () => {
    const f = fixture(),
      a = f.worker(),
      b = f.worker();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => f.admit({ admissionKey: `key-${i}` }, i % 2 ? a : b)),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(f.state().root).toMatchObject({
      activeDescendants: 4,
      totalDescendants: 4,
      reservedTokens: 40000,
    });
    expect(f.state().runs).toHaveLength(5);
    expect(f.tx.$queryRaw).toHaveBeenCalled();
    const row = await a.$transaction((tx) =>
      admitDelegation(tx, { ...input, admissionKey: "key-0" }),
    );
    expect(row.id).toBe("delegation-0");
    expect(f.state().root.totalDescendants).toBe(4);
  });
  it.each([
    ["depth-exceeded", { maxDepth: 0 }],
    ["hops-exceeded", { maxHops: 0 }],
    ["descendants-exceeded", { maxDescendants: 0 }],
    ["budget-exhausted", { tokenLimit: 0 }],
    ["deadline-passed", { deadlineAt: new Date(0) }],
  ])("refuses %s without a run or budget reservation", async (code, patch) => {
    const f = fixture();
    await f.admit();
    Object.assign(f.state().root, patch);
    const before = structuredClone(f.state());
    await expect(f.admit({ admissionKey: "second" })).rejects.toMatchObject({ problem: { code } });
    expect(f.state()).toEqual(before);
  });
  it("rejects A to B to A as a cycle before depth", async () => {
    const f = fixture();
    const first = await f.admit();
    f.state().runs[0].delegationId = first.id;
    f.state().runs[0].botId = "worker";
    await expect(
      f.admit({ admissionKey: "cycle", actingBotId: "coordinator" }),
    ).rejects.toMatchObject({ problem: { code: "cycle" } });
  });
  it("intersects connector grants and scopes without widening", async () => {
    const f = fixture();
    f.policies.push({ layer: "bot", subjectId: "coordinator", scopes: ["ordinary", "delegate"] });
    const row = await f.admit();
    expect(row.authority).toEqual({
      scopes: ["ordinary", "delegate"],
      connectors: ["mcp:shared", "mcp:shared:read"],
    });
    f.policies[0].scopes = ["ordinary"];
    await expect(f.admit({ admissionKey: "denied" })).rejects.toMatchObject({
      problem: { code: "authority-exceeded" },
    });
  });
  it.each([
    { host: "api.example.test", local: false },
    { host: null, local: false },
  ])("denies nonlocal and unknown destinations under local policy", async (destination) => {
    const f = fixture();
    f.bot.allowedModelDestinations = { mode: "local" } as never;
    await expect(f.admit({ snapshot: { ...snapshot, destination } })).rejects.toMatchObject({
      problem: { code: "locality-denied" },
    });
    expect(f.state().root).toBeNull();
    expect(f.state().rows).toHaveLength(0);
  });
  it("records pin differences and refuses changed helper binding", async () => {
    const f = fixture();
    const row = await f.admit({
      snapshot: { ...snapshot, pin: { ...snapshot.pin, modelId: "reviewer" } },
    });
    expect(row.differences.join()).toContain("reviewer");
    await expect(
      f.admit({
        admissionKey: "helper",
        kind: "helper",
        snapshot: { ...snapshot, pin: { ...snapshot.pin, credentialId: "other" } },
      }),
    ).rejects.toBeInstanceOf(DelegationAdmissionError);
  });
  it("marks cancellation separately, retains capacity until confirmation and writes one summary", async () => {
    const f = fixture();
    const row = await f.admit();
    const db = f.worker();
    await requestCancel(db, { spaceId: "space", userId: "owner" }, "root");
    expect(f.state().rows[0].status).toBe("cancel-requested");
    expect(f.state().root.activeDescendants).toBe(1);
    await db.$transaction((tx) => finishDelegation(tx, row.id, "cancelled", "Stopped"));
    await db.$transaction((tx) => finishDelegation(tx, row.id, "cancelled", "Stopped"));
    expect(f.state().rows[0].cancelConfirmedAt).toBeInstanceOf(Date);
    expect(f.state().root.activeDescendants).toBe(0);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
  });
  it("defaults to bounded roots", () => {
    expect(DELEGATION_LIMITS).toMatchObject({ depth: 1, concurrent: 4, hops: 6, descendants: 12 });
    expect(ALL_DEVICE_SCOPES).toContain("delegate");
  });
});

it("writes one completion summary and changes it on explicit acceptance", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Reviewed"));
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Duplicate"));
  expect(f.state().rows[0].status).toBe("completed");
  expect(f.tx.message.create).toHaveBeenCalledOnce();
  expect(f.tx.message.create.mock.calls[0]![0].data.blocks[0].text).toContain(
    "awaiting acceptance",
  );
  await db.$transaction((tx) =>
    acceptDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator"),
  );
  expect(f.state().rows[0].status).toBe("accepted");
  expect(f.tx.message.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { blocks: [{ kind: "text", text: "Coordinator → Worker: accepted.\nReviewed" }] },
    }),
  );
});
it("counts coordinator usage before the first handoff and rolls back an exhausted root", async () => {
  const f = fixture();
  f.tx.usageRecord.aggregate.mockResolvedValue({
    _sum: { inputTokens: 119000, outputTokens: 1000 },
  });
  await expect(f.admit()).rejects.toMatchObject({ problem: { code: "budget-exhausted" } });
  expect(f.tx.usageRecord.aggregate).toHaveBeenCalledWith({
    where: { rootTaskId: "root", purpose: { not: "detached-learning" } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  expect(f.state().root).toBeNull();
  expect(f.state().rows).toHaveLength(0);
});
it("does not let an inherited worker change the parent's computer", async () => {
  const f = fixture();
  await expect(
    f.admit({
      kind: "helper",
      snapshot: { ...snapshot, computer: { ...snapshot.computer, id: "other" } },
    }),
  ).rejects.toMatchObject({ problem: { code: "authority-exceeded" } });
  expect(f.state().rows).toHaveLength(0);
});

it("saves admission-owned fields, scoped references and optional human ownership", async () => {
  const f = fixture();
  f.tx.spaceMember.count.mockResolvedValue(2);
  const row = await f.admit({
    card: {
      goal: "Review",
      inputs: [{ type: "file", artifactId: "artifact" }],
      doneWhen: ["Checklist passes"],
      deadlineAt: null,
    },
  });
  expect(row.card).toMatchObject({
    responsibleUserId: "owner",
    requesterBotId: "coordinator",
    workerBotId: "worker",
    approvalBoundaries: row.authority,
    snapshot: row.snapshot,
  });
  expect(f.tx.artifact.findFirstOrThrow).toHaveBeenCalledWith({
    where: { id: "artifact", spaceId: "space", userId: "owner" },
  });
  await expect(
    f.admit({
      admissionKey: "other",
      card: { goal: "Review", inputs: [{ type: "file", artifactId: "foreign" }] },
    }),
  ).rejects.toThrow("not found");
});
it("updates a worker card quietly, redacts it, checks bounds and keeps acceptance separate", async () => {
  const f = fixture();
  const row = await f.admit({ card: { goal: "Review", doneWhen: ["Checklist passes"] } });
  const db = f.worker();
  await db.$transaction((tx) => startDelegation(tx, row.id));
  const update = (tool: string, args: unknown, executionId = tool) =>
    db.$transaction((tx) =>
      updateWorkerTask(tx, {
        runId: row.runId!,
        spaceId: "space",
        userId: "owner",
        botId: "worker",
        executionId,
        tool,
        args,
      }),
    );
  await update("report_progress", { text: "token=fake-sensitive-value" });
  await update("report_progress", { text: "token=fake-sensitive-value" });
  expect(
    TaskCardSchema.parse(row.card).timeline.filter((event) => event.kind === "progress"),
  ).toHaveLength(1);
  expect(JSON.stringify(row.card)).not.toContain("fake-sensitive-value");
  expect(f.tx.message.create).not.toHaveBeenCalled();
  await expect(update("report_progress", { text: "x".repeat(2001) }, "long")).rejects.toThrow();
  await expect(update("attach_artifact", { artifactId: "foreign" })).rejects.toThrow();
  await update("attach_artifact", { artifactId: "artifact" });
  await expect(update("complete_task", { summary: "Done", reports: [] })).rejects.toThrow(
    "every definition",
  );
  f.tx.externalEffect.findFirst.mockResolvedValue({ id: "approval" });
  await expect(
    update("complete_task", {
      summary: "Done",
      reports: [{ index: 0, met: true, report: "Passed" }],
    }),
  ).rejects.toThrow("waiting for approval");
  f.tx.externalEffect.findFirst.mockResolvedValue(null);
  await update("complete_task", {
    summary: "Done",
    reports: [{ index: 0, met: true, report: "Passed" }],
  });
  expect(f.state().rows[0].status).toBe("completed");
  expect(f.tx.message.create).toHaveBeenCalledOnce();
  expect(f.tx.message.create.mock.calls[0]![0].data.blocks[0].text).toContain(
    "Checklist passes: reported met — Passed",
  );
  await db.$transaction((tx) =>
    acceptDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator"),
  );
  expect(f.state().rows[0].status).toBe("accepted");
});
it("returns a completed card for rework with one more hop and a fresh bounded reservation", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "First pass"));
  f.state().runs.find((run) => run.id === row.runId).status = "completed";
  const result = await db.$transaction((tx) =>
    rejectDelegation(
      tx,
      { spaceId: "space", userId: "owner" },
      row.id,
      "coordinator",
      "Check the missing citation",
    ),
  );
  expect(result.runId).toBe("rework-run");
  expect(f.state().rows[0]).toMatchObject({ status: "queued", hop: 2, runId: "rework-run" });
  expect(f.state().root).toMatchObject({
    activeDescendants: 1,
    totalDescendants: 2,
    reservedTokens: 10000,
  });
  expect(f.state().rows[0].card.timeline.at(-1).text).toBe("Check the missing citation");
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Second pass"));
  expect(f.tx.message.create).toHaveBeenCalledOnce();
  expect(f.tx.message.update).toHaveBeenCalled();
});
it.each([
  ["hops-exceeded", { maxHops: 1 }],
  ["descendants-exceeded", { maxDescendants: 1 }],
  ["descendants-exceeded", { maxConcurrent: 0 }],
  ["budget-exhausted", { tokenLimit: 0 }],
  ["deadline-passed", { cancelRequestedAt: new Date() }],
])("refuses rework at the %s cap without reserving or queueing", async (code, patch) => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Done"));
  Object.assign(f.state().root, patch);
  const before = structuredClone(f.state());
  await expect(
    db.$transaction((tx) =>
      rejectDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator", "Rework"),
    ),
  ).rejects.toMatchObject({ problem: { code } });
  expect(f.state()).toEqual(before);
});

it("clears a saved blocker on a new executor attempt and deduplicates start retries", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => startDelegation(tx, row.id, "attempt-1"));
  await db.$transaction((tx) =>
    updateWorkerTask(tx, {
      runId: row.runId!,
      spaceId: "space",
      userId: "owner",
      botId: "worker",
      executionId: "blocked",
      tool: "report_progress",
      args: { state: "blocked", text: "Need a source", action: "Choose a source" },
    }),
  );
  await db.$transaction((tx) => startDelegation(tx, row.id, "attempt-2"));
  await db.$transaction((tx) => startDelegation(tx, row.id, "attempt-2"));
  const timeline = TaskCardSchema.parse(row.card).timeline;
  expect(timeline.at(-1)?.kind).toBe("started");
  expect(timeline.filter((event) => event.kind === "started")).toHaveLength(2);
});

it("replays a P1 admission without inventing a historical card", async () => {
  const f = fixture();
  const row = await f.admit();
  f.state().rows[0].card = null;
  f.state().rows[0].fingerprint = deviceDigest(
    JSON.stringify([input.actingBotId, input.kind, input.prompt]),
  );
  const replay = await f.worker().$transaction((tx) => admitDelegation(tx, input));
  expect(replay.id).toBe(row.id);
  expect(replay.card).toBeNull();
  expect(f.state().root.totalDescendants).toBe(1);
});

it("ignores a late completion from an attempt superseded by rework", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  const oldRunId = row.runId;
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "First pass", oldRunId));
  f.state().runs.find((run) => run.id === oldRunId).status = "completed";
  await db.$transaction((tx) =>
    rejectDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator", "Rework"),
  );
  await db.$transaction((tx) =>
    finishDelegation(tx, row.id, "completed", "Late old result", oldRunId),
  );
  expect(f.state().rows[0].status).toBe("queued");
  expect(f.state().rows[0].result).toBeNull();
});
