import { describe, expect, it } from "vitest";
import {
  SetupJournalSchema,
  SetupNoInputSchema,
  SetupSnapshotSchema,
  SetupStepInputSchema,
} from "./desktop-setup.js";

const ids = [
  "prerequisites",
  "database",
  "migrations",
  "command",
  "services",
  "engines",
  "model",
  "first-bot",
  "finish",
] as const;
const snapshot = {
  schemaVersion: 1,
  planVersion: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
  mode: "local",
  currentStep: null,
  machineReady: false,
  accountReady: false,
  complete: false,
  interrupted: false,
  blocked: false,
  steps: ids.map((id) => ({
    id,
    available: ["prerequisites", "database", "migrations", "command"].includes(id),
    revision: 1,
    attempt: 0,
    status: "pending",
    activeElapsedMs: 0,
    waitingElapsedMs: 0,
    verifiedAt: null,
    reasonCode: null,
    details: [],
  })),
};

describe("desktop setup IPC contracts", () => {
  it("accepts the bounded snapshot and rejects secret, command, and extra fields", () => {
    expect(SetupSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(SetupSnapshotSchema.safeParse({ ...snapshot, credentials: "private" }).success).toBe(
      false,
    );
    expect(
      SetupSnapshotSchema.safeParse({
        ...snapshot,
        steps: [{ ...snapshot.steps[0], command: "arbitrary" }, ...snapshot.steps.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      SetupJournalSchema.safeParse({ version: 1, snapshot, pending: null, receipts: {} }).success,
    ).toBe(true);
    expect(
      SetupJournalSchema.safeParse({
        version: 1,
        snapshot,
        pending: null,
        receipts: {},
        token: "private",
      }).success,
    ).toBe(false);
  });

  it("accepts only a fixed step ID or no arguments", () => {
    expect(SetupStepInputSchema.safeParse("database").success).toBe(true);
    expect(SetupStepInputSchema.safeParse("rm -rf").success).toBe(false);
    expect(SetupNoInputSchema.safeParse([]).success).toBe(true);
    expect(SetupNoInputSchema.safeParse(["extra"]).success).toBe(false);
  });
});
