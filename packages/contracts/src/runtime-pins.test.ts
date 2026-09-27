import { describe, expect, it } from "vitest";
import { DelegationSnapshotSchema } from "./delegation.js";
import { RunSchema } from "./domain.js";
import { ProductEventSchema } from "./events.js";
import { RunFailurePayloadSchema } from "./provider-errors.js";
import {
  RuntimeInfoSchema,
  RuntimePinError,
  RuntimePinSchema,
  RuntimePinSourceSchema,
  runtimePinMessage,
  runtimePinProblem,
} from "./runtime-pins.js";

const pin = {
  provider: "local",
  modelId: "model",
  effort: "high",
  credentialId: "connection",
  runtimeKind: "pi" as const,
  revision: 2,
};
describe("runtime pin contracts", () => {
  it("round trips effort evidence while keeping older runtime info readable", () => {
    const info = {
      runtimeKind: "claude-code",
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    };
    expect(RuntimeInfoSchema.parse(JSON.parse(JSON.stringify(info)))).toEqual(info);
    expect(RuntimeInfoSchema.parse({ runtimeKind: "claude-code" })).toEqual({
      runtimeKind: "claude-code",
    });
    expect(
      RuntimeInfoSchema.parse({ ...info, effortAttested: true, effortAttestationReason: null }),
    ).toMatchObject({ effortAttested: true, effortAttestationReason: null });
    expect(RuntimeInfoSchema.safeParse({ ...info, effortAttested: "false" }).success).toBe(false);
  });
  it("round trips a snapshot and a typed failure without secrets", () => {
    expect(RuntimePinSchema.parse(pin)).toEqual(pin);
    const problem = runtimePinProblem(pin, "pin-credential-missing", "The connection was deleted.");
    expect(RunFailurePayloadSchema.parse({ runtimeProblem: problem }).runtimeProblem).toEqual(
      problem,
    );
    expect(runtimePinMessage(pin, { provider: "Local", model: "My model" })).toBe(
      "This bot is pinned to Local · My model · high; connect it or change the pin.",
    );
  });
  it("preserves a runtime reason identifier across failure payloads", () => {
    const problem = runtimePinProblem(pin, "runtime-unavailable", "Timed out.", "timeout");
    expect(RunFailurePayloadSchema.parse({ runtimeProblem: problem }).runtimeProblem).toEqual(
      problem,
    );
  });
  it("validates typed failures even without the older provider error kind", () => {
    const event = {
      id: "event",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      seq: 0,
      type: "run.failed",
      createdAt: "2026-09-23",
      payload: { runtimeProblem: { code: "invented" } },
    };
    expect(ProductEventSchema.safeParse(event).success).toBe(false);
    expect(ProductEventSchema.safeParse({ ...event, payload: { error: "legacy" } }).success).toBe(
      true,
    );
    expect(ProductEventSchema.safeParse({ ...event, payload: { error: null } }).success).toBe(true);
  });
  it("includes the native runtime in the preserved pin sentence", () => {
    expect(runtimePinMessage({ ...pin, runtimeKind: "claude-code" })).toContain(
      "pinned to Claude Code · local · model · high",
    );
  });
});

it("validates each pin source and keeps older run and delegation snapshots readable", () => {
  const sources = [
    { kind: "group-member", groupId: "group", memberId: "member", botId: "bot" },
    { kind: "bot", botId: "bot" },
    { kind: "space-default", spaceId: "space", botId: "bot" },
  ] as const;
  for (const source of sources) expect(RuntimePinSourceSchema.parse(source)).toEqual(source);
  expect(RuntimePinSourceSchema.safeParse({ kind: "group-member", botId: "bot" }).success).toBe(
    false,
  );
  expect(RuntimePinSourceSchema.safeParse({ kind: "bot", botId: "" }).success).toBe(false);
  const delegation = {
    pin,
    computer: { id: null, mode: "team", kind: null },
    destination: { host: null, local: false },
  };
  expect(DelegationSnapshotSchema.parse(delegation)).toEqual(delegation);
  expect(
    DelegationSnapshotSchema.parse({ ...delegation, pinSource: sources[0] }).pinSource,
  ).toEqual(sources[0]);
  const run = {
    id: "run",
    botId: "bot",
    threadId: "thread",
    taskId: "task",
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
  expect(RunSchema.parse(run)).toEqual(run);
  expect(RunSchema.parse({ ...run, runtimePinSource: sources[1] }).runtimePinSource).toEqual(
    sources[1],
  );
});

it("uses the real reason and offers Connect only for a hosted credential failure", () => {
  const native = {
    ...pin,
    runtimeKind: "codex-app-server" as const,
    credentialId: "native:codex-app-server",
  };
  for (const selected of [pin, native]) {
    const problem = runtimePinProblem(
      selected,
      "pin-model-unknown",
      "The pinned model is unavailable in this runtime.",
    );
    expect(new RuntimePinError(problem).message).toBe(problem.reason);
    expect(problem.actions).toEqual(["change-pin"]);
  }
  const missing = runtimePinProblem(pin, "pin-credential-missing", "Missing connection");
  expect(missing.actions).toEqual(["connect", "change-pin"]);
  expect(new RuntimePinError(missing).message).toContain("connect it or change the pin");
});

it("offers no pin action for a local-import problem, unlike other problem codes", () => {
  for (const code of ["local-import-rescan", "local-import-item"] as const) {
    const problem = runtimePinProblem(pin, code, "Re-scan this computer before importing.");
    expect(problem.actions).toEqual([]);
  }
});
