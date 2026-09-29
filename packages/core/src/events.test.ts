import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import type { LiveMessageUpdate } from "./events.js";
import {
  appendTextSegment,
  appendToolCallSegment,
  appendToolStep,
  containsSecret,
  createStreamingRedactor,
  endsSentence,
  humanizeToolName,
  isRunTerminalEvent,
  projectMessages,
  redactSecrets,
  reduceLiveMessageBlocks,
  runFailureError,
  sanitizeJsonValue,
  sanitizeUtf16ForJson,
  trackToolCallStreak,
  trackToolNameStreak,
} from "./events.js";
import { redactLearningText } from "./learning-signals.js";
import { isInterimNarrationAt, isReasoningSummaryBlock } from "./tool-activity.js";
import { workRecordEntries } from "./work-record.js";

describe("containsSecret", () => {
  it("detects secrets that JSON escaping changes", () => {
    expect(containsSecret({ 'api"key42': { nested: 'api"key42' } }, ['api"key42'])).toBe(true);
    expect(containsSecret({ nested: ["line\nbreak"] }, ["line\nbreak"])).toBe(true);
  });

  it("does not confuse escaped text with the original control character", () => {
    expect(containsSecret({ value: "literal\\ntext" }, ["\n"])).toBe(false);
  });

  it("redacts every registered value, including short values inside prose", () => {
    expect(redactSecrets("prefix ab12cdsuffix", ["ab12cd"])).toBe("prefix [redacted]suffix");
    expect(containsSecret({ content: "prefix ab12cdsuffix" }, ["ab12cd"])).toBe(true);
    expect(redactSecrets("plain", [])).toBe("plain");
  });

  it("uses exact registered values across stream chunks", () => {
    expect(redactLearningText("before ab12cdsuffix", ["ab12cd"])).toBe("before [redacted]suffix");
  });
});

describe("isRunTerminalEvent", () => {
  it("recognizes every terminal run outcome", () => {
    expect(isRunTerminalEvent({ type: "run.completed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.failed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.cancelled" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.waiting_input" })).toBe(false);
  });
});

describe("reduceLiveMessageBlocks", () => {
  it("preserves structured live activity markers", () => {
    expect(
      reduceLiveMessageBlocks([], {
        type: "progress",
        payload: { text: "Using browser", activity: true },
      }),
    ).toEqual([{ kind: "progress", text: "Using browser", activity: true }]);
  });

  it("replaces punctuated activity text with its tool step", () => {
    const activity = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Running: echo done.", activity: true },
    });

    expect(reduceLiveMessageBlocks(activity, { type: "tool", name: "shell" })).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("carries the reasoning marker and never flushes it into reply text", () => {
    expect(
      reduceLiveMessageBlocks([], {
        type: "progress",
        payload: { text: "Weighing options.", reasoning: true },
      }),
    ).toEqual([{ kind: "progress", text: "Weighing options.", reasoning: true }]);

    // A tool call after a punctuated reasoning summary keeps it out of the
    // durable text segments, unlike ordinary narration, and keeps the summary
    // itself ahead of the step instead of replacing it.
    const reasoning = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Weighing options.", reasoning: true },
    });
    expect(reduceLiveMessageBlocks(reasoning, { type: "tool", name: "shell" })).toEqual([
      { kind: "progress", text: "Weighing options.", reasoning: true },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);

    const narration = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Let me check." },
    });
    expect(reduceLiveMessageBlocks(narration, { type: "tool", name: "shell" })).toEqual([
      { kind: "text", text: "Let me check." },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("starts a new block when a narration delta follows a reasoning tail", () => {
    const reasoning = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Weighing options.", reasoning: true },
    });
    const next = reduceLiveMessageBlocks(reasoning, {
      type: "progress",
      payload: { delta: "The answer", streaming: true },
    });

    // Two blocks with correct markers; the thought never merges into the reply.
    expect(next).toEqual([
      { kind: "progress", text: "Weighing options.", reasoning: true },
      { kind: "progress", text: "The answer" },
    ]);

    // The reply keeps streaming into its own block.
    expect(
      reduceLiveMessageBlocks(next, {
        type: "progress",
        payload: { delta: " is four.", streaming: true },
      }),
    ).toEqual([
      { kind: "progress", text: "Weighing options.", reasoning: true },
      { kind: "progress", text: "The answer is four." },
    ]);
  });

  it("keeps a replacement activity title intact after narration", () => {
    const narration = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Let me check the calendar first." },
    });
    const next = reduceLiveMessageBlocks(narration, {
      type: "progress",
      payload: { text: "Running tests", activity: true },
    });

    expect(next).toEqual([
      { kind: "progress", text: "Let me check the calendar first." },
      { kind: "progress", text: "Running tests", activity: true },
    ]);
  });

  it("keeps a replacement reasoning summary intact after narration", () => {
    const narration = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Let me check." },
    });
    const next = reduceLiveMessageBlocks(narration, {
      type: "progress",
      payload: { text: "Weighing options.", reasoning: true },
    });

    expect(next).toEqual([
      { kind: "progress", text: "Let me check." },
      { kind: "progress", text: "Weighing options.", reasoning: true },
    ]);
  });

  it("continues a same-category narration delta from the accumulated offset", () => {
    const narration = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Let me check." },
    });
    const next = reduceLiveMessageBlocks(narration, {
      type: "progress",
      payload: { delta: " Still looking.", streaming: true },
    });

    expect(next).toEqual([{ kind: "progress", text: "Let me check. Still looking." }]);
  });

  it("folds narration flushed to text before a tool call into the record", () => {
    const streamed = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Let me check." },
    });
    const blocks = reduceLiveMessageBlocks(streamed, { type: "tool", name: "shell" });

    expect(isInterimNarrationAt(blocks, 0)).toBe(true);
    expect(workRecordEntries(blocks).map((entry) => entry.evidence.label)).toEqual([
      "narration",
      "tool-activity",
    ]);
  });

  it("keeps the activity title whole across a same-category replacement (tool_call then tool_call_update)", () => {
    // The Hermes sequence: an introductory sentence, then two activity `text`
    // updates for one call. The second update shares the tail's category, so
    // before offset 0 applied to same-category replacements, the accumulated
    // narration length truncated or erased the title mid-tool.
    const narration = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Let me check the calendar first." },
    });
    const called = reduceLiveMessageBlocks(narration, {
      type: "progress",
      payload: { text: "Hermes is working.", activity: true },
    });
    const updated = reduceLiveMessageBlocks(called, {
      type: "progress",
      payload: { text: "Hermes is still working.", activity: true },
    });

    expect(updated).toEqual([
      { kind: "progress", text: "Let me check the calendar first." },
      { kind: "progress", text: "Hermes is still working.", activity: true },
    ]);
  });

  it("keeps a reasoning replacement whole when the tail is already reasoning", () => {
    const reasoning = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Weighing options.", reasoning: true },
    });
    const replaced = reduceLiveMessageBlocks(reasoning, {
      type: "progress",
      payload: { text: "Weighing options, still.", reasoning: true },
    });

    expect(replaced).toEqual([
      { kind: "progress", text: "Weighing options, still.", reasoning: true },
    ]);
  });

  it("materializes held tool names as steps when narration seals the activity tail", () => {
    const activity = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Running tests", activity: true },
    });
    const held = reduceLiveMessageBlocks(activity, { type: "tool", name: "vitest" });
    expect(held).toEqual([
      { kind: "progress", text: "Running tests", activity: true, pendingToolNames: ["vitest"] },
    ]);

    // Narration resumes across the category boundary: the held name rides
    // forward and becomes a step at the first sentence end instead of
    // disappearing with the sealed tail.
    const sealed = reduceLiveMessageBlocks(held, {
      type: "progress",
      payload: { delta: "All green.", streaming: true },
    });
    expect(sealed).toEqual([
      { kind: "progress", text: "Running tests", activity: true },
      { kind: "text", text: "All green." },
      { kind: "steps", steps: [{ label: "Vitest", count: 1 }] },
    ]);

    // The reply keeps streaming after the flushed beat.
    expect(
      reduceLiveMessageBlocks(sealed, {
        type: "progress",
        payload: { delta: "Wrapping up now", streaming: true },
      }),
    ).toEqual([
      { kind: "progress", text: "Running tests", activity: true },
      { kind: "text", text: "All green." },
      { kind: "steps", steps: [{ label: "Vitest", count: 1 }] },
      { kind: "progress", text: "Wrapping up now" },
    ]);
  });

  it("carries a held tool name across a mid-sentence seal until the new tail completes", () => {
    const activity = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Running tests", activity: true },
    });
    const held = reduceLiveMessageBlocks(activity, { type: "tool", name: "vitest" });
    const sealed = reduceLiveMessageBlocks(held, {
      type: "progress",
      payload: { delta: "Almost", streaming: true },
    });
    expect(sealed).toEqual([
      { kind: "progress", text: "Running tests", activity: true },
      { kind: "progress", text: "Almost", pendingToolNames: ["vitest"] },
    ]);

    expect(
      reduceLiveMessageBlocks(sealed, {
        type: "progress",
        payload: { delta: " done.", streaming: true },
      }),
    ).toEqual([
      { kind: "progress", text: "Running tests", activity: true },
      { kind: "text", text: "Almost done." },
      { kind: "steps", steps: [{ label: "Vitest", count: 1 }] },
    ]);
  });
});

type LiveCategory = "narration" | "activity" | "reasoning";

const categoryPayload = (category: LiveCategory, text: string, delta: boolean) => {
  const marker =
    category === "activity"
      ? { activity: true as const }
      : category === "reasoning"
        ? { reasoning: true as const }
        : {};
  return delta ? { delta: text, streaming: true, ...marker } : { text, ...marker };
};

const progressBlock = (category: LiveCategory, text: string, pending?: string[]) => ({
  kind: "progress" as const,
  text,
  ...(category === "activity" ? { activity: true as const } : {}),
  ...(category === "reasoning" ? { reasoning: true as const } : {}),
  ...(pending ? { pendingToolNames: pending } : {}),
});

describe("reduceLiveMessageBlocks transition matrix", () => {
  const categories: LiveCategory[] = ["narration", "activity", "reasoning"];
  const cases: {
    from: LiveCategory;
    to: LiveCategory;
    delta: boolean;
    payload: string;
    updateText: string;
    expected: ReturnType<typeof progressBlock>[];
  }[] = [];

  for (const from of categories) {
    for (const to of categories) {
      for (const delta of [false, true]) {
        const same = from === to;
        // Narration `text` payloads carry the full reply so far; activity and
        // reasoning `text` payloads carry only the block's title. Deltas
        // append to the current block, whatever its category.
        const updateText = delta
          ? " beta"
          : to === "narration"
            ? same
              ? "Alpha beta"
              : "Omega"
            : "Omega";
        const expectedText = delta ? (same ? "Alpha beta" : " beta") : updateText;
        const expected = same
          ? [progressBlock(to, expectedText)]
          : [progressBlock(from, "Alpha"), progressBlock(to, expectedText)];
        cases.push({ from, to, delta, payload: delta ? "delta" : "text", updateText, expected });
      }
    }
  }

  it.each(cases)("$from -> $to $payload keeps every block whole and marked", (entry) => {
    const start = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: categoryPayload(entry.from, "Alpha", false),
    });
    const next = reduceLiveMessageBlocks(start, {
      type: "progress",
      payload: categoryPayload(entry.to, entry.updateText, entry.delta),
    });
    expect(next).toEqual(entry.expected);

    // Trailing narration stays the reply: it keeps streaming in one unmarked
    // block instead of folding into the record.
    if (entry.to === "narration") {
      const tail = next.at(-1);
      expect(tail?.kind).toBe("progress");
      expect(tail && "activity" in tail ? tail.activity : undefined).toBeUndefined();
      expect(tail && "reasoning" in tail ? tail.reasoning : undefined).toBeUndefined();
    }
  });

  const pendingCases = cases.map((entry) => {
    // Closing narration completes the reply's sentence; held names flush there.
    // Across a seal the closing delta starts its own segment, leading space kept.
    const closingEndsSameBlock = entry.to === "narration";
    const closedText = closingEndsSameBlock ? `${entry.expected.at(-1)!.text} Done.` : " Done.";
    const middle = closingEndsSameBlock
      ? []
      : [progressBlock(entry.to, entry.expected.at(-1)!.text)];
    const head = entry.from === entry.to ? [] : [progressBlock(entry.from, "Alpha")];
    const expected = [
      ...head,
      ...middle,
      { kind: "text" as const, text: closedText },
      { kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] },
    ];
    return { ...entry, expected };
  });

  it.each(pendingCases)(
    "$from -> $to $payload with a held tool name lands it as one step",
    (entry) => {
      const start = reduceLiveMessageBlocks([], {
        type: "progress",
        payload: categoryPayload(entry.from, "Alpha", false),
      });
      const held = reduceLiveMessageBlocks(start, { type: "tool", name: "shell" });
      // Mid-sentence text holds the name on the tail block.
      expect(held).toEqual([progressBlock(entry.from, "Alpha", ["shell"])]);

      const moved = reduceLiveMessageBlocks(held, {
        type: "progress",
        payload: categoryPayload(entry.to, entry.updateText, entry.delta),
      });
      const closed = reduceLiveMessageBlocks(moved, {
        type: "progress",
        payload: { delta: " Done.", streaming: true },
      });
      expect(closed).toEqual(entry.expected);

      // The name materialized exactly once, and nothing still holds it.
      const shells = closed
        .flatMap((block) => (block.kind === "steps" ? block.steps : []))
        .filter((step) => step.label === "Shell")
        .reduce((total, step) => total + step.count, 0);
      expect(shells).toBe(1);
      expect(
        closed.some((block) => "pendingToolNames" in block && block.pendingToolNames?.length),
      ).toBe(false);
    },
  );

  // A punctuated tail, then a tool call. Narration flushes into reply text and
  // a reasoning summary stays whole, both ahead of the step; only a generated
  // activity title is redundant once its step lands, so the step replaces it.
  // Held names sit on the tail until a same-category delta ends its sentence
  // ("held"), or ride across a category seal onto the punctuated tail
  // ("carried").
  const pendingKinds = ["none", "held", "carried"] as const;
  const sealedBy = (category: LiveCategory): LiveCategory =>
    category === "narration" ? "activity" : "narration";
  const toolCases = categories.flatMap((tail) =>
    pendingKinds.map((pending) => {
      const tailText = pending === "held" ? "Alpha beta." : "Alpha.";
      const kept =
        tail === "narration"
          ? [{ kind: "text" as const, text: tailText }]
          : tail === "reasoning"
            ? [progressBlock("reasoning", tailText)]
            : [];
      const head = pending === "carried" ? [progressBlock(sealedBy(tail), "Intro")] : [];
      const steps =
        pending === "none"
          ? [{ label: "Shell", count: 1 }]
          : [
              { label: "Read file", count: 1 },
              { label: "Shell", count: 1 },
            ];
      return { tail, pending, expected: [...head, ...kept, { kind: "steps" as const, steps }] };
    }),
  );

  it.each(toolCases)(
    "punctuated $tail tail then a tool call ($pending pending names) loses no block",
    (entry) => {
      const progress = (category: LiveCategory, text: string, delta: boolean) => ({
        type: "progress" as const,
        payload: categoryPayload(category, text, delta),
      });
      const updates: LiveMessageUpdate[] =
        entry.pending === "carried"
          ? [
              progress(sealedBy(entry.tail), "Intro", false),
              { type: "tool", name: "read_file" },
              progress(entry.tail, "Alpha.", false),
            ]
          : entry.pending === "held"
            ? [
                progress(entry.tail, "Alpha", false),
                { type: "tool", name: "read_file" },
                progress(entry.tail, " beta.", true),
              ]
            : [progress(entry.tail, "Alpha.", false)];
      const before = updates.reduce<MessageBlock[]>(reduceLiveMessageBlocks, []);
      const closed = reduceLiveMessageBlocks(before, { type: "tool", name: "shell" });
      expect(closed).toEqual(entry.expected);

      // The summary survives with its marker, every name became a step exactly
      // once, and nothing still holds a name.
      expect(closed.filter(isReasoningSummaryBlock)).toHaveLength(
        entry.tail === "reasoning" ? 1 : 0,
      );
      const counts: Record<string, number> = {};
      for (const block of closed) {
        if (block.kind !== "steps") continue;
        for (const step of block.steps) counts[step.label] = (counts[step.label] ?? 0) + step.count;
      }
      expect(counts).toEqual(
        entry.pending === "none" ? { Shell: 1 } : { "Read file": 1, Shell: 1 },
      );
      expect(
        closed.some((block) => "pendingToolNames" in block && block.pendingToolNames?.length),
      ).toBe(false);
    },
  );
});

describe("runFailureError", () => {
  it("returns the error only for run.failed with a real message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "provider missing" } })).toBe(
      "provider missing",
    );
    expect(runFailureError({ type: "run.failed", payload: {} })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: "   " } })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: 42 } })).toBeNull();
    expect(runFailureError({ type: "run.failed" })).toBeNull();
    expect(runFailureError({ type: "run.completed", payload: { error: "nope" } })).toBeNull();
    expect(runFailureError({ type: "run.cancelled", payload: { error: "nope" } })).toBeNull();
  });

  it("trims surrounding space and clamps a runaway message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "  spaced  " } })).toBe(
      "spaced",
    );
    const long = runFailureError({ type: "run.failed", payload: { error: "x".repeat(400) } });
    expect(long).toHaveLength(301);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("projectMessages", () => {
  it("replays durable messages and trailing live tokens from progress events", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "hi" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lis", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "bon", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "hi" });
    expect(messages[1]?.blocks[0]).toEqual({ kind: "progress", text: "Lisbon" });
  });

  it("drops streaming tokens once the completed message is durable", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lisbon", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: { messageId: "m2", role: "bot", blocks: [{ kind: "text", text: "Lisbon" }] },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "Lisbon" });
  });

  it("keeps live subagent cards until a durable subagent message arrives", () => {
    const live = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
          progress: "working…",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      name: "helper",
      status: "running",
    });

    const durable = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: {
          messageId: "m1",
          role: "bot",
          blocks: [
            {
              kind: "subagent",
              agentId: "a1",
              name: "helper",
              task: "summarize",
              status: "completed",
              result: "ok",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(durable).toHaveLength(1);
    expect(durable[0]?.blocks[0]).toMatchObject({ status: "completed", result: "ok" });
  });

  it("drops prior history when a later clear event is replayed", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "old" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "draft" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.cleared",
        payload: {},
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toEqual([]);
  });

  it("collapses repeated tool calls into one step with a count", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({
      kind: "steps",
      steps: [
        { label: "Slack fetch conversation history", count: 2 },
        { label: "Slack find channels", count: 1 },
      ],
    });
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check Slack ", streaming: true },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "for a broad search.", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    // The sentence only finishes once "for a broad search." streams in, so the completed
    // sentence and the held-back tool call appear together, in that order.
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack for a broad search." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("places a tool before response text when no narration preceded it", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "The check passed.", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(messages[0]?.blocks).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "progress", text: "The check passed." },
    ]);
  });

  it("keeps a tool call hidden while narration keeps streaming with no sentence end", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check what I have ", streaming: true },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "locally and try the GitHub API", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    // No sentence terminator has streamed in yet, so the "Shell" call stays hidden and
    // everything so far renders as one continuous progress tail.
    expect(messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check what I have locally and try the GitHub API",
        pendingToolNames: ["shell"],
      },
    ]);
  });

  it("keeps interleaved group runs and their tool calls isolated", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        botId: "bot-a",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Alpha " },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        botId: "bot-b",
        seq: 1,
        type: "thread.progress",
        runId: "r2",
        payload: { text: "Beta." },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        botId: "bot-a",
        seq: 2,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "e4",
        threadId: "t1",
        botId: "bot-b",
        seq: 3,
        type: "agent.tool.called",
        runId: "r2",
        payload: { name: "read_file" },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
      {
        id: "e5",
        threadId: "t1",
        botId: "bot-a",
        seq: 4,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "done." },
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        id: "progress:r1",
        botId: "bot-a",
        blocks: [
          { kind: "text", text: "Alpha done." },
          { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
        ],
      }),
      expect.objectContaining({
        id: "progress:r2",
        botId: "bot-b",
        blocks: [
          { kind: "text", text: "Beta." },
          { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        ],
      }),
    ]);
  });

  it("clears the live step trail once the run ends", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "run.cancelled",
        runId: "r1",
        payload: {},
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(messages).toHaveLength(0);
  });
});

describe("humanizeToolName", () => {
  it("turns a Composio-style constant into a readable label", () => {
    expect(humanizeToolName("SLACK_FIND_CHANNELS")).toBe("Slack find channels");
  });

  it("turns a lowercase builtin tool name into a readable label", () => {
    expect(humanizeToolName("request_takeover")).toBe("Request takeover");
  });
});

describe("appendToolStep", () => {
  it("starts a new step for the first call", () => {
    expect(appendToolStep([], "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 1 },
    ]);
  });

  it("increments the count when the same tool fires again in a row", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 2 },
    ]);
  });

  it("appends a new step when a different tool fires", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FETCH_CONVERSATION_HISTORY")).toEqual([
      { label: "Slack find channels", count: 1 },
      { label: "Slack fetch conversation history", count: 1 },
    ]);
  });
});

describe("trackToolCallStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(
      trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", { cursor: "a" }),
    ).toEqual({ key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}', count: 1 });
  });

  it("increments the count when the same tool and args repeat", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "a" })).toEqual({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}',
      count: 2,
    });
  });

  it("resets the streak when the same tool is called with different args", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "b" })).toEqual({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"b"}',
      count: 1,
    });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FETCH_CONVERSATION_HISTORY", { cursor: "a" })).toEqual(
      { key: 'SLACK_FETCH_CONVERSATION_HISTORY:{"cursor":"a"}', count: 1 },
    );
  });
});

describe("trackToolNameStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(trackToolNameStreak({ name: undefined, count: 0 }, "shell")).toEqual({
      name: "shell",
      count: 1,
    });
  });

  it("increments the count when the same tool name repeats, even with different arguments", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "shell")).toEqual({ name: "shell", count: 2 });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "recall_memory")).toEqual({
      name: "recall_memory",
      count: 1,
    });
  });
});

describe("endsSentence", () => {
  it("is false mid-clause, with no terminal punctuation", () => {
    expect(endsSentence("Let me check what I have loca")).toBe(false);
  });

  it("is false when the text trails off on whitespace with no punctuation", () => {
    expect(endsSentence("Let me check Slack ")).toBe(false);
  });

  it("is true once the text ends on a sentence terminator", () => {
    expect(endsSentence("Let me check. ")).toBe(true);
    expect(endsSentence("Is that right?")).toBe(true);
    expect(endsSentence('She said "stop!"')).toBe(true);
  });

  it("is true for an empty or whitespace-only string — nothing to protect", () => {
    expect(endsSentence("")).toBe(true);
    expect(endsSentence("   ")).toBe(true);
  });
});

describe("appendTextSegment", () => {
  it("starts a new text segment when there are none", () => {
    expect(appendTextSegment([], "hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("does nothing when the text is empty", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "")).toEqual(segments);
  });

  it("merges into the last segment when it is already text", () => {
    const segments = appendTextSegment([], "a");
    expect(appendTextSegment(segments, "b")).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("starts a new text segment after a steps segment", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "done")).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "text", text: "done" },
    ]);
  });
});

describe("appendToolCallSegment", () => {
  it("starts a new steps segment when there are none", () => {
    expect(appendToolCallSegment([], "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("collapses into the last steps segment for the same tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 2 }] },
    ]);
  });

  it("starts a new steps segment after a text segment", () => {
    const segments = [{ kind: "text" as const, text: "hi" }];
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      { kind: "text", text: "hi" },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("adds a new step entry within the same steps segment for a different tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Slack find channels", count: 1 },
          { label: "Shell", count: 1 },
        ],
      },
    ]);
  });
});

describe("createStreamingRedactor", () => {
  it("never emits a secret split across streaming chunks", () => {
    const redactor = createStreamingRedactor(["fake-secret-123"]);
    const output = [
      redactor.push("before fake-se"),
      redactor.push("cret-123 after"),
      redactor.finish(),
    ].join("");
    expect(output).toBe("before [redacted] after");
    expect(output).not.toContain("fake-secret-123");
  });

  it("redacts a six-character credential split across command output chunks", () => {
    const redactor = createStreamingRedactor(["ab12cd"]);
    const output = [
      redactor.push("prefix ab"),
      redactor.push("12cdsuffix"),
      redactor.finish(),
    ].join("");
    expect(output).toBe("prefix [redacted]suffix");
  });

  it("does not delay chunks when there are no known secrets", () => {
    const redactor = createStreamingRedactor([]);
    expect(redactor.push("hello")).toBe("hello");
    expect(redactor.finish()).toBe("");
  });

  it("buffers a trailing UTF-16 high surrogate until the next chunk completes the emoji", () => {
    const redactor = createStreamingRedactor([]);
    const high = "\uD83D";
    const low = "\uDE00";
    expect(redactor.push(`hello ${high}`)).toBe("hello ");
    expect(redactor.push(`${low} world`)).toBe("😀 world");
    expect(redactor.finish()).toBe("");
  });

  it("does not emit a high surrogate when the secret hold window would split an emoji pair", () => {
    const redactor = createStreamingRedactor(["abcdefghij"]); // length 10
    const high = "\uD83D";
    const low = "\uDE00";
    // safeStartLimit lands between high and low; the pair must stay buffered together.
    expect(redactor.push(`x${high}${low}abcdefgh`)).toBe("x");
    expect(redactor.push("ij done")).toBe("😀[redacted]");
    expect(redactor.finish()).toBe(" done");
  });

  it("replaces an orphaned high surrogate at end of stream", () => {
    const redactor = createStreamingRedactor([]);
    expect(redactor.push("end\uD83D")).toBe("end");
    expect(redactor.finish()).toBe("\uFFFD");
  });
});

describe("sanitizeUtf16ForJson", () => {
  it("keeps complete surrogate pairs and replaces unpaired surrogates", () => {
    expect(sanitizeUtf16ForJson("😀")).toBe("😀");
    expect(sanitizeUtf16ForJson("a\uD83D")).toBe("a\uFFFD");
    expect(sanitizeUtf16ForJson("\uDE00b")).toBe("\uFFFDb");
    expect(sanitizeJsonValue({ delta: "x\uD83D", nested: ["\uDE00"] })).toEqual({
      delta: "x\uFFFD",
      nested: ["\uFFFD"],
    });
  });

  it("sanitizes nested object keys and disambiguates collisions after replacement", () => {
    expect(
      sanitizeJsonValue({
        outer: {
          // biome-ignore lint/complexity/useLiteralKeys: keep computed keys so unpaired surrogates stay intentional fixtures
          ["meta\uD83D"]: "ok",
          // biome-ignore lint/complexity/useLiteralKeys: keep computed keys so unpaired surrogates stay intentional fixtures
          ["meta\uDE00"]: "also",
        },
      }),
    ).toEqual({
      outer: {
        "meta\uFFFD": "ok",
        "meta\uFFFD#2": "also",
      },
    });
  });
});
