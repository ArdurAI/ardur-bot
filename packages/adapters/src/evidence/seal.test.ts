import { afterEach, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { createEvidenceRecorder } from "./recorder.js";
import { createEvidenceSealer } from "./seal.js";
import { fakeEvidenceStore } from "./test-store.js";

afterEach(() => vi.useRealTimers());
it("bounds hung seal preparation without holding terminal work or claiming complete evidence", async () => {
  vi.useFakeTimers();
  const { store, seals } = fakeEvidenceStore();
  store.recordsForRun = vi.fn(() => new Promise<never>(() => {}));
  const recorder = createEvidenceRecorder({
    store,
    secretStore: new EncryptedSecretStore("fixture-material"),
  });
  const seal = createEvidenceSealer({ prisma: {} as never, store, recorder });
  let settled = false;
  const sealing = seal("run-test").then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
  expect(seals).toHaveLength(0);
  expect(await store.gapCount("run-test")).toBe(1);
});
