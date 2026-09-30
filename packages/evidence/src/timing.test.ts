import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { generateEvidenceKey, loadEvidencePrivateKey } from "./keys.js";
import { createEvidenceChain } from "./receipt.js";
import { receiptInput } from "./test-input.js";
import { verifyChain } from "./verify.js";

it.skipIf(process.env.ARDUR_EVIDENCE_TIMING !== "1")("measures 1,000 chained records", () => {
  const keys = generateEvidenceKey();
  const chain = createEvidenceChain(loadEvidencePrivateKey(keys.privateKeyPem), keys.kid);
  const input = receiptInput();
  const times: number[] = [];
  const records: string[] = [];
  for (let index = 0; index < 1_000; index++) {
    const start = performance.now();
    const record = chain.append(input);
    times.push(performance.now() - start);
    records.push(record.jws);
  }
  times.sort((a, b) => a - b);
  const percentile = (fraction: number) => times[Math.ceil(times.length * fraction) - 1] ?? 0;
  console.log(
    `Evidence append: 1000 records; p50=${percentile(0.5).toFixed(3)} ms; p95=${percentile(0.95).toFixed(3)} ms`,
  );
  expect(verifyChain(records, keys.publicKeyPem).ok).toBe(true);
  expect(chain.nextStep).toBe(1_000);
});
