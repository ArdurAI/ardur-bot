import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { EVIDENCE_RECORDING_ERROR, recordToolDecision } from "./executor.js";
import { createEvidenceRecorder } from "./recorder.js";
import { fakeEvidenceStore } from "./test-store.js";

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
