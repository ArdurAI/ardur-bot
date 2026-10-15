import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { EVIDENCE_RECORDING_ERROR, recordToolDecision } from "./executor.js";
import { createEvidenceRecorder, createNoopEvidenceRecorder } from "./recorder.js";
import { fakeEvidenceStore } from "./test-store.js";

describe("optional recording", () => {
  it("does not refuse state-changing tools when no recorder is configured", async () => {
    const recorder = createNoopEvidenceRecorder();
    const input = {
      run: { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" },
      toolName: "shell",
      viaConnector: false,
      args: { command: "fixture command" },
      decisionKind: "allowed_by_default" as const,
    };
    expect(await recorder.recordDecision(input)).toEqual({ ok: true, recorded: false });
    expect(await recordToolDecision(recorder, input)).toBeUndefined();
    recorder.releaseRunState(input.run.id);
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({ ok: true, recorded: false });
  });
});

describe("governance gate for project plan tools", () => {
  it("runs each plan tool through the pre-handler gate with governance on", async () => {
    const { store, records } = fakeEvidenceStore();
    const recorder = createEvidenceRecorder({
      store,
      secretStore: new EncryptedSecretStore("test-only-encryption-material"),
    });
    const run = { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" };
    for (const toolName of [
      "update_project_plan",
      "record_plan_step_outcome",
      "set_plan_step",
    ] as const) {
      // The pre-handler gate records the decision before the tool executes;
      // an unclassified tool used to throw here and never reach the handler.
      await expect(
        recordToolDecision(recorder, {
          run,
          toolName,
          viaConnector: false,
          args: {},
          decisionKind: "allowed_by_default",
        }),
      ).resolves.toBeUndefined();
    }
    expect(records).toHaveLength(3);
    for (const row of records) {
      expect(row.toolName).toMatch(
        /^(update_project_plan|record_plan_step_outcome|set_plan_step)$/,
      );
      expect(row.verdict).toBe("compliant");
    }
  });
});

describe("recording failure policy", () => {
  it.each([
    ["shell", false, true],
    ["write_file", false, true],
    ["mail_send", true, true],
    ["read_file", false, false],
    ["web_fetch", false, false],
    ["mail_get", true, false],
  ] as const)(
    "handles %s independently of approval exemptions",
    async (toolName, viaConnector, mutates) => {
      const { store } = fakeEvidenceStore();
      vi.mocked(store.insertRecord).mockRejectedValue(new Error("Storage unavailable"));
      const recorder = createEvidenceRecorder({
        store,
        secretStore: new EncryptedSecretStore("test-only-encryption-material"),
      });
      const execute = vi.fn();
      const run = { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" };
      const refusal = await recordToolDecision(recorder, {
        run,
        toolName,
        viaConnector,
        args: {},
        decisionKind: "allowed_by_default",
      });
      if (!refusal) execute();
      expect(refusal).toEqual(mutates ? { error: EVIDENCE_RECORDING_ERROR } : undefined);
      expect(execute).toHaveBeenCalledTimes(mutates ? 0 : 1);
      expect(await store.gapCount(run.id)).toBe(1);
    },
  );
});
