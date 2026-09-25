import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { CodexUsageCollector } from "./codex-usage.js";

const counts = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: inputTokens / 2,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: outputTokens / 2,
});
const request = (event: AgentRuntimeEvent | null) =>
  event?.type === "usage" ? event.request : undefined;
describe("Codex thread counters", () => {
  it("subtracts a pre-request resume boundary across all reported categories", () => {
    const collector = new CodexUsageCollector("openai-codex", "fixture", true);
    collector.seed(counts(100, 20));
    expect(request(collector.start())?.collection?.raw.input).toBe(100);
    const next = collector.update(counts(130, 28));
    expect(request(next)?.categories).toEqual({
      logicalInput: 30,
      uncachedInput: 15,
      cacheReadInput: 15,
      cacheWriteInput: 0,
      output: 8,
      reasoning: 4,
    });
    expect(request(next)?.collection?.raw.input).toBe(130);
    expect(collector.update(counts(130, 28))).toBeNull();
    expect(request(collector.finish("success"))?.categories.logicalInput).toBe(30);
  });
  it("does not charge an unverified lifetime total on resume", () => {
    const collector = new CodexUsageCollector("openai-codex", "fixture", true);
    collector.start();
    expect(collector.update(counts(1000, 100))).toBeNull();
    expect(request(collector.finish("success"))).toMatchObject({
      collection: {
        availability: "unavailable",
        limitations: expect.arrayContaining(["unverified-resume-boundary"]),
      },
      categories: { logicalInput: null },
    });
  });
  it("freezes on a reset or reordered counter instead of inventing a new billable epoch", () => {
    const collector = new CodexUsageCollector("openai-codex", "fixture", false);
    collector.start();
    collector.update(counts(100, 20));
    expect(collector.update(counts(10, 2))).toBeNull();
    expect(collector.update(counts(150, 30))).toBeNull();
    expect(request(collector.finish("success"))).toMatchObject({
      categories: { logicalInput: 100, output: 20 },
      collection: { limitations: expect.arrayContaining(["counter-discontinuity"]) },
    });
  });
  it("retains missing cache and reasoning detail as unknown", () => {
    const collector = new CodexUsageCollector("openai-codex", "fixture", false);
    const next = collector.update({ inputTokens: 0, outputTokens: 0 });
    expect(request(next)?.categories).toEqual({
      logicalInput: 0,
      uncachedInput: null,
      cacheReadInput: null,
      cacheWriteInput: null,
      output: 0,
      reasoning: null,
    });
  });
});
