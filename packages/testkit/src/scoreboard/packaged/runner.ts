import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalSerialize, contentDigest } from "../manifest.js";
import type { ClientCapture } from "./evidence.js";
import { ingestClientCapture } from "./evidence.js";
import type { PackagedTrial } from "./plan.js";

export interface PackagedDriver {
  /** The driver must reset state before each attempt and return only synthetic, scrubbed evidence. */
  run(trial: PackagedTrial, signal: AbortSignal): Promise<ClientCapture>;
  close(): Promise<void>;
}

export async function writeImmutableReport(directory: string, value: unknown) {
  const raw = canonicalSerialize(value);
  const sha256 = contentDigest(value);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${sha256}.json`);
  try {
    await writeFile(file, raw, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
      (await readFile(file, "utf8")) !== raw
    )
      throw error;
  }
  return { sha256, bytes: Buffer.byteLength(raw), file: `${sha256}.json` };
}

/** Always persist failed attempts. Cancellation records every remaining planned slot as unmeasured. */
export async function runPackagedPlan(options: {
  plan: readonly PackagedTrial[];
  driver: PackagedDriver;
  expected: Record<PackagedTrial["build"], Parameters<typeof ingestClientCapture>[1]>;
  output: string;
  signal: AbortSignal;
}) {
  if (new Set(options.plan.map((t) => t.resetId)).size !== options.plan.length)
    throw new Error("Reused startup reset identity");
  const results = [];
  let cleanup: "complete" | "failed" = "complete";
  try {
    for (const trial of options.plan) {
      let result: object;
      try {
        if (options.signal.aborted) throw new Error("Cancelled");
        const capture = await options.driver.run(trial, options.signal);
        if (canonicalSerialize(capture.trial) !== canonicalSerialize(trial))
          throw new Error("Driver changed the planned trial");
        const collected = ingestClientCapture(capture, options.expected[trial.build]);
        const trace = await writeImmutableReport(options.output, collected.trace.raw);
        const raw = await writeImmutableReport(options.output, JSON.parse(collected.raw));
        result = {
          trial,
          status: collected.complete ? "complete" : "incomplete",
          outcome: capture.outcome,
          trace,
          raw,
        };
      } catch {
        result = {
          trial,
          status: "incomplete",
          reason: options.signal.aborted ? "cancelled-before-measurement" : "capture-failed",
        };
      }
      const artifact = await writeImmutableReport(options.output, result);
      results.push({ ...result, artifact });
    }
  } finally {
    try {
      await options.driver.close();
    } catch {
      cleanup = "failed";
    }
  }
  const manifest = { version: 1, planHash: contentDigest(options.plan), cleanup, results };
  return { ...manifest, artifact: await writeImmutableReport(options.output, manifest) };
}
