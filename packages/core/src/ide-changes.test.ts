import { describe, expect, it } from "vitest";
import { eventFileChanges, recordedDiffs } from "./ide-changes.js";

const event = {
  id: "event",
  botId: "bot",
  runId: "run",
  createdAt: new Date("2026-01-02T12:00:00Z"),
  type: "computer.file.changed",
  payload: {
    computerId: "computer",
    path: "src/main.ts",
    before: "old",
    after: "new",
    source: "tool",
  },
};
describe("recorded IDE changes", () => {
  it("projects bounded tool snapshots and artifact snapshots without inventing old content", () => {
    expect(eventFileChanges(event)).toMatchObject([
      { before: "old", after: "new", path: "src/main.ts" },
    ]);
    expect(
      eventFileChanges({
        ...event,
        payload: { ...event.payload, source: "artifact", before: null },
      }),
    ).toMatchObject([{ source: "artifact", before: null, after: "new" }]);
  });
  it("extracts side-by-side recorded hunks from command output", () => {
    const text =
      "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
    expect(recordedDiffs(text)).toEqual([
      {
        path: "src/main.ts",
        before: "@@ -1,2 +1,2 @@\nold\nsame\n",
        after: "@@ -1,2 +1,2 @@\nnew\nsame\n",
      },
    ]);
    expect(recordedDiffs("command changed some files")).toEqual([]);
  });
  it("does not turn arbitrary output, malformed or oversized records into file versions", () => {
    expect(
      eventFileChanges({
        ...event,
        type: "command.finished",
        payload: { block: { stdout: "private" } },
      }),
    ).toEqual([]);
    expect(
      eventFileChanges({ ...event, payload: { ...event.payload, before: "x".repeat(200_000) } }),
    ).toMatchObject([{ before: null }]);
  });
});
