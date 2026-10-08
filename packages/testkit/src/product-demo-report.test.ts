import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProductDemoObservation, ProductDemoStepId } from "./product-demo-report.js";
import {
  PRODUCT_DEMO_STEPS,
  ProductDemoRecorder,
  writeProductDemoReport,
} from "./product-demo-report.js";

vi.mock("node:fs/promises", () => ({ writeFile: vi.fn() }));

const revision = "a".repeat(40);
const observation = (id: ProductDemoStepId): ProductDemoObservation => ({
  screenshot: `screenshots/${id}.png`,
  evidence: "app-api",
});
async function complete(
  recorder: ProductDemoRecorder,
  action = async (id: ProductDemoStepId) => observation(id),
) {
  for (const step of PRODUCT_DEMO_STEPS) await recorder.step(step.id, () => action(step.id));
  return recorder.report();
}
describe("fixed product demo reports", () => {
  it("identifies an entirely unexecuted run and refuses overlapping steps", async () => {
    const skipped = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
    });
    for (const step of PRODUCT_DEMO_STEPS)
      await skipped.step(step.id, async () => observation(step.id), "not-executed");
    expect(skipped.report().execution).toBe("not-executed");
    expect(skipped.report().steps.every((row) => row.elapsedMs === null)).toBe(true);
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
    });
    let resolve!: (value: ProductDemoObservation) => void;
    const pending = recorder.step(
      "models",
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await expect(recorder.step("models", async () => observation("models"))).rejects.toThrow(
      "single-flight",
    );
    expect(() => recorder.report()).toThrow("seven");
    resolve(observation("models"));
    await pending;
  });
  it("retains exactly seven ordered steps and labels scripted outcomes without comparative claims", async () => {
    let now = 100;
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
      now: () => now++,
    });
    const report = await complete(recorder);
    expect(report.steps.map((row) => row.id)).toEqual([
      "models",
      "default-reply",
      "native-reply",
      "draft-pr",
      "chief-summary",
      "workspace",
      "room",
    ]);
    expect(report.steps).toHaveLength(7);
    expect(report.steps.every((row) => row.elapsedMs === 1 && row.result === "passed")).toBe(true);
    expect(report).toMatchObject({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
      comparativeSpeedClaim: false,
      selfBuildClaim: false,
    });
  });
  it("skips unexercised prerequisites and their dependents without calling the action or assigning zero", async () => {
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: true,
    });
    const absent = vi.fn(async () => observation("native-reply"));
    await recorder.step("models", async () => observation("models"));
    await recorder.step("default-reply", absent, "host-computer");
    await recorder.step("native-reply", absent, "native-runtime");
    await recorder.step("draft-pr", absent, "github");
    await recorder.step("chief-summary", absent, "integration");
    await recorder.step("workspace", absent);
    await recorder.step("room", async () => ({ ...observation("room"), replyGapMs: 12 }));
    const report = recorder.report();
    expect(absent).not.toHaveBeenCalled();
    expect(report.steps[1]).toMatchObject({
      result: "skipped",
      reason: "host-computer",
      elapsedMs: null,
      screenshot: null,
    });
    expect(report.steps[2]?.reason).toBe("native-runtime");
    expect(report.steps[3]?.reason).toBe("dependency-skipped");
    expect(report.steps[3]?.missingPrerequisite).toBe("github");
    expect(report.steps[4]?.reason).toBe("integration");
    expect(report.steps[5]?.reason).toBe("dependency-skipped");
    expect(report.steps[6]?.replyGapMs).toBe(12);
  });
  it("drops raw failure contents and stops dependent steps", async () => {
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: true,
    });
    const blocked = vi.fn();
    await recorder.step("models", async () => {
      throw new Error("private fixture path and token");
    });
    for (const step of PRODUCT_DEMO_STEPS.slice(1)) await recorder.step(step.id, blocked);
    const report = recorder.report();
    expect(blocked).not.toHaveBeenCalled();
    expect(report.steps[0]).toMatchObject({ result: "failed", reason: "action-failed" });
    expect(report.steps.slice(1).every((row) => row.result === "skipped")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private fixture");
  });
  it.each([
    "../private.png",
    "https://example.test/?token=fixture",
    "screenshots/private-fixture.png",
  ])("rejects unsafe or arbitrary evidence pointers (%s)", async (screenshot) => {
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: true,
    });
    await complete(recorder, async () => ({ screenshot, evidence: "app-api" }));
    expect(recorder.report().steps[0]?.result).toBe("failed");
    expect(JSON.stringify(recorder.report())).not.toContain(screenshot);
  });
  it("marks a fake draft-PR receipt as fixture evidence, never a live public write", async () => {
    const scripted = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
    });
    await complete(scripted, async (id) => ({
      ...observation(id),
      evidence: id === "draft-pr" ? "fixture-receipt" : "app-api",
    }));
    expect(scripted.report().steps[3]).toMatchObject({
      result: "passed",
      evidence: "fixture-receipt",
    });
    const live = new ProductDemoRecorder({
      mode: "live",
      buildRevision: revision,
      buildDirty: false,
    });
    await complete(live, async (id) => ({
      ...observation(id),
      evidence: id === "draft-pr" ? "fixture-receipt" : "manual",
    }));
    expect(live.report().steps[3]).toMatchObject({ result: "failed", reason: "action-failed" });
  });
  it("rejects out-of-order, duplicate and partial records", async () => {
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
    });
    expect(() => recorder.report()).toThrow("seven");
    await expect(recorder.step("room", async () => observation("room"))).rejects.toThrow("ordered");
    await recorder.step("models", async () => observation("models"));
    await expect(recorder.step("models", async () => observation("models"))).rejects.toThrow(
      "ordered",
    );
  });
  it("rejects backward and invalid clocks", async () => {
    let now = 100;
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
      now: () => now,
    });
    now = 99;
    await expect(recorder.step("models", async () => observation("models"))).rejects.toThrow(
      "clock",
    );
    expect(
      () =>
        new ProductDemoRecorder({
          mode: "scripted",
          buildRevision: revision,
          buildDirty: false,
          now: () => NaN,
        }),
    ).toThrow("clock");
  });
  it("preserves validated provenance independently of caller mutation and excludes extra metadata", async () => {
    const input = { mode: "scripted" as const, buildRevision: revision, buildDirty: false };
    const recorder = new ProductDemoRecorder(input);
    input.buildRevision = "private fixture value";
    await complete(recorder, async (id) => ({
      ...observation(id),
      extra: "private fixture value",
    }));
    expect(recorder.report().buildRevision).toBe(revision);
    expect(JSON.stringify(recorder.report())).not.toContain("private fixture value");
  });
  it("exports append-only JSON with restrictive file permissions", async () => {
    const recorder = new ProductDemoRecorder({
      mode: "scripted",
      buildRevision: revision,
      buildDirty: false,
    });
    await complete(recorder);
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    try {
      await writeProductDemoReport("report.json", recorder);
      expect(write).toHaveBeenCalledWith("report.json", expect.any(String), {
        flag: "wx",
        mode: 0o600,
      });
      const contents = JSON.parse(String(write.mock.calls[0]?.[1]));
      expect(contents.steps).toHaveLength(7);
      expect(contents.mode).toBe("scripted");
    } finally {
      write.mockRestore();
    }
  });
});
