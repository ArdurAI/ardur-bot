import type {
  ComputerStatus,
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
  ProductEvent,
  Run,
  ThreadMessage,
  ThreadSnapshot,
} from "@ardurbot/contracts";
import { RunTriggerSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  activeMemberRun,
  activeThreadRuns,
  applyThreadSendReceipt,
  clearActiveThreadRuns,
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerPanelNeedsMaintenance,
  computerTakeoverBlocked,
  isGroupMemberModelPinEvent,
  isThreadSnapshotEvent,
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
  threadRunError,
  userHoldsComputerControl,
} from "./thread-events.js";

describe("thread event reduction", () => {
  it("recognizes either member pin event for a group refresh", () => {
    expect(isGroupMemberModelPinEvent(event({ type: "group.memberModelPin.set" }))).toBe(true);
    expect(isGroupMemberModelPinEvent(event({ type: "group.memberModelPin.cleared" }))).toBe(true);
    expect(isGroupMemberModelPinEvent(event({ type: "run.started" }))).toBe(false);
  });
  it.each(["queued", "leased", "running", "waiting_input", "waiting_takeover"] as const)(
    "keeps the admitted member pin visible while %s",
    (status) => {
      const run = {
        ...threadRun("admitted", "member"),
        status,
        runtimePin: {
          runtimeKind: "pi" as const,
          provider: "fixture",
          modelId: "original",
          effort: "off",
          credentialId: "credential",
          revision: 1,
        },
      };
      expect(activeMemberRun([run], "member")).toBe(run);
      expect(activeMemberRun([run], "other")).toBeNull();
    },
  );
  it("prefers the admitted run over a newer queued run for the same member", () => {
    const admitted = {
      ...threadRun("running", "member"),
      status: "running" as const,
      runtimePin: {
        runtimeKind: "pi" as const,
        provider: "fixture",
        modelId: "original",
        effort: "off",
        credentialId: "credential",
        revision: 1,
      },
    };
    const queued = {
      ...threadRun("queued", "member"),
      status: "queued" as const,
      runtimePin: null,
    };
    expect(activeMemberRun([queued, admitted], "member")).toBe(admitted);
    expect(activeMemberRun([queued], "member")).toBe(queued);
    // A queued handoff already carries a pin; the waiting run still wins.
    const waiting = { ...admitted, id: "waiting", status: "waiting_input" as const };
    const queuedHandoff = {
      ...queued,
      id: "handoff",
      runtimePin: { ...admitted.runtimePin, modelId: "next", revision: 2 },
    };
    expect(activeMemberRun([queuedHandoff, waiting], "member")).toBe(waiting);
    expect(activeMemberRun([queuedHandoff, queued], "member")).toBe(queuedHandoff);
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "does not display a terminal %s pin as the current member choice",
    (status) => {
      const run = {
        ...threadRun("old", "member"),
        status,
        runtimePin: {
          runtimeKind: "pi" as const,
          provider: "fixture",
          modelId: "old",
          effort: "off",
          credentialId: "credential",
          revision: 1,
        },
      };
      expect(activeMemberRun([run], "member")).toBeNull();
    },
  );
  it("preserves a previous pin and accepts the admitted pin from a live start", () => {
    const originalPin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "original",
      effort: "high",
      credentialId: "connection",
      revision: 1,
    };
    const run = { ...threadRun("live", "member"), runtimePin: originalPin };
    const initial = { ...snapshot([]), groupId: "group", run, activeRuns: [run] };
    const started = reduceThreadSnapshot(
      initial,
      event({ type: "run.started", botId: "member", runId: "live" }),
    );
    expect(started?.activeRuns?.[0]?.runtimePin).toEqual(originalPin);

    const newPin = { ...originalPin, modelId: "admitted", revision: 2 };
    const admitted = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        botId: "member",
        runId: "new",
        payload: { runtimePin: newPin },
      }),
    );
    expect(admitted?.activeRuns?.find((item) => item.id === "new")?.runtimePin).toEqual(newPin);
    const unknown = reduceThreadSnapshot(
      { ...initial, run: null, activeRuns: [] },
      event({ type: "run.started", botId: "member", runId: "unknown" }),
    );
    expect(activeMemberRun(unknown?.activeRuns ?? [], "member")?.id).toBe("unknown");
  });
  it("admits live context through the subscription filter and updates the matching run", () => {
    const run = threadRun("run-1");
    const initial = { ...snapshot([]), run, activeRuns: [run, threadRun("peer")] };
    const payload = {
      layers: { stable: 100, brief: 20, summary: 0, messages: 10, recall: 0, message: 30 },
      recallRan: false,
      recallCalls: 0,
      cachedTokens: 0,
      inputTokens: 100,
      timeToFirstTokenMs: 12,
      queueWaitMs: 8,
      routingRule: "last-active-thread",
    };
    const update = event({ type: "run.context", seq: 4, runId: run.id, payload });
    const next = isThreadSnapshotEvent(update) ? reduceThreadSnapshot(initial, update) : initial;
    expect(next?.run).toMatchObject({ contextSnapshot: payload });
    expect(next?.activeRuns?.[1]).toBe(initial.activeRuns[1]);
    expect(next?.cursor).toBe(4);
  });
  it.each(RunTriggerSchema.options)(
    "preserves the shared trigger %s on live run events",
    (trigger) => {
      const next = reduceThreadSnapshot(
        snapshot([]),
        event({ type: "run.started", runId: "started", payload: { trigger } }),
      );
      expect(next?.run?.trigger).toBe(trigger);
    },
  );
  it("shows a committed direct send as queued before its snapshot refresh returns", () => {
    const initial = snapshot([message("user-1", [{ kind: "text", text: "Continue" }], 4)]);

    const next = applyThreadSendReceipt(initial, {
      botId: "bot-1",
      runId: "run-receipt",
      taskId: "task-receipt",
      createdAt: "2026-09-03T21:29:52.000Z",
    });

    expect(next?.run).toMatchObject({
      id: "run-receipt",
      taskId: "task-receipt",
      status: "queued",
    });
    expect(next?.activeRuns).toEqual([next?.run]);
    expect(next?.messages).toBe(initial.messages);
  });

  it("does not replace authoritative active or group run state with a send receipt", () => {
    const active = threadRun("run-active");
    const direct: ThreadSnapshot = { ...snapshot([]), run: active, activeRuns: [active] };
    const group: ThreadSnapshot = { ...snapshot([]), groupId: "group-1" };
    const receipt = { botId: "bot-1", runId: "run-new", taskId: "task-new" };
    const completed = { ...threadRun(receipt.runId), status: "completed" as const };

    expect(applyThreadSendReceipt(direct, receipt)).toBe(direct);
    expect(applyThreadSendReceipt(group, receipt)).toBe(group);
    expect(applyThreadSendReceipt({ ...snapshot([]), run: completed }, receipt)?.run).toBe(
      completed,
    );
    expect(applyThreadSendReceipt(snapshot([]), receipt, new Set([receipt.runId]))).toEqual(
      snapshot([]),
    );
  });

  it("appends an emoji reply with its exact target", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "reaction-1",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "message-1",
        },
      }),
    );

    expect(next?.messages.find((message) => message.id === "reaction-1")).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "❤️" }],
      replyToMessageId: "message-1",
    });
    expect(next?.cursor).toBe(4);
  });

  it("appends a quoted reply carrying its excerpt", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "reply-1",
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          replyToMessageId: "message-1",
          replyQuote: "Done",
        },
      }),
    );

    expect(next?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      role: "user",
      replyToMessageId: "message-1",
      replyQuote: "Done",
    });
  });

  it("prepends older pages in order, removes overlaps, and advances the history cursor", () => {
    const initial = snapshot([message("m-2", [], 2), message("m-3", [], 3)], 2);

    const next = prependThreadMessagePage(initial, {
      threadId: "thread-1",
      messages: [message("m-0", [], 0), message("m-1", [], 1), message("m-2", [], 2)],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("ignores a stale older page after the conversation was cleared", () => {
    const cleared = snapshot([], null);
    const next = prependThreadMessagePage(cleared, {
      threadId: "thread-1",
      messages: [message("old-1", [], 0), message("old-2", [], 1)],
      olderCursor: null,
    });
    expect(next).toBe(cleared);
  });

  it("merges a refreshed recent page with loaded history and drops stale live messages", () => {
    const previous = snapshot(
      [
        message("m-0", [], 0),
        message("m-1", [], 1),
        message("progress:run-1", [{ kind: "progress", text: "draft" }], 9),
      ],
      null,
    );
    const recent = snapshot([message("m-1", [], 1), message("m-2", [], 2)], 1);

    const next = mergeThreadSnapshot(previous, recent, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("ignores a stale thread refresh that is behind the live cursor", () => {
    const live: ThreadSnapshot = {
      ...snapshot([
        message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }], 11),
      ]),
      cursor: 12,
    };
    const stale: ThreadSnapshot = {
      ...snapshot([message("m-1", [{ kind: "text", text: "older" }], 1)]),
      cursor: 8,
    };

    expect(mergeThreadSnapshot(live, stale)).toBe(live);
    expect(mergeThreadSnapshot(live, stale, true)).toBe(live);
  });

  it("accumulates progress deltas and keeps only the active progress message", () => {
    const stale = message("progress:older", [{ kind: "progress", text: "old run" }]);
    const initial = snapshot([stale]);

    const first = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", seq: 4, runId: "run-1", payload: { delta: "Hel" } }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({ type: "thread.progress", seq: 5, runId: "run-1", payload: { delta: "lo" } }),
    );

    expect(second?.cursor).toBe(5);
    expect(second?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      }),
    ]);
  });

  it("updates a live subagent in place while preserving streamed answer progress", () => {
    const activeRun = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        message("subagent:research", [
          {
            kind: "subagent",
            agentId: "research",
            name: "Research",
            task: "Find sources",
            status: "running",
            progress: "Starting",
          },
        ]),
        {
          ...message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
          runId: activeRun.id,
        },
      ]),
      run: activeRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        seq: 8,
        payload: {
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "completed",
          result: "Three sources found",
        },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["subagent:research", "progress:run-1"]);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      status: "completed",
      result: "Three sources found",
    });
  });

  it("replaces a matching live subagent with the durable message and keeps the reply draft", () => {
    const initial = snapshot([
      message("durable", [{ kind: "text", text: "old value" }]),
      message("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "running",
        },
      ]),
      message("subagent:other", [
        {
          kind: "subagent",
          agentId: "other",
          name: "Other",
          task: "Keep working",
          status: "running",
        },
      ]),
      message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
    ]);
    const completedBlock = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Find sources",
      status: "completed" as const,
      result: "Done",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        id: "event-message",
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "durable", role: "bot", blocks: [completedBlock] },
      }),
    );

    // The card saves no reply text, so the run's draft keeps the place its text holds for
    // the reply still to come.
    expect(next?.messages.map((item) => item.id)).toEqual([
      "durable",
      "subagent:other",
      "progress:run-1",
    ]);
    expect(next?.messages[0]?.blocks).toEqual([completedBlock]);
  });

  it("keeps a replayed bot-to-bot marker in its durable transcript position", () => {
    const peerBlock = {
      kind: "bot_message_received" as const,
      fromBotId: "bot-peer",
      fromBotName: "Peer",
      text: "Please check this.",
    };
    const initial = snapshot([
      message("peer-message", [peerBlock], 1),
      message("newer-message", [{ kind: "text", text: "Working on it." }], 2),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "peer-message", role: "user", blocks: [peerBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["peer-message", "newer-message"]);
  });

  it("clears durable and transient history when another client clears the thread", () => {
    const initial = snapshot(
      [
        message("message-1", [{ kind: "text", text: "old" }]),
        message("progress:run-1", [{ kind: "progress", text: "draft" }]),
      ],
      1,
    );
    initial.run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.cleared", seq: 12, runId: undefined }),
    );

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("routes clear and terminal events through the snapshot reducer", () => {
    expect(
      isThreadSnapshotEvent(event({ type: "thread.cleared", seq: 12, runId: undefined })),
    ).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.started" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.completed" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "computer.takeover.requested" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "agent.tool.completed" }))).toBe(true);
  });

  it("event-sources the active run on run.started so Stop does not wait on threads.get", () => {
    const initial = snapshot([]);
    const started = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 3,
        runId: "run-1",
        payload: { trigger: "user" },
      }),
    );

    expect(started?.run).toMatchObject({
      id: "run-1",
      botId: "bot-1",
      status: "running",
      trigger: "user",
    });
    expect(started?.activeRuns).toEqual([started?.run]);

    const progressed = reduceThreadSnapshot(
      started,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { delta: "still working" },
      }),
    );
    expect(progressed?.run?.id).toBe("run-1");
    expect(progressed?.cursor).toBe(4);
  });

  it("preserves bot_message when event-sourcing a peer run", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "peer-run-1",
        payload: { trigger: "bot_message" },
      }),
    );

    expect(started?.run?.trigger).toBe("bot_message");
  });

  it("queues the run with its retry wake moment only while it waits for the model", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = { ...snapshot([]), run, activeRuns: [run] };
    const waiting = reduceThreadSnapshot(
      initial,
      event({
        type: "run.retry_scheduled",
        seq: 4,
        runId: "run-1",
        createdAt: "2026-08-16T00:00:10.000Z",
        payload: { providerErrorKind: "rate-limit", attempt: 1, waitMs: 2_000 },
      }),
    );

    expect(waiting?.run).toMatchObject({
      id: "run-1",
      status: "queued",
      providerRetryAt: "2026-08-16T00:00:12.000Z",
    });
    expect(waiting?.activeRuns?.[0]).toMatchObject({
      id: "run-1",
      status: "queued",
      providerRetryAt: "2026-08-16T00:00:12.000Z",
    });
    expect(isThreadSnapshotEvent(event({ type: "run.retry_scheduled" }))).toBe(true);

    // The retry's start clears the wait: the row reads as working again.
    const restarted = reduceThreadSnapshot(
      waiting,
      event({ type: "run.started", seq: 5, runId: "run-1", payload: { trigger: "user" } }),
    );
    expect(restarted?.run).toMatchObject({ id: "run-1", status: "running" });
    expect(restarted?.run?.providerRetryAt ?? null).toBeNull();
  });

  it("preserves webhook when event-sourcing an inbound wake", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "webhook-run-1",
        payload: { trigger: "webhook" },
      }),
    );

    expect(started?.run?.trigger).toBe("webhook");
  });

  it("marks the run as waiting when computer takeover is requested", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "computer.takeover.requested", seq: 5, runId: run.id }),
    );

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
  });

  it("inserts a peer takeover run that was absent from the open snapshot", () => {
    const userRun = threadRun("run-user");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: userRun,
      activeRuns: [userRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({
        type: "computer.takeover.requested",
        seq: 12,
        runId: "run-peer",
        botId: "bot-peer",
      }),
    );

    expect(waiting?.run).toMatchObject({
      id: "run-peer",
      botId: "bot-peer",
      status: "waiting_takeover",
      trigger: "bot_message",
    });
    expect(waiting?.activeRuns?.map((run) => ({ id: run.id, status: run.status }))).toEqual([
      { id: "run-user", status: "running" },
      { id: "run-peer", status: "waiting_takeover" },
    ]);
  });

  it("keeps event-sourced waiting_takeover when a stale refresh still shows the bot busy", () => {
    const run = threadRun("run-1");
    const waitingLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run: { ...run, status: "waiting_takeover" },
      activeRuns: [{ ...run, status: "waiting_takeover" }],
    };
    const staleRefresh: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      waitingLocal,
      staleRefresh,
      computer({ state: "running", busyBotName: null }),
    );

    expect(reconciled.snapshot.run?.status).toBe("waiting_takeover");
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(
      computerTakeoverBlocked(reconciled.computer, activeThreadRuns(reconciled.snapshot), "bot-1"),
    ).toBe(false);
  });

  it("ignores a refresh whose cursor is behind the event-sourced snapshot", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 12,
      run: { ...run, status: "waiting_takeover" },
    };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ busyBotName: "Chief" }),
    };
    const prevComputer = computer({ busyBotName: null });

    const reconciled = reconcileRefreshedThread(newer, older, prevComputer);

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer).toBe(prevComputer);
  });

  it("refreshes busy status when only transient thread events are ahead", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = { ...snapshot([]), cursor: 12, run };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      newer,
      older,
      computer({ state: "running", controlHolder: "bot", busyBotName: null }),
    );

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("hydrates a live run from a refresh without rolling back newer progress", () => {
    const run = threadRun("run-1");
    const liveProgress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const newer: ThreadSnapshot = { ...snapshot([liveProgress]), cursor: 12, run: null };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 11,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(newer, older, computer());

    expect(reconciled.snapshot.cursor).toBe(12);
    expect(reconciled.snapshot.messages).toEqual([liveProgress]);
    expect(reconciled.snapshot.run).toBe(run);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("clears active runs and their transient progress after stop", () => {
    const run = threadRun("run-1");
    const durable = message("message-1", [{ kind: "text", text: "Keep me" }]);
    const progress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const stopped = clearActiveThreadRuns({
      ...snapshot([durable, progress]),
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    });

    expect(stopped.run).toBeNull();
    expect(stopped.activeRuns).toEqual([]);
    expect(stopped.messages).toEqual([durable]);
    expect(stopped.computer?.busyBotName).toBeNull();
  });

  it("keeps two room bots' drafts independent and stops every run together", () => {
    const room: ThreadSnapshot = {
      ...snapshot([]),
      groupId: "group-1",
      members: [
        { botId: "bot-a", name: "Ada", color: "#111" },
        { botId: "bot-b", name: "Beck", color: "#222" },
      ],
    };
    const started = [
      event({ type: "run.started", seq: 4, runId: "run-a", botId: "bot-a" }),
      event({ type: "run.started", seq: 5, runId: "run-b", botId: "bot-b" }),
    ].reduce<ThreadSnapshot | null>((current, e) => reduceThreadSnapshot(current, e), room);
    expect(started?.activeRuns?.map((run) => run.id).sort()).toEqual(["run-a", "run-b"]);

    const streaming = [
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-a",
        botId: "bot-a",
        payload: { delta: "Ada says hel" },
      }),
      event({
        type: "thread.progress",
        seq: 7,
        runId: "run-b",
        botId: "bot-b",
        payload: { delta: "Beck says hi" },
      }),
      event({
        type: "thread.progress",
        seq: 8,
        runId: "run-a",
        botId: "bot-a",
        payload: { delta: "lo" },
      }),
    ].reduce<ThreadSnapshot | null>((current, e) => reduceThreadSnapshot(current, e), started);
    const draftA = streaming?.messages.find((message) => message.id === "progress:run-a");
    const draftB = streaming?.messages.find((message) => message.id === "progress:run-b");
    // Each draft accumulates only its own run's deltas.
    expect(draftA?.blocks).toEqual([{ kind: "progress", text: "Ada says hello" }]);
    expect(draftB?.blocks).toEqual([{ kind: "progress", text: "Beck says hi" }]);
    expect(draftA?.botId).toBe("bot-a");
    expect(draftB?.botId).toBe("bot-b");

    // One run finishing drops only its own draft.
    const oneDone = reduceThreadSnapshot(
      streaming,
      event({ type: "run.completed", seq: 9, runId: "run-a", botId: "bot-a" }),
    );
    expect(oneDone?.messages.some((message) => message.id === "progress:run-a")).toBe(false);
    expect(oneDone?.messages.some((message) => message.id === "progress:run-b")).toBe(true);
    expect(oneDone?.activeRuns?.map((run) => run.id)).toEqual(["run-b"]);

    // Stop clears every active run and every remaining draft at once.
    const stopped = clearActiveThreadRuns(oneDone!);
    expect(stopped.activeRuns).toEqual([]);
    expect(stopped.run).toBeNull();
    expect(stopped.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
  });

  it("keeps an optimistic stop clear when an older cursor refresh still looks busy", () => {
    // Stop has no terminal event, so progress can leave the local cursor ahead of threads.get.
    // After the shell clears run/busy locally, that older get must not restore Stop / Take control block.
    const run = threadRun("run-1");
    const stoppedLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 15,
      run: null,
      activeRuns: [],
      computer: computer({ state: "running", busyBotName: null }),
    };
    const staleBusyRefresh: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };
    const clearedComputer = computer({ state: "running", busyBotName: null });

    const reconciled = reconcileRefreshedThread(stoppedLocal, staleBusyRefresh, clearedComputer);

    expect(reconciled.snapshot.run).toBeNull();
    expect(reconciled.snapshot.activeRuns).toEqual([]);
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(
      computerTakeoverBlocked(reconciled.computer, activeThreadRuns(reconciled.snapshot), "bot-1"),
    ).toBe(false);
  });

  it("always replaces the snapshot when switching to a different thread", () => {
    const previous: ThreadSnapshot = {
      ...snapshot([]),
      threadId: "thread-writer",
      cursor: 40,
      computer: computer({ mode: "team", busyBotName: null }),
    };
    const next: ThreadSnapshot = {
      ...snapshot([]),
      botId: "bot-private",
      threadId: "thread-private",
      cursor: 0,
      computer: computer({ mode: "dedicated", state: "running" }),
    };

    const reconciled = reconcileRefreshedThread(previous, next, previous.computer ?? null);

    expect(reconciled.snapshot.threadId).toBe("thread-private");
    expect(reconciled.computer?.mode).toBe("dedicated");
  });

  it("keeps group member status in sync with run lifecycle events", () => {
    const run = threadRun("run-1", "bot-member");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      botId: undefined,
      groupId: "group-1",
      members: [{ botId: "bot-member", name: "Member", color: "#8B5CF6", status: "idle" }],
    };

    const started = reduceThreadSnapshot(
      initial,
      event({ type: "run.started", botId: "bot-member", runId: run.id }),
    );
    expect(started?.members?.[0]?.status).toBe("running");
    expect(started?.run?.id).toBe(run.id);
    expect(started?.run?.status).toBe("running");
    expect(started?.activeRuns?.map((item) => item.id)).toEqual([run.id]);

    const waiting = reduceThreadSnapshot(
      started!,
      event({
        type: "run.waiting_input",
        seq: 5,
        botId: "bot-member",
        runId: run.id,
      }),
    );
    expect(waiting?.members?.[0]?.status).toBe("waiting_input");

    const completed = reduceThreadSnapshot(
      waiting,
      event({ type: "run.completed", seq: 6, botId: "bot-member", runId: run.id }),
    );
    expect(completed?.members?.[0]?.status).toBe("idle");
  });

  it("clears only the terminal run's live progress", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...message("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };
    const failed = event({ type: "run.failed", seq: 10, runId: runA.id });

    const next = reduceThreadSnapshot(initial, failed);

    expect(isThreadSnapshotEvent(failed)).toBe(true);
    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("keeps a failed run and its error so the thread can surface the failure", () => {
    const failing = threadRun("run-a");
    const initial: ThreadSnapshot = {
      ...snapshot([
        { ...message("progress:run-a", [{ kind: "progress", text: "A" }]), runId: failing.id },
      ]),
      run: failing,
    };
    const failed = event({
      type: "run.failed",
      seq: 11,
      runId: failing.id,
      payload: {
        error: "Provider is not configured: openrouter",
        providerErrorKind: "auth",
        runtimeProblem: {
          kind: "problem",
          code: "pin-credential-missing",
          pin: {
            provider: "openrouter",
            modelId: "model",
            effort: "high",
            credentialId: "deleted",
            revision: 1,
          },
          reason: "Missing connection",
          actions: ["connect", "change-pin"],
        },
      },
    });

    const next = reduceThreadSnapshot(initial, failed);

    expect(next?.messages).toEqual([]);
    expect(next?.run).toMatchObject({
      id: failing.id,
      status: "failed",
      error: "Provider is not configured: openrouter",
      providerErrorKind: "auth",
    });
    expect(next?.run?.runtimeProblem).toMatchObject({
      code: "pin-credential-missing",
      pin: { credentialId: "deleted", effort: "high" },
    });
    expect(threadRunError(next)).toBe("Provider is not configured: openrouter");
    expect(threadRunError(next, new Set([failing.id]))).toBeNull();
    expect(threadRunError(next, new Set(["other-run"]))).toBe(
      "Provider is not configured: openrouter",
    );
  });

  it("keeps the error when a member run fails while another member is still running", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.failed",
        seq: 13,
        botId: "bot-b",
        runId: runB.id,
        payload: { error: "member exploded" },
      }),
    );

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toMatchObject({ id: runB.id, status: "failed", error: "member exploded" });
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("keeps a group failure visible when another member starts before dismiss", () => {
    const failed = {
      ...threadRun("run-b", "bot-b"),
      status: "failed" as const,
      error: "member exploded",
    };
    const runA = threadRun("run-a", "bot-a");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      groupId: "group-1",
      run: failed,
      activeRuns: [runA],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 14,
        botId: "bot-c",
        runId: "run-c",
      }),
    );

    expect(next?.run).toMatchObject({ id: failed.id, status: "failed", error: "member exploded" });
    expect(next?.activeRuns).toEqual([
      runA,
      expect.objectContaining({ id: "run-c", botId: "bot-c", status: "running" }),
    ]);
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("clears the run and reports no error when it completes or fails without a message", () => {
    const finishing = threadRun("run-a");
    const initial: ThreadSnapshot = { ...snapshot([]), run: finishing };

    const completed = reduceThreadSnapshot(
      initial,
      event({ type: "run.completed", seq: 12, runId: finishing.id }),
    );
    const blank = reduceThreadSnapshot(
      initial,
      event({ type: "run.failed", seq: 12, runId: finishing.id, payload: { error: "  " } }),
    );

    expect(completed?.run).toBeNull();
    expect(threadRunError(completed)).toBeNull();
    expect(blank?.run).toBeNull();
    expect(threadRunError(blank)).toBeNull();
  });

  it("applies the durable waiting-input run transition without a refresh", () => {
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-1",
        status: "running",
        trigger: "user",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-1" }),
    );

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(6);
    expect(
      reduceThreadSnapshot(waiting, event({ type: "run.waiting_input", seq: 7, runId: "run-1" })),
    ).toBe(waiting);
  });

  it("clears live progress when a run waits for input", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-1", [{ kind: "progress", text: "working…" }]),
          runId: run.id,
        },
      ]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: run.id }),
    );

    expect(waiting?.messages).toEqual([]);
    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_input");
  });

  it("accumulates tool-call steps and collapses repeats into a count", () => {
    const initial = snapshot([]);

    const first = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.called",
        seq: 4,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );
    const third = reduceThreadSnapshot(
      second,
      event({
        type: "agent.tool.called",
        seq: 6,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );

    expect(third?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Slack find channels", count: 1 },
              { label: "Slack fetch conversation history", count: 2 },
            ],
          },
        ],
      }),
    ]);
  });

  it("advances past tool completion audit events without adding a visible message", () => {
    const initial = snapshot(
      [
        message(
          "progress:run-1",
          [{ kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] }],
          4,
        ),
      ],
      4,
    );
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.completed",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS", outcome: "succeeded" },
      }),
    );

    expect(next?.cursor).toBe(5);
    expect(next?.messages).toEqual(initial.messages);
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );

    // Still mid-sentence — the tool call stays hidden, folded into the streaming text instead.
    expect(afterTool?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack ",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);

    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "for a broad search.", streaming: true },
      }),
    );

    // The sentence just finished — the completed sentence and the held-back tool call appear
    // together, in that order.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Slack for a broad search." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("survives a React StrictMode replay of the same event without double-counting", () => {
    // StrictMode invokes a setState updater twice per event in development to catch impure
    // updaters — reduceThreadSnapshot(prev, event) must return the same result both times
    // rather than mutating its pending-tool-call bookkeeping a second time.
    const initial = snapshot([]);
    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check ", streaming: true },
      }),
    );
    const toolEvent = event({
      type: "agent.tool.called",
      seq: 5,
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });

    // The tool call lands mid-sentence, so it's held back rather than flushed immediately —
    // exactly the state a naive module-level mutation would double-push on replay.
    const first = reduceThreadSnapshot(afterNarration, toolEvent);
    const replay = reduceThreadSnapshot(afterNarration, toolEvent);
    expect(replay).toEqual(first);

    const sentenceEnd = reduceThreadSnapshot(
      first,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Done.", streaming: true },
      }),
    );

    // A single tool call, not two — StrictMode's replay must not have pushed it twice.
    expect(sentenceEnd?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Done." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("keeps deferring a tool call across several sentence-less deltas", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Found it, now sanding", streaming: true },
      }),
    );

    // No sentence terminator has streamed in yet, so the tool call is still hidden and
    // everything so far renders as one continuous progress block, still streaming.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack Found it, now sanding",
            streaming: true,
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);
  });

  it("restores pending tool calls from a refreshed snapshot", () => {
    const refreshed = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Let me check Slack ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      refreshed,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "now.", streaming: true },
      }),
    );

    expect(next?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("does not leak pending tool calls after clearing a thread", () => {
    const withPending = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Old unfinished narration ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);
    const cleared = reduceThreadSnapshot(
      withPending,
      event({ type: "thread.cleared", seq: 7, runId: undefined }),
    );
    const next = reduceThreadSnapshot(
      cleared,
      event({ type: "thread.progress", seq: 8, runId: "run-1", payload: { text: "Fresh." } }),
    );

    expect(next?.messages[0]?.blocks).toEqual([{ kind: "progress", text: "Fresh." }]);
  });

  it("preserves another active group run while updating live progress", () => {
    const runA = {
      id: "run-a",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const otherLive = {
      ...message("progress:run-b", [{ kind: "progress" as const, text: "Other bot" }]),
      botId: "bot-b",
      runId: "run-b",
    };
    // The snapshot can lag behind the event stream when another group run starts.
    const initial = { ...snapshot([otherLive]), activeRuns: [runA] };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 8,
        runId: "run-a",
        botId: "bot-a",
        payload: { text: "Current bot" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b", "progress:run-a"]);
    expect(next?.messages.map((item) => item.botId)).toEqual(["bot-b", "bot-a"]);
  });

  it("preserves live progress from a legacy run-only snapshot", () => {
    const legacyRun = threadRun("run-legacy", "bot-legacy");
    const legacyLive = {
      ...message("progress:run-legacy", [{ kind: "progress" as const, text: "Still working" }]),
      botId: legacyRun.botId,
      runId: legacyRun.id,
    };
    const initial: ThreadSnapshot = {
      ...snapshot([legacyLive]),
      run: legacyRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", runId: "run-new", payload: { text: "New work" } }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress while applying a subagent update", () => {
    const activeRun = threadRun("run-active");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-active", [{ kind: "progress", text: "Active" }]),
          runId: "run-active",
        },
        {
          ...message("progress:run-concurrent", [{ kind: "progress", text: "Concurrent" }]),
          runId: "run-concurrent",
        },
      ]),
      run: activeRun,
      activeRuns: [activeRun],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        runId: "run-active",
        payload: { agentId: "research", name: "Research", task: "Check", status: "running" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "subagent:research",
      "progress:run-active",
      "progress:run-concurrent",
    ]);
  });

  it("clears the step trail once the durable answer arrives", () => {
    const initial = snapshot([
      message("progress:run-1", [
        { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "final", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["final"]);
  });

  it("keeps a streamed reply above the follow-up the owner sent before the run ended", () => {
    const initial = snapshot([message("m-0", [{ kind: "text", text: "earlier" }], 0)]);
    const streamed = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 1,
        runId: "run-1",
        payload: { text: "Chief's summary", streaming: true },
      }),
    );
    expect(streamed?.messages.map((item) => item.id)).toEqual(["m-0", "progress:run-1"]);

    // The owner sends a follow-up while the run is still active; the draft keeps its place.
    const withQuestion = reduceThreadSnapshot(
      streamed!,
      event({
        type: "thread.message.created",
        seq: 2,
        runId: "run-1",
        payload: {
          messageId: "q-1",
          role: "user",
          blocks: [{ kind: "text", text: "any pending PRs left?" }],
        },
      }),
    );
    expect(withQuestion?.messages.map((item) => item.id)).toEqual(["m-0", "progress:run-1", "q-1"]);

    // When the run ends, the saved reply fills the draft's slot, above the follow-up.
    const finished = reduceThreadSnapshot(
      withQuestion!,
      event({
        type: "thread.message.created",
        seq: 3,
        runId: "run-1",
        payload: {
          messageId: "reply-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Chief's summary" }],
        },
      }),
    );
    expect(finished?.messages.map((item) => item.id)).toEqual(["m-0", "reply-1", "q-1"]);
  });

  it("keeps a streaming draft in its place through every later update", () => {
    const initial = snapshot([message("m-0", [{ kind: "text", text: "earlier" }], 0)]);
    const updates = [
      event({
        type: "thread.progress",
        seq: 1,
        payload: { text: "Chief's summary", streaming: true },
      }),
      event({
        type: "thread.message.created",
        seq: 2,
        payload: {
          messageId: "q-1",
          role: "user",
          blocks: [{ kind: "text", text: "any pending PRs left?" }],
        },
      }),
      // The owner's follow-up lands under the draft; nothing after it moves the draft.
      event({
        type: "thread.progress",
        seq: 3,
        payload: { delta: " continues.", streaming: true },
      }),
      event({ type: "agent.tool.called", seq: 4, payload: { name: "run_command" } }),
      event({
        type: "thread.progress",
        seq: 5,
        payload: { text: "Running gh pr list", activity: true },
      }),
      event({
        type: "thread.subagent",
        seq: 6,
        payload: { agentId: "research", name: "Research", task: "Check", status: "running" },
      }),
    ];
    let state: ThreadSnapshot | null = initial;
    for (const update of updates.slice(0, 2)) state = reduceThreadSnapshot(state, update);
    for (const update of updates.slice(2)) {
      state = reduceThreadSnapshot(state, update);
      expect(state?.messages.slice(0, 3).map((item) => item.id)).toEqual([
        "m-0",
        "progress:run-1",
        "q-1",
      ]);
    }
    expect(state?.messages.map((item) => item.id)).toEqual([
      "m-0",
      "progress:run-1",
      "q-1",
      "subagent:research",
    ]);

    // The saved reply fills the draft's place, above the follow-up, as a reload shows it.
    const saved = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 7,
        payload: {
          messageId: "reply-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Chief's summary continues." }],
        },
      }),
    );
    expect(saved?.messages.map((item) => item.id)).toEqual([
      "m-0",
      "reply-1",
      "q-1",
      "subagent:research",
    ]);
  });

  it("gives a draft its place only once its reply text streams", () => {
    const initial = snapshot([message("m-0", [{ kind: "text", text: "earlier" }], 0)]);
    // A tool call starts before any reply text: the draft has no place of its own yet.
    const working = reduceThreadSnapshot(
      initial,
      event({ type: "agent.tool.called", seq: 1, payload: { name: "run_command" } }),
    );
    const withQuestion = reduceThreadSnapshot(
      working,
      event({
        type: "thread.message.created",
        seq: 2,
        payload: {
          messageId: "q-1",
          role: "user",
          blocks: [{ kind: "text", text: "use weekly buckets" }],
        },
      }),
    );
    // Its text streams after the follow-up, so that is where the reply's place is held.
    const streamed = reduceThreadSnapshot(
      withQuestion,
      event({
        type: "thread.progress",
        seq: 3,
        payload: { text: "Here are the weekly numbers.", streaming: true },
      }),
    );
    expect(streamed?.messages.map((item) => item.id)).toEqual(["m-0", "q-1", "progress:run-1"]);
    const saved = reduceThreadSnapshot(
      streamed,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "reply-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Here are the weekly numbers." }],
        },
      }),
    );
    expect(saved?.messages.map((item) => item.id)).toEqual(["m-0", "q-1", "reply-1"]);
  });

  it("puts a card the run posts after the owner's message below that message", () => {
    const chart = { kind: "chart", name: "Weekly", spec: {}, data: [] };
    const updates = [
      event({
        type: "thread.progress",
        seq: 1,
        payload: { text: "Let me chart it.", streaming: true },
      }),
      // The narration is saved before the tool starts, leaving a steps-only draft.
      event({
        type: "thread.message.created",
        seq: 2,
        payload: {
          messageId: "narration-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Let me chart it." }],
        },
      }),
      event({ type: "agent.tool.called", seq: 3, payload: { name: "render_plot" } }),
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "q-1",
          role: "user",
          blocks: [{ kind: "text", text: "use weekly buckets" }],
        },
      }),
      event({
        type: "thread.message.created",
        seq: 5,
        payload: { messageId: "chart-1", role: "bot", blocks: [chart] },
      }),
    ];
    let state: ThreadSnapshot | null = snapshot([
      message("m-0", [{ kind: "text", text: "earlier" }], 0),
    ]);
    for (const update of updates) state = reduceThreadSnapshot(state, update);
    const durable = (messages: readonly ThreadMessage[] | undefined) =>
      messages?.filter((item) => !item.id.startsWith("progress:")).map((item) => item.id);
    expect(durable(state?.messages)).toEqual(["m-0", "narration-1", "q-1", "chart-1"]);

    // The final reply streams after the card and is saved below it.
    state = reduceThreadSnapshot(
      state,
      event({ type: "thread.progress", seq: 6, payload: { text: "Done.", streaming: true } }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 7,
        payload: { messageId: "reply-1", role: "bot", blocks: [{ kind: "text", text: "Done." }] },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual([
      "m-0",
      "narration-1",
      "q-1",
      "chart-1",
      "reply-1",
    ]);
  });

  it("keeps the reply's place when the run posts a card while its text streams", () => {
    const chart = { kind: "chart", name: "Weekly", spec: {}, data: [] };
    let state = reduceThreadSnapshot(
      snapshot([message("m-0", [{ kind: "text", text: "earlier" }], 0)]),
      event({
        type: "thread.progress",
        seq: 1,
        payload: { text: "Weekly numbers", streaming: true },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 2,
        payload: { messageId: "chart-1", role: "bot", blocks: [chart] },
      }),
    );
    // The card saves no reply text: it lands after the newest message, and the draft keeps
    // the place its text holds.
    expect(state?.messages.map((item) => item.id)).toEqual(["m-0", "progress:run-1", "chart-1"]);
    expect(state?.messages[1]?.blocks).toEqual([
      { kind: "progress", text: "Weekly numbers", streaming: true },
    ]);
    state = reduceThreadSnapshot(
      state,
      event({ type: "thread.progress", seq: 3, payload: { delta: " are up.", streaming: true } }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "reply-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Weekly numbers are up." }],
        },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual(["m-0", "reply-1", "chart-1"]);
  });

  it("keeps the streamed reply above the follow-up when tool activity arrives before the narration is saved", () => {
    // Pi posts the activity line, then the executor saves the narration, then the tool call.
    let state = reduceThreadSnapshot(
      snapshot([message("m-0", [{ kind: "text", text: "earlier" }], 0)]),
      event({
        type: "thread.progress",
        seq: 1,
        payload: { text: "Chief's summary", streaming: true },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 2,
        payload: {
          messageId: "q-1",
          role: "user",
          blocks: [{ kind: "text", text: "any pending PRs left?" }],
        },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.progress",
        seq: 3,
        payload: { text: "Running gh pr list", activity: true },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual(["m-0", "progress:run-1", "q-1"]);
    expect(state?.messages[1]?.blocks).toEqual([
      { kind: "text", text: "Chief's summary" },
      { kind: "progress", text: "Running gh pr list", activity: true },
    ]);
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "narr-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Chief's summary" }],
        },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({ type: "agent.tool.called", seq: 5, payload: { name: "shell" } }),
    );
    // The narration filled the draft's place. The tool call after that is a new
    // activity draft at the end, and it does not move the saved reply.
    expect(state?.messages.map((item) => item.id)).toEqual([
      "m-0",
      "narr-1",
      "q-1",
      "progress:run-1",
    ]);
    expect(state?.messages.at(-1)?.blocks).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("keeps each bot's narration in the place it streamed when another bot is also replying", () => {
    const user = {
      ...message("q-0", [{ kind: "text", text: "status please" }], 0),
      role: "user" as const,
    };
    let state = reduceThreadSnapshot(
      snapshot([user]),
      event({
        type: "thread.progress",
        seq: 1,
        runId: "run-a",
        botId: "bot-a",
        payload: { text: "Alpha answer", streaming: true },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.progress",
        seq: 2,
        runId: "run-b",
        botId: "bot-b",
        payload: { text: "Beta answer", streaming: true },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.progress",
        seq: 3,
        runId: "run-a",
        botId: "bot-a",
        payload: { text: "Running gh pr list", activity: true },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual([
      "q-0",
      "progress:run-a",
      "progress:run-b",
    ]);
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 4,
        runId: "run-a",
        botId: "bot-a",
        payload: {
          messageId: "a-narr",
          role: "bot",
          blocks: [{ kind: "text", text: "Alpha answer" }],
        },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 5,
        runId: "run-b",
        botId: "bot-b",
        payload: {
          messageId: "b-reply",
          role: "bot",
          blocks: [{ kind: "text", text: "Beta answer" }],
        },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual(["q-0", "a-narr", "b-reply"]);
  });

  it("keeps a routine summary above the card when activity arrives before the narration is saved", () => {
    const chart = { kind: "chart" as const, name: "Weekly", spec: {}, data: [] };
    let state = reduceThreadSnapshot(
      snapshot([message("m-0", [{ kind: "text", text: "earlier" }], 0)]),
      event({
        type: "thread.progress",
        seq: 1,
        payload: { text: "Let me chart it.", streaming: true },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.progress",
        seq: 2,
        payload: { text: "Rendering a chart", activity: true },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 3,
        payload: { messageId: "chart-1", role: "bot", blocks: [chart] },
      }),
    );
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.progress",
        seq: 4,
        payload: { text: "Weekly numbers.", streaming: true },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual(["m-0", "progress:run-1", "chart-1"]);
    expect(state?.messages[1]?.blocks).toEqual([
      { kind: "progress", text: "Weekly numbers.", streaming: true },
    ]);
    state = reduceThreadSnapshot(
      state,
      event({
        type: "thread.message.created",
        seq: 5,
        payload: {
          messageId: "summary-1",
          role: "bot",
          blocks: [{ kind: "text", text: "Weekly numbers." }],
        },
      }),
    );
    expect(state?.messages.map((item) => item.id)).toEqual(["m-0", "summary-1", "chart-1"]);
  });

  it("marks the live reply as streaming only while its text is growing", () => {
    const initial = snapshot([]);
    const growing = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 1,
        runId: "run-1",
        payload: { text: "Chief's summary", streaming: true },
      }),
    );
    expect(growing?.messages.at(-1)?.blocks.at(-1)).toMatchObject({
      kind: "progress",
      streaming: true,
    });

    // The text stops and the bot moves on to a command; the cursor must go away.
    const working = reduceThreadSnapshot(
      growing!,
      event({
        type: "agent.tool.called",
        seq: 2,
        runId: "run-1",
        payload: { name: "run_command" },
      }),
    );
    const tail = working?.messages.at(-1)?.blocks.at(-1);
    expect(tail).toMatchObject({ kind: "progress" });
    expect(tail).not.toHaveProperty("streaming");

    // Text growing again brings the cursor back. A delta without a sentence end keeps
    // the draft as one progress block, still streaming.
    const resumed = reduceThreadSnapshot(
      working!,
      event({
        type: "thread.progress",
        seq: 3,
        runId: "run-1",
        payload: { delta: " and more", streaming: true },
      }),
    );
    expect(resumed?.messages.at(-1)?.blocks.at(-1)).toMatchObject({
      kind: "progress",
      streaming: true,
    });

    // The run ends; no live draft remains.
    const done = reduceThreadSnapshot(
      resumed!,
      event({ type: "run.completed", seq: 4, runId: "run-1", payload: {} }),
    );
    expect(done?.messages).toEqual([]);
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const newerRun = {
      id: "run-newer",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const waitingRun = { ...newerRun, id: "run-waiting", botId: "bot-b", taskId: "task-b" };
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: newerRun,
      activeRuns: [newerRun, waitingRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-waiting" }),
    );

    expect(waiting?.run).toEqual(newerRun);
    expect(waiting?.activeRuns?.find((run) => run.id === "run-waiting")?.status).toBe(
      "waiting_input",
    );
    expect(activeThreadRuns(waiting)).toEqual([
      newerRun,
      expect.objectContaining({ id: "run-waiting", status: "waiting_input" }),
    ]);
    expect(activeThreadRuns({ ...initial, activeRuns: undefined })).toEqual([newerRun]);
  });

  it("replaces an ask message when its durable prompt state changes", () => {
    const initial = snapshot([
      message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }]),
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 7,
        payload: {
          messageId: "ask-1",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "answered",
              answer: "Paris",
            },
          ],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ status: "answered", answer: "Paris" });
  });

  it("replaces a coordination line in place when a member outcome lands", () => {
    const initial = snapshot([
      message("ask-1", [
        {
          kind: "coordination",
          nonce: "group-ask:1:run-1:call-1",
          round: 1,
          text: "Say hello.",
          updates: [],
          members: [
            { botId: "ada", name: "Ada", outcome: "pending" },
            { botId: "ben", name: "Ben", outcome: "pending" },
          ],
        },
      ]),
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 7,
        payload: {
          messageId: "ask-1",
          role: "bot",
          blocks: [
            {
              kind: "coordination",
              nonce: "group-ask:1:run-1:call-1",
              round: 1,
              text: "Say hello.",
              updates: [],
              members: [
                { botId: "ada", name: "Ada", outcome: "answered" },
                { botId: "ben", name: "Ben", outcome: "pending" },
              ],
            },
          ],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.id).toBe("ask-1");
    expect(next?.cursor).toBe(7);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({
      kind: "coordination",
      members: [
        { botId: "ada", outcome: "answered" },
        { botId: "ben", outcome: "pending" },
      ],
    });
  });

  it("preserves botId on durable bot messages", () => {
    const initial = snapshot([]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        botId: "bot-researcher",
        payload: {
          messageId: "msg-1",
          role: "bot",
          blocks: [{ kind: "text", text: "on it." }],
        },
      }),
    );

    expect(next?.messages[0]?.botId).toBe("bot-researcher");
  });
});

describe("computer event reduction", () => {
  it("applies valid lifecycle states without accepting unknown states", () => {
    const initial = computer();
    const running = reduceComputerStatus(
      initial,
      event({ type: "computer.status", payload: { status: "running" } }),
    );
    const unknown = reduceComputerStatus(
      running,
      event({ type: "computer.status", payload: { status: "destroyed" } }),
    );

    expect(running).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toBe(running);
  });

  it("grants user control without overwriting the lifecycle state", () => {
    const granted = reduceComputerStatus(
      computer({ state: "suspended", controlHolder: "bot" }),
      event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
    );
    expect(granted).toMatchObject({
      state: "suspended",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    expect(
      reduceComputerStatus(
        granted,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toBe(granted);
  });

  it("applies the authoritative holder when a takeover is released or expires", () => {
    const initial = computer({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    const expired = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "none", reason: "expired" },
      }),
    );
    const released = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "bot", reason: "released" },
      }),
    );
    expect(expired).toMatchObject({
      state: "running",
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
    });
    expect(released).toMatchObject({
      state: "running",
      controlHolder: "bot",
      controlBotId: null,
      takeoverRequested: false,
    });
  });

  it("fills in controlBotId when a grant arrives after controlHolder is already user", () => {
    const granted = reduceComputerStatus(
      computer({ state: "running", controlHolder: "user", controlBotId: null }),
      event({ type: "computer.takeover.granted", payload: {} }),
    );
    expect(granted).toMatchObject({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
    });
    expect(userHoldsComputerControl(granted, "bot-1")).toBe(true);
    expect(userHoldsComputerControl(granted, "bot-2")).toBe(false);
  });

  it("treats a busy bot name as a blocked takeover", () => {
    const busy = computer({ busyBotName: "Writer" });
    const runs = (status: Run["status"]) => [{ ...threadRun("run-1"), status }];
    expect(computerTakeoverBlocked(busy, runs("running"), "bot-1")).toBe(true);
    expect(computerTakeoverBlocked(busy, [], "bot-1")).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: null }), runs("running"), "bot-1")).toBe(
      false,
    );
    expect(computerTakeoverBlocked(null, runs("running"), "bot-1")).toBe(false);
    expect(computerTakeoverBlocked(busy, runs("waiting_takeover"), "bot-1")).toBe(false);
    expect(computerTakeoverBlocked(busy, runs("completed"), "bot-1")).toBe(false);
  });

  it("blocks a group member's takeover on that member's own run, not the headline run", () => {
    // The headline run is Writer's failed or waiting run while Chief still works on its computer.
    const chief = threadRun("run-chief", "bot-chief");
    const writer = threadRun("run-writer", "bot-writer");
    const busyChief = computer({ botId: "bot-chief", busyBotName: "Chief" });
    for (const headline of [
      { ...writer, status: "failed" as const },
      { ...writer, status: "waiting_takeover" as const },
    ]) {
      const group: ThreadSnapshot = {
        ...snapshot([]),
        botId: undefined,
        groupId: "group-1",
        run: headline,
        activeRuns: headline.status === "failed" ? [chief] : [headline, chief],
      };
      expect(computerTakeoverBlocked(busyChief, activeThreadRuns(group), "bot-chief")).toBe(true);
    }
  });

  it("ignores computer events that belong to a different bot", () => {
    const prev = computer({ takeoverRequested: false, controlHolder: "bot" });
    expect(
      reduceComputerStatus(
        prev,
        event({
          type: "computer.takeover.requested",
          botId: "bot-peer",
          payload: {},
        }),
      ),
    ).toBe(prev);
    expect(
      reduceComputerStatus(
        prev,
        event({
          type: "computer.status",
          botId: "bot-peer",
          payload: { status: "suspended" },
        }),
      ),
    ).toBe(prev);
  });

  it("updates one computer progress line and clears it after boot", () => {
    const initial = computer({ state: "booting" });
    const preparing = reduceComputerStatus(
      initial,
      event({
        type: "computer.status",
        payload: { status: "booting", imagePulling: true, imagePullPercent: null },
      }),
    );
    const downloading = reduceComputerStatus(
      preparing,
      event({
        type: "computer.status",
        payload: { status: "booting", imagePulling: true, imagePullPercent: 45 },
      }),
    );
    expect(downloading).toMatchObject({ imagePulling: true, imagePullPercent: 45 });
    expect(
      reduceComputerStatus(
        downloading,
        event({ type: "computer.status", payload: { status: "running" } }),
      ),
    ).toMatchObject({ imagePulling: false, state: "running" });
  });

  it("marks takeover requested and clears control unless the lease was retained", () => {
    const busy = computer({ state: "running", busyBotName: "Writer", controlHolder: "bot" });
    expect(
      reduceComputerStatus(busy, event({ type: "computer.takeover.requested", payload: {} })),
    ).toMatchObject({
      busyBotName: null,
      takeoverRequested: true,
      controlHolder: "none",
      controlBotId: null,
    });
    expect(
      reduceComputerStatus(
        computer({
          state: "running",
          controlHolder: "user",
          controlBotId: "bot-1",
          takeoverRequested: false,
        }),
        event({
          type: "computer.takeover.requested",
          payload: { retainedControl: true },
        }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
      busyBotName: null,
    });
    expect(
      reduceComputerStatus(
        busy,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      busyBotName: null,
      takeoverRequested: true,
    });
  });

  it("auto-boots stopped computers and recovers a running screen that has no URL", () => {
    expect(computerPanelAutoBoot("stopped")).toBe("boot");
    expect(computerPanelAutoBoot("error")).toBe("boot");
    expect(computerPanelAutoBoot(undefined)).toBe("boot");
    expect(computerPanelAutoBoot("running", "https://screen.example")).toBe("wait");
    expect(computerPanelAutoBoot("running", null)).toBe("recover-screen");
    expect(computerPanelAutoBoot("booting")).toBe("wait");
    expect(computerPanelAutoBoot("suspended")).toBe("wait");
  });

  it("maps recover-screen to computer.boot, not computer.recover", () => {
    expect(computerPanelAutoUsesBoot("recover-screen")).toBe(true);
    expect(computerPanelAutoUsesBoot("boot")).toBe(true);
    expect(computerPanelAutoUsesBoot("wait")).toBe(false);
  });

  it("shows maintenance for an errored computer or a stopped one whose boot failed", () => {
    expect(computerPanelNeedsMaintenance("error", false, false)).toBe(true);
    expect(computerPanelNeedsMaintenance("stopped", false, true)).toBe(true);
    expect(computerPanelNeedsMaintenance("stopped", false, false)).toBe(false);
    expect(computerPanelNeedsMaintenance("error", true, false)).toBe(false);
    expect(computerPanelNeedsMaintenance("running", false, true)).toBe(false);
    expect(computerPanelNeedsMaintenance(undefined, false, false)).toBe(false);
  });

  it("hides side-panel maintenance while the computer overlay is open", () => {
    const panel = "computer";
    const booting = false;
    const showInSidePanel = (computerOpen: boolean) =>
      panel === "computer" &&
      !computerOpen &&
      computerPanelNeedsMaintenance("error", booting, false);

    expect(showInSidePanel(false)).toBe(true);
    expect(showInSidePanel(true)).toBe(false);
  });
});

function snapshot(messages: ThreadMessage[], olderCursor: number | null = null): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: computer(),
  };
}

function threadRun(id: string, botId = "bot-1"): NonNullable<ThreadSnapshot["run"]> {
  return {
    id,
    botId,
    threadId: "thread-1",
    taskId: `task-${id}`,
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "booting",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: true,
    ...overrides,
  };
}

function message(id: string, blocks: ThreadMessage["blocks"], seq = 3): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role: "bot",
    blocks,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function event(overrides: Partial<ProductEvent>): ProductEvent {
  return {
    id: "event-1",
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 4,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

describe("web command projection", () => {
  it("projects command events into folded thread rows with idempotent delivery", () => {
    const event = commandEvent();
    expect(isThreadSnapshotEvent(event)).toBe(true);
    const next = reduceThreadSnapshot(snapshot([]), event);
    expect(next?.messages).toMatchSnapshot();
    expect(reduceThreadSnapshot(next, event)?.messages).toEqual(next?.messages);
  });
  it("keeps the recovering attempt's finish when a lease-lost attempt finishes late", () => {
    const first = { attemptId: "attempt-1", fence: 1 };
    const second = { attemptId: "attempt-2", fence: 2 };
    const running = { outcome: "running" as const, exitCode: null, durationMs: null };
    const finished = commandBlock(second);
    const events = [
      commandEvent("command.intent", { ...first, ...running, outcome: "waiting" }),
      commandEvent("command.started", { ...first, ...running }),
      commandEvent("command.started", { ...second, ...running }),
      commandEvent("command.finished", second),
      commandEvent("command.finished", { ...first, outcome: "cancelled" }),
    ].map((event, index) => ({ ...event, id: `event-${index}`, seq: index + 1 }));
    const live = events.reduce<ReturnType<typeof reduceThreadSnapshot>>(
      (current, event) => reduceThreadSnapshot(current, event),
      snapshot([]),
    );
    expect(live?.messages).toEqual([
      expect.objectContaining({ blocks: [{ kind: "command", command: finished }] }),
    ]);
  });
  it("keeps every card when resumed calls reuse ids and a resumed-away call finishes late", () => {
    const live = resumedCallScenario().reduce<ReturnType<typeof reduceThreadSnapshot>>(
      (current, event) =>
        isThreadSnapshotEvent(event) ? reduceThreadSnapshot(current, event) : current,
      snapshot([]),
    );
    expect(shownCards(live?.messages)).toEqual(RESUMED_CALL_CARDS);
  });
  it("joins a resumed call's card by its link when the killed call's card is on an unloaded older page", () => {
    // The thread has only recent messages loaded; the killed call's own card, if it ever
    // published one, is further back than the page this reader fetched.
    const resumed = { commandId: "card-z", executionId: "shell:1", command: "pnpm build" };
    const open = { exitCode: null, durationMs: null, stdout: null, stderr: null };
    const events = [
      resumedEvent("shell:0", "shell:1", { fromCommandId: "card-y", toCommandId: "card-z" }),
      commandEvent("command.intent", { ...resumed, ...open, outcome: "waiting" }),
      commandEvent("command.finished", { ...resumed, stdout: "built\n" }),
    ].map((live, index) => ({ ...live, id: `live-${index}`, seq: 10 + index }));
    const initial = snapshot([message("m-1", [{ kind: "text", text: "building" }])], 3);
    const live = events.reduce<ReturnType<typeof reduceThreadSnapshot>>(
      (current, event) =>
        isThreadSnapshotEvent(event) ? reduceThreadSnapshot(current, event) : current,
      initial,
    );
    // The row already carries the id the server uses for the joined card, not a fresh one.
    expect(shownCards(live?.messages)).toEqual([
      ["m-1", undefined, undefined, undefined],
      ["command:resumed:card-z", "pnpm build", "completed", "built\n"],
    ]);
    // Loading the older page returns the killed call's row, already renamed by the server to
    // the same id: the merge must not add a second card for it.
    const withOlderPage = prependThreadMessagePage(live, {
      threadId: "thread-1",
      messages: [
        message(
          "command:resumed:card-z",
          [
            {
              kind: "command",
              command: commandBlock({
                commandId: "card-z",
                command: "pnpm build",
                stdout: "built\n",
                resumedFrom: ["card-y"],
              }),
            },
          ],
          1,
        ),
      ],
      olderCursor: null,
    });
    expect(shownCards(withOlderPage?.messages)).toEqual([
      ["command:resumed:card-z", "pnpm build", "completed", "built\n"],
      ["m-1", undefined, undefined, undefined],
    ]);
  });
  it("keeps a live resume link across a refresh, so the resumed call still joins the old card", () => {
    const initial = snapshot([message("m-1", [{ kind: "text", text: "building" }])], 3);
    const afterLink = reduceThreadSnapshot(initial, {
      ...resumedEvent("shell:0", "shell:1", { fromCommandId: "card-y", toCommandId: "card-z" }),
      id: "link",
      seq: 10,
    });
    expect(afterLink?.links).toEqual([
      { from: "shell:0", to: "shell:1", fromCommandId: "card-y", toCommandId: "card-z" },
    ]);
    // A window-focus refresh returns the server's snapshot at the same point: the resumed call
    // has not published its own card yet, and the killed call's card is still off this page.
    // `threads.get` never sends `links`, so a naive merge would silently drop it here.
    const refreshed = reconcileRefreshedThread(
      afterLink,
      { ...initial, cursor: afterLink!.cursor },
      null,
    );
    expect(refreshed.snapshot.links).toEqual(afterLink?.links);
    const resumed = { commandId: "card-z", executionId: "shell:1", command: "pnpm build" };
    const open = { exitCode: null, durationMs: null, stdout: null, stderr: null };
    const live = [
      commandEvent("command.intent", { ...resumed, ...open, outcome: "waiting" }),
      commandEvent("command.finished", { ...resumed, stdout: "built\n" }),
    ]
      .map((event, index) => ({ ...event, id: `live-${index}`, seq: 11 + index }))
      .reduce<ReturnType<typeof reduceThreadSnapshot>>(
        (current, event) => reduceThreadSnapshot(current, event),
        refreshed.snapshot,
      );
    // One card, already at the id the server would use: the refresh never wiped the link.
    expect(shownCards(live?.messages)).toEqual([
      ["m-1", undefined, undefined, undefined],
      ["command:resumed:card-z", "pnpm build", "completed", "built\n"],
    ]);
  });
});

/**
 * One run through all three ways a resumed call's card was lost: `ls` finishes on an id that a
 * later `pnpm build` reuses and is killed on; the build resumes under a new id; the killed
 * attempt finishes late; and after a pause `pnpm test` reuses the resumed call's id.
 */
function resumedCallScenario(): FixtureProductEvent[] {
  const listed = { commandId: "card-x", executionId: "shell:0", command: "ls", fence: 1 };
  const killed = { commandId: "card-y", executionId: "shell:0", command: "pnpm build", fence: 2 };
  const resumed = { commandId: "card-z", executionId: "shell:1", command: "pnpm build", fence: 3 };
  const reused = { commandId: "card-c", executionId: "shell:1", command: "pnpm test", fence: 4 };
  const open = { exitCode: null, durationMs: null, stdout: null, stderr: null };
  return [
    commandEvent("command.intent", { ...listed, ...open, outcome: "waiting" }),
    commandEvent("command.finished", { ...listed, stdout: "src\n" }),
    commandEvent("command.intent", { ...killed, ...open, outcome: "waiting" }),
    commandEvent("command.started", { ...killed, ...open, outcome: "running" }),
    resumedEvent("shell:0", "shell:1", { fromCommandId: "card-y", toCommandId: "card-z" }),
    commandEvent("command.intent", { ...resumed, ...open, outcome: "waiting" }),
    commandEvent("command.finished", { ...resumed, stdout: "built\n" }),
    commandEvent("command.finished", { ...killed, outcome: "cancelled" }),
    commandEvent("command.intent", { ...reused, ...open, outcome: "waiting" }),
    commandEvent("command.finished", { ...reused, stdout: "tested\n" }),
  ].map((event, index) => ({ ...event, id: `event-${index}`, seq: 10 + index }));
}

const RESUMED_CALL_CARDS = [
  ["command:card-x", "ls", "completed", "src\n"],
  ["command:resumed:card-z", "pnpm build", "completed", "built\n"],
  ["command:card-c", "pnpm test", "completed", "tested\n"],
];

function shownCards(messages: readonly ThreadMessage[] | undefined) {
  const ids = (messages ?? []).map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
  return (messages ?? []).map((message) => {
    const [block] = message.blocks;
    const card = block?.kind === "command" ? block.command : undefined;
    return [message.id, card?.command, card?.outcome, card?.stdout];
  });
}

function resumedEvent(
  from: string,
  to: string,
  cards: { fromCommandId: string; toCommandId: string },
): FixtureProductEvent {
  return { ...commandEvent(), type: "agent.tool.resumed", payload: { from, to, ...cards } };
}

function commandBlock(overrides: Partial<FixtureCommandBlock> = {}): FixtureCommandBlock {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: 12000,
    exitCode: 0,
    outcome: "completed",
    stdout: "Tests passed.\n",
    stderr: "",
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}

function commandEvent(
  type: FixtureProductEvent["type"] = "command.finished",
  overrides: Partial<FixtureCommandBlock> = {},
): FixtureProductEvent {
  return {
    id: type,
    seq: type === "command.intent" ? 1 : type === "command.started" ? 2 : 3,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-09-23T12:00:00.000Z",
    type,
    payload: { block: commandBlock(overrides) },
  };
}
