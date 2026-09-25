import type { ContextSnapshot } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { aggregateContext, resumeContextSnapshot } from "./metrics.js";

it("aggregates recorded samples for bot and group without inventing missing metrics", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const snapshot: ContextSnapshot = {
    layers: { stable: 100, brief: 100, summary: 100, messages: 100, recall: 0, message: 50 },
    recallRan: false,
    recallCalls: 0,
    cachedTokens: 50,
    inputTokens: 100,
    queueWaitMs: 10,
    timeToFirstTokenMs: 100,
    routingRule: "default",
  };
  const rows = [100, 200, 400].map((timeToFirstTokenMs) => ({
    botId: "chief",
    groupId: "group",
    createdAt: now,
    contextSnapshot: { ...snapshot, timeToFirstTokenMs },
  }));
  rows.push({
    botId: "chief",
    groupId: "group",
    createdAt: now,
    contextSnapshot: {
      ...snapshot,
      cachedTokens: null,
      inputTokens: null,
      timeToFirstTokenMs: null,
    } as unknown as (typeof rows)[number]["contextSnapshot"],
  });
  const [bot, group] = aggregateContext(
    [
      ...rows,
      { ...rows[0]!, createdAt: new Date("2026-09-01") },
      { ...rows[0]!, contextSnapshot: null },
    ],
    new Date("2026-09-24"),
  );
  expect(bot).toMatchObject({
    groupId: null,
    runs: 4,
    measuredFirstTokenRuns: 3,
    measuredCacheRuns: 3,
    timeToFirstTokenP50Ms: 200,
    timeToFirstTokenP95Ms: 400,
    averagePromptCharacters: 450,
    cacheHitRatio: 0.5,
  });
  expect(group?.groupId).toBe("group");
  expect(
    resumeContextSnapshot(
      { ...snapshot, recallCalls: 1 },
      { ...snapshot, recallCalls: 2, cachedTokens: null },
    ),
  ).toMatchObject({
    timeToFirstTokenMs: 100,
    recallCalls: 3,
    cachedTokens: null,
    inputTokens: 100,
  });
  expect(resumeContextSnapshot(snapshot, null)).toBe(snapshot);
  expect(
    aggregateContext(
      [{ ...rows[0]!, contextSnapshot: { ...snapshot, cachedTokens: 101 } }],
      now,
    )[0],
  ).toMatchObject({ measuredCacheRuns: 0, cacheHitRatio: null });
  expect(
    aggregateContext(
      [{ ...rows[0]!, contextSnapshot: { ...snapshot, cachedTokens: null, inputTokens: null } }],
      now,
    )[0]?.cacheHitRatio,
  ).toBeNull();
});
