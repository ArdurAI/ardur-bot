import type { ThreadMessage } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveSealPhase,
  isSealSearchActivity,
  SEAL_DONE_MS,
  SEAL_STARTING_MS,
  sealActivity,
} from "./phase.js";

const now = 1_000_000;
const running = { status: "running", startedAt: now - 60_000, now };

/** One test per row of the mapping table in docs/seal-scenes.md. */
describe("deriveSealPhase", () => {
  it("rests when the bot has no run", () => {
    expect(deriveSealPhase({})).toEqual({ phase: "idle" });
    expect(deriveSealPhase({ status: "idle" })).toEqual({ phase: "idle" });
  });

  it("starts while the run is queued", () => {
    expect(deriveSealPhase({ status: "queued" })).toEqual({ phase: "starting" });
  });

  it("starts while the run is leased", () => {
    expect(deriveSealPhase({ status: "leased" })).toEqual({ phase: "starting" });
  });

  it("starts for the first moments of a running run, ahead of any activity", () => {
    const startedAt = now - SEAL_STARTING_MS + 1;
    expect(
      deriveSealPhase({ status: "running", startedAt, now, activity: { tool: "web_search" } }),
    ).toEqual({ phase: "starting", until: startedAt + SEAL_STARTING_MS });
    expect(deriveSealPhase({ status: "running", startedAt: now - SEAL_STARTING_MS, now })).toEqual({
      phase: "thinking",
    });
  });

  it("searches while a search, read or browse tool call is in progress", () => {
    for (const tool of ["web_search", "Read file", "Searching the web: seals", "WebFetch"]) {
      expect(
        deriveSealPhase({ ...running, activity: { tool, plan: { done: 1, total: 3 } } }),
        tool,
      ).toEqual({ phase: "searching" });
    }
  });

  it("works through steps when the plan or task list has two or more steps", () => {
    expect(deriveSealPhase({ ...running, activity: { plan: { done: 1, total: 2 } } })).toEqual({
      phase: "steps",
      progress: { done: 1, total: 2 },
    });
  });

  it("thinks for any other running work", () => {
    expect(deriveSealPhase(running)).toEqual({ phase: "thinking" });
    expect(deriveSealPhase({ status: "running" })).toEqual({ phase: "thinking" });
    expect(
      deriveSealPhase({ ...running, activity: { tool: "shell", plan: { done: 0, total: 1 } } }),
    ).toEqual({ phase: "thinking" });
  });

  it("waits while the run waits for the reader's input", () => {
    expect(deriveSealPhase({ status: "waiting_input" })).toEqual({ phase: "waiting" });
  });

  it("pauses while the run waits for the reader to take over", () => {
    expect(deriveSealPhase({ status: "waiting_takeover" })).toEqual({ phase: "paused" });
  });

  it("shows done for a few seconds after the run completes", () => {
    const endedAt = now - SEAL_DONE_MS + 1;
    expect(deriveSealPhase({ status: "completed", endedAt, now })).toEqual({
      phase: "done",
      until: endedAt + SEAL_DONE_MS,
    });
  });

  it("rests once the done moment has passed", () => {
    expect(deriveSealPhase({ status: "completed", endedAt: now - SEAL_DONE_MS, now })).toEqual({
      phase: "idle",
    });
    expect(deriveSealPhase({ status: "completed", now })).toEqual({ phase: "idle" });
  });

  it("shows an error for a failed run until the reader sees it", () => {
    expect(deriveSealPhase({ status: "failed" })).toEqual({ phase: "error" });
  });

  it("rests after a failed run's error has been seen", () => {
    expect(deriveSealPhase({ status: "failed", errorSeen: true })).toEqual({ phase: "idle" });
  });

  it("rests after a cancelled run", () => {
    expect(deriveSealPhase({ status: "cancelled" })).toEqual({ phase: "idle" });
  });
});

describe("search activity", () => {
  it.each([
    "web_search",
    "read_file",
    "browser_navigate",
    "web_fetch",
    "Grep",
    "recall_memory",
    "Reading src/index.ts",
    "Browser snapshot",
  ])("counts %s as searching", (tool) => {
    expect(isSealSearchActivity(tool)).toBe(true);
  });

  it.each(["shell", "write_file", "Running: pnpm test", "readme_writer", "Ready to send"])(
    "does not count %s",
    (tool) => {
      expect(isSealSearchActivity(tool)).toBe(false);
    },
  );
});

describe("seal activity from the work record", () => {
  const message = (
    id: string,
    blocks: ThreadMessage["blocks"],
    runId = "run-1",
  ): Pick<ThreadMessage, "id" | "runId" | "blocks"> => ({ id, runId, blocks });

  it("reads the tool call at the end of the run's live message", () => {
    expect(
      sealActivity(
        [
          message("progress:run-1", [
            { kind: "text", text: "Let me look." },
            { kind: "progress", text: "", pendingToolNames: ["shell", "web_search"] },
          ]),
        ],
        "run-1",
      ),
    ).toEqual({ tool: "web_search" });
    expect(
      sealActivity(
        [message("progress:run-1", [{ kind: "steps", steps: [{ label: "Read file", count: 2 }] }])],
        "run-1",
      ),
    ).toEqual({ tool: "Read file" });
    expect(
      sealActivity(
        [
          message("progress:run-1", [
            { kind: "progress", text: "Searching the web: seals", activity: true },
          ]),
        ],
        "run-1",
      ),
    ).toEqual({ tool: "Searching the web: seals" });
  });

  it("ignores narration after the tools and other runs' messages", () => {
    expect(
      sealActivity(
        [
          message("progress:run-1", [
            { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
            { kind: "progress", text: "Here is what I found" },
          ]),
          message(
            "progress:run-2",
            [{ kind: "progress", text: "", pendingToolNames: ["grep"] }],
            "run-2",
          ),
        ],
        "run-1",
      ),
    ).toEqual({});
  });

  it("counts the run's subagents as a task list", () => {
    const subagent = (agentId: string, status: "running" | "completed" | "failed") => ({
      kind: "subagent" as const,
      agentId,
      name: agentId,
      task: "Check one source",
      status,
    });
    expect(
      sealActivity(
        [
          message("subagent:a", [subagent("a", "running")]),
          message("subagent:b", [subagent("b", "running")]),
          message("m-1", [subagent("a", "completed")]),
          message("subagent:c", [subagent("c", "failed")], "run-2"),
        ],
        "run-1",
      ),
    ).toEqual({ plan: { done: 1, total: 2 } });
  });
});
