import { writeFileSync } from "node:fs";
import type { Prisma } from "@ardurbot/db";
import { DelegationAdmissionError } from "@ardurbot/db";
import { fixture, input, snapshot } from "@ardurbot/db/testing/delegation";
import { expect, it, vi } from "vitest";
import { prepareDelegation, resolveDelegationTarget } from "./delegation.js";

function resolver() {
  return vi.fn(async () => ({
    kind: "resolved" as const,
    pin: snapshot.pin,
    runtimePin: snapshot.pin,
    provider: "fixture",
    id: "fixture",
    thinkingLevel: "high" as const,
  }));
}

it.each(["default-model", "default-connection", "connection-revision", "secret-reference"])(
  "refuses a stale %s after the root-lock wait without reserving tokens",
  async (change) => {
    const f = fixture();
    const credential = {
      id: "connection",
      provider: "fixture",
      secretId: "fixture-secret",
      updatedAt: new Date(0),
    };
    const preference = {
      id: "preference",
      credentialId: credential.id,
      modelId: "fixture",
      updatedAt: new Date(0),
      credential,
    };
    Object.assign(f.tx, {
      spaceModelPreference: { findFirst: vi.fn(async () => preference) },
      userModelCredential: { findFirst: vi.fn(async () => credential) },
    });
    if (change === "connection-revision" || change === "secret-reference")
      Object.assign(f.bot, {
        modelProvider: "fixture",
        modelId: "fixture",
        modelCredentialId: credential.id,
      });
    const db = f.worker();
    const resolve = resolver();
    const target = await resolveDelegationTarget(db, input, resolve);
    f.tx.$queryRaw.mockImplementationOnce(async () => {
      if (change === "default-model") preference.modelId = "replacement-model";
      if (change === "default-connection") preference.credentialId = "replacement-connection";
      if (change === "connection-revision") credential.updatedAt = new Date(1);
      if (change === "secret-reference") credential.secretId = "replacement-secret";
      return [];
    });
    await expect(
      db.$transaction((tx) => prepareDelegation(tx, input, target)),
    ).rejects.toMatchObject({ problem: { code: "authority-exceeded" } });
    expect(resolve).toHaveBeenCalledOnce();
    expect(f.tx.delegationRoot.update).not.toHaveBeenCalled();
    expect(f.state().rows).toHaveLength(0);
  },
);

it("resolves once before the root lock, then admits with the captured pin", async () => {
  const f = fixture();
  const resolve = resolver();
  const db = f.worker();
  const target = await resolveDelegationTarget(db, input, resolve);
  const result = await db.$transaction((tx) => prepareDelegation(tx, input, target));
  expect(result).toMatchObject({ ok: true, runData: { runtimePin: snapshot.pin } });
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(
    f.tx.$queryRaw.mock.invocationCallOrder[0]!,
  );
  // Preflight reads the target once; admission re-reads requester and recipient under the lock.
  expect(f.tx.bot.findFirstOrThrow).toHaveBeenCalledTimes(3);
});

it.each(["pin", "computer"])(
  "refuses a stale %s after waiting for the lock without reserving tokens",
  async (field) => {
    const f = fixture();
    const db = f.worker();
    const resolve = resolver();
    const target = await resolveDelegationTarget(db, input, resolve);
    f.tx.$queryRaw.mockImplementationOnce(async () => {
      Object.assign(
        f.bot,
        field === "pin" ? { modelPinRevision: 4 } : { computerId: "other-computer" },
      );
      return [];
    });
    await expect(
      db.$transaction((tx) => prepareDelegation(tx, input, target)),
    ).rejects.toBeInstanceOf(DelegationAdmissionError);
    expect(resolve).toHaveBeenCalledOnce();
    expect(f.tx.delegationRoot.update).not.toHaveBeenCalled();
    expect(f.state().rows).toHaveLength(0);
  },
);

it.each(["override", "revision", "rejoined"])(
  "rejects a room member's stale %s, including a previously inherited pin",
  async (change) => {
    const f = fixture();
    const member = {
      id: "member",
      groupId: "group",
      botId: "worker",
      modelPinRevision: 0,
      runtimePin: null as unknown,
    };
    const group = { members: [member] };
    Object.assign(f.tx, {
      chatGroup: { findFirst: vi.fn(async () => group) },
      chatGroupMember: { findFirst: vi.fn(async () => (member.id === "member" ? member : null)) },
    });
    Object.assign(f.tx.thread, { findFirst: vi.fn(async () => ({ groupId: "group" })) });
    const db = f.worker();
    const resolve = resolver();
    const target = await resolveDelegationTarget(
      db,
      { ...input, targetThreadId: "thread" },
      resolve,
    );
    f.tx.$queryRaw.mockImplementationOnce(async () => {
      if (change === "override") member.runtimePin = snapshot.pin;
      if (change === "revision") member.modelPinRevision++;
      if (change === "rejoined") member.id = "new-member";
      return [];
    });
    await expect(
      db.$transaction((tx) => prepareDelegation(tx, input, target)),
    ).rejects.toMatchObject({ problem: { code: "authority-exceeded" } });
    expect(f.tx.delegationRoot.update).not.toHaveBeenCalled();
    expect(f.state().rows).toHaveLength(0);
  },
);

it("accepts an unchanged room pin when JSON object keys are returned in a different order", async () => {
  const f = fixture();
  const member = {
    id: "member",
    modelPinRevision: snapshot.pin.revision,
    runtimePin: Object.fromEntries(Object.entries(snapshot.pin).reverse()),
  };
  Object.assign(f.tx, {
    chatGroup: { findFirst: vi.fn(async () => ({ members: [member] })) },
    chatGroupMember: { findFirst: vi.fn(async () => member) },
  });
  Object.assign(f.tx.thread, { findFirst: vi.fn(async () => ({ groupId: "group" })) });
  const db = f.worker();
  const target = await resolveDelegationTarget(
    db,
    { ...input, targetThreadId: "thread" },
    resolver(),
  );
  await expect(
    db.$transaction((tx) => prepareDelegation(tx, input, target)),
  ).resolves.toMatchObject({ ok: true });
});

it("rejects a target that changes after a name was resolved, even when its settings match", async () => {
  const f = fixture();
  const db = f.worker();
  const target = await resolveDelegationTarget(db, input, resolver());
  await expect(
    db.$transaction((tx) =>
      prepareDelegation(tx, { ...input, actingBotId: "other-worker" }, target),
    ),
  ).rejects.toMatchObject({ problem: { code: "authority-exceeded" } });
  expect(f.state().rows).toHaveLength(0);
});

it("measures admission operations without enabling production query logging", async () => {
  const f = fixture();
  const db = f.worker();
  const target = await resolveDelegationTarget(db, input, resolver());
  const operations: Array<{ operation: string; durationMs: number }> = [];
  const wrap = (object: object, prefix = ""): object =>
    new Proxy(object, {
      get(base, key) {
        const value = Reflect.get(base, key);
        const operation = `${prefix}${String(key)}`;
        if (typeof value === "function")
          return async (...args: unknown[]) => {
            const start = performance.now();
            try {
              return await value.apply(base, args);
            } finally {
              operations.push({ operation, durationMs: performance.now() - start });
            }
          };
        return value && typeof value === "object" ? wrap(value, `${operation}.`) : value;
      },
    });
  const started = performance.now();
  await db.$transaction((tx) =>
    prepareDelegation(wrap(tx) as Prisma.TransactionClient, input, target),
  );
  const lock = operations.findIndex(
    (row, index) =>
      row.operation === "$queryRaw" && operations[index - 1]?.operation === "$queryRaw",
  );
  expect(lock).toBeGreaterThan(0);
  const afterLock = operations.slice(lock + 1);
  const measurement = {
    operations: operations.length,
    afterRootLock: afterLock.length,
    elapsedMs: performance.now() - started,
    operationMs: operations.reduce((sum, row) => sum + row.durationMs, 0),
    trace: operations,
  };
  const output = process.env.DELEGATION_ADMISSION_MEASUREMENT_FILE;
  if (output) writeFileSync(output, JSON.stringify(measurement, null, 2));
  // biome-ignore lint/suspicious/noConsole: Test-only measurement requested for admission sizing.
  console.info("delegation admission offline operations", JSON.stringify(measurement));
  expect(operations.filter((row) => row.operation === "$queryRaw")).toHaveLength(2);
  expect(afterLock.some((row) => row.operation === "delegation.create")).toBe(true);
});
