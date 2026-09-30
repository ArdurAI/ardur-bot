import type {
  ComputerStatus,
  GroupMember,
  ProductEvent,
  Run,
  RunStatus,
  ThreadMessage,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@ardurbot/contracts";
import {
  ProviderErrorKindSchema,
  RunTriggerSchema,
  RuntimePinSchema,
  RuntimeProblemSchema,
} from "@ardurbot/contracts";
import {
  isActive,
  isCommandCardEvent,
  isRunTerminalEvent,
  mergeCommandLinks,
  mergeThreadHistory,
  prependThreadHistoryPage,
  progressMessageId,
  reduceCommandMessages,
  reduceLiveMessageBlocks,
  reduceRunContext,
  runFailureError,
  showsReplyText,
  subagentBlockFromPayload,
  takeLiveMessage,
  updateCloudAgentMessages,
  upsertAtLivePlace,
  upsertMessageById,
} from "@ardurbot/core";

function runFromStartedEvent(event: ProductEvent, previous: Run | undefined): Run {
  const trigger = RunTriggerSchema.safeParse(event.payload.trigger);
  const pin = RuntimePinSchema.safeParse(event.payload.runtimePin);
  return {
    id: event.runId ?? previous?.id ?? event.id,
    botId: event.botId,
    threadId: event.threadId,
    taskId: previous?.taskId ?? event.runId ?? event.id,
    status: "running",
    trigger: trigger.success ? trigger.data : (previous?.trigger ?? "user"),
    routineId:
      typeof event.payload.routineId === "string"
        ? event.payload.routineId
        : (previous?.routineId ?? null),
    modelProvider: previous?.modelProvider ?? null,
    modelId: previous?.modelId ?? null,
    runtimePin: pin.success ? pin.data : previous?.runtimePin,
    error: null,
    startedAt: previous?.startedAt ?? event.createdAt,
    completedAt: null,
    createdAt: previous?.createdAt ?? event.createdAt,
  };
}

const computerStates: ReadonlySet<unknown> = new Set<ComputerStatus["state"]>([
  "stopped",
  "booting",
  "running",
  "suspended",
  "error",
]);

export function activeThreadRuns(
  snapshot: ThreadSnapshot | null,
): NonNullable<ThreadSnapshot["activeRuns"]> {
  return snapshot?.activeRuns ?? (snapshot?.run ? [snapshot.run] : []);
}

export function activeMemberRun(runs: readonly Run[], botId: string): Run | null {
  // Snapshots list runs newest first. A run that has left the queue is the one the member is
  // working on; a newer queued run, pinned or not, must not hide it. Among equals, prefer the
  // run whose model choice was already captured.
  const active = runs.filter((run) => run.botId === botId && isActive(run.status));
  const started = active.filter((run) => run.status !== "queued");
  const pool = started.length ? started : active;
  return pool.find((run) => run.runtimePin != null) ?? pool[0] ?? null;
}

/**
 * Reflect a committed direct-message send before its follow-up snapshot arrives.
 *
 * threads.send returns only after the message and run are durable. Keeping that
 * receipt prevents a transient snapshot/SSE interruption from showing a stored
 * user bubble with no working state. A matching live run always wins, and the
 * next durable event or refresh still supplies the authoritative status.
 */
export function applyThreadSendReceipt(
  snapshot: ThreadSnapshot | null,
  receipt: { botId: string; runId: string; taskId: string; createdAt?: string },
  terminalRunIds: ReadonlySet<string> = new Set(),
): ThreadSnapshot | null {
  if (
    !snapshot ||
    snapshot.groupId ||
    snapshot.botId !== receipt.botId ||
    snapshot.run?.id === receipt.runId ||
    terminalRunIds.has(receipt.runId)
  ) {
    return snapshot;
  }
  const currentRuns = activeThreadRuns(snapshot);
  if (currentRuns.some((run) => isActive(run.status as RunStatus))) return snapshot;
  const createdAt = receipt.createdAt ?? new Date().toISOString();
  const run: Run = {
    id: receipt.runId,
    botId: receipt.botId,
    threadId: snapshot.threadId,
    taskId: receipt.taskId,
    status: "queued",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt,
  };
  return { ...snapshot, run, activeRuns: [run] };
}

/** Reason the newest run stopped, until the reader dismisses that run's failure. */
export function threadRunError(
  snapshot: ThreadSnapshot | null,
  dismissedRunIds?: ReadonlySet<string>,
): string | null {
  const run = snapshot?.run;
  if (run?.status !== "failed" || dismissedRunIds?.has(run.id)) return null;
  return run.error ?? null;
}

/**
 * The refusing run's bot name for the refusal banner: the bot list first, then the
 * snapshot's members. When the bot is in neither there is no name to fill — the banner
 * shows the recorded sentence — and the thread's own name (a group's, say) is never
 * used, because the sentence names the bot whose run refused, not the thread it ran in.
 */
export function refusalRunBotName(
  snapshot: Pick<ThreadSnapshot, "run"> | null,
  bots: ReadonlyArray<{ id: string; name: string }>,
  members: ReadonlyArray<GroupMember> | undefined,
): string | undefined {
  const botId = snapshot?.run?.botId;
  if (!botId) return undefined;
  return (
    bots.find((bot) => bot.id === botId)?.name ??
    members?.find((member) => member.botId === botId)?.name
  );
}

export function clearActiveThreadRuns(snapshot: ThreadSnapshot): ThreadSnapshot {
  const runIds = new Set(activeThreadRuns(snapshot).map((run) => run.id));
  const computer = snapshot.computer?.busyBotName
    ? { ...snapshot.computer, busyBotName: null }
    : snapshot.computer;
  return {
    ...snapshot,
    run: null,
    activeRuns: [],
    messages: snapshot.messages.filter(
      (message) =>
        !message.runId || !runIds.has(message.runId) || !message.id.startsWith("progress:"),
    ),
    computer,
  };
}

export function mergeThreadSnapshot(
  prev: ThreadSnapshot | null,
  next: ThreadSnapshot,
  preserveLoadedHistory = false,
): ThreadSnapshot {
  // A threads.get started before SSE caught up must not wipe newer live state
  // (e.g. ask cards applied after send's post-refresh request was already in flight).
  if (prev && prev.threadId === next.threadId && prev.cursor > next.cursor) return prev;
  const merged = mergeThreadHistory(prev, next, preserveLoadedHistory);
  // The server never sends `links`; a same-thread refresh must not drop the reader's own record
  // of live resume links, which is how a partially loaded thread stays correct across a refresh.
  const carried = prev && prev.threadId === next.threadId ? (prev.links ?? []) : [];
  return { ...merged, links: mergeCommandLinks(carried, merged.messages) };
}

/**
 * Apply a threads.get refresh without clobbering newer event-sourced takeover state.
 *
 * A refresh that started earlier can still return running+busyBotName after the client
 * already applied waiting_takeover. Cursor comparisons only apply within the same thread.
 * Stop clears run/busy optimistically in the shell because it has no terminal event; an
 * older-cursor refresh must keep that cleared local state (see Shell stopRun).
 */
export function reconcileRefreshedThread(
  prev: ThreadSnapshot | null,
  snap: ThreadSnapshot,
  prevComputer: ComputerStatus | null,
  preserveLoadedHistory = false,
): { snapshot: ThreadSnapshot; computer: ComputerStatus | null } {
  const sameThread = Boolean(prev && prev.threadId === snap.threadId);

  if (sameThread && prev && snap.cursor < prev.cursor) {
    // A subscription can advance the cursor with progress before the send-triggered refresh
    // returns the new run record. Hydrate that matching run without rolling the transcript back.
    // Optimistic stop removes the matching progress message, so an older refresh cannot revive it.
    const refreshedRun = snap.run;
    const hasMatchingLiveProgress = Boolean(
      refreshedRun &&
        prev.messages.some(
          (message) =>
            message.runId === refreshedRun.id && message.id === `progress:${refreshedRun.id}`,
        ),
    );
    if (!prev.run && refreshedRun && hasMatchingLiveProgress) {
      return {
        snapshot: {
          ...prev,
          run: refreshedRun,
          activeRuns: snap.activeRuns,
          computer: snap.computer,
        },
        computer: snap.computer ?? null,
      };
    }
    // Progress can advance the thread cursor while embedded computer status from threads.get
    // is still useful — but only while a live run remains. Preserve event-sourced
    // waiting_takeover clears and optimistic stop clears.
    const preserveLocalComputer =
      prev.run?.status === "waiting_takeover" ||
      !prev.run ||
      !isActive(prev.run.status as RunStatus);
    return {
      snapshot: prev,
      computer: preserveLocalComputer ? prevComputer : (snap.computer ?? null),
    };
  }

  let snapshot = mergeThreadSnapshot(prev, snap, preserveLoadedHistory);
  let computer = snap.computer ?? null;

  const localWaiting =
    sameThread &&
    prev?.run?.status === "waiting_takeover" &&
    snapshot.run?.id === prev.run.id &&
    snapshot.run.status !== "waiting_takeover" &&
    isActive(snapshot.run.status as RunStatus);

  if (localWaiting && snapshot.run) {
    const runId = snapshot.run.id;
    snapshot = {
      ...snapshot,
      run: { ...snapshot.run, status: "waiting_takeover" },
      activeRuns: snapshot.activeRuns?.map((run) =>
        run.id === runId ? { ...run, status: "waiting_takeover" } : run,
      ),
    };
    if (computer?.busyBotName) computer = { ...computer, busyBotName: null };
  } else if (snapshot.run?.status === "waiting_takeover" && computer?.busyBotName) {
    computer = { ...computer, busyBotName: null };
  }

  return { snapshot, computer };
}

export function prependThreadMessagePage(
  prev: ThreadSnapshot | null,
  page: ThreadMessagePage,
): ThreadSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export function isThreadSnapshotEvent(event: ProductEvent): boolean {
  return (
    isCommandCardEvent(event.type) ||
    event.type === "thread.cleared" ||
    event.type === "thread.progress" ||
    event.type === "thread.subagent" ||
    event.type === "thread.cloud_agent" ||
    event.type === "agent.tool.called" ||
    event.type === "agent.tool.completed" ||
    event.type === "thread.message.created" ||
    event.type === "thread.message.updated" ||
    event.type === "thread.message.reaction" ||
    event.type === "run.started" ||
    event.type === "run.context" ||
    event.type === "run.waiting_input" ||
    event.type === "run.retry_scheduled" ||
    event.type === "computer.takeover.requested" ||
    isRunTerminalEvent(event)
  );
}

export function isGroupMemberModelPinEvent(event: ProductEvent): boolean {
  return event.type === "group.memberModelPin.set" || event.type === "group.memberModelPin.cleared";
}

export function reduceThreadSnapshot(
  prev: ThreadSnapshot | null,
  event: ProductEvent,
): ThreadSnapshot | null {
  if (!prev) return prev;
  if (event.type === "run.context") return reduceRunContext(prev, event);
  if (isCommandCardEvent(event.type) && event.seq <= (prev.cursor ?? -1)) return prev;
  if (isCommandCardEvent(event.type)) {
    const { messages, links } = reduceCommandMessages(
      { messages: prev.messages, links: prev.links ?? [] },
      event,
    );
    return { ...prev, cursor: event.seq, messages, links: [...links] };
  }
  if (isRunTerminalEvent(event)) {
    const { messages } = reduceCommandMessages(
      { messages: prev.messages, links: prev.links ?? [] },
      event,
    );
    prev = { ...prev, messages };
  }
  if (event.type === "thread.cleared") {
    return {
      ...prev,
      cursor: event.seq,
      messages: [],
      olderCursor: null,
      run: null,
      contextRun: null,
      activeRuns: [],
    };
  }
  if (event.type === "run.started") {
    if (!event.runId) {
      return {
        ...prev,
        cursor: event.seq,
        members: updateMemberStatus(prev.members, event.botId, "running"),
      };
    }
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined);
    const run = runFromStartedEvent(event, previousRun);
    const without = (prev.activeRuns ?? (prev.run ? [prev.run] : [])).filter(
      (candidate) => candidate.id !== run.id,
    );
    // Bot threads keep a single primary run; groups accumulate concurrent member runs.
    const activeRuns = prev.groupId ? [...without, run] : [run];
    return {
      ...prev,
      cursor: event.seq,
      members: updateMemberStatus(prev.members, event.botId, "running"),
      // A group failure lives only in run; keep it until dismiss so a late member start
      // cannot wipe the banner (activeRuns still tracks the new work).
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const runId = event.runId;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(knownInRun && prev.run && prev.run.status !== status);
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some((candidate) => candidate.id === runId && candidate.status !== status),
    );
    const members = updateMemberStatus(prev.members, event.botId, status);
    // Ask pauses delete progress events server-side; drop the live bubble so a missed
    // message.created cannot leave "working…" stuck next to waiting_input.
    const liveId = progressMessageId(event);
    const messages =
      event.type === "run.waiting_input" && prev.messages.some((message) => message.id === liveId)
        ? prev.messages.filter((message) => message.id !== liveId)
        : prev.messages;
    if (
      !runChanged &&
      !activeRunChanged &&
      !needsInsert &&
      members === prev.members &&
      messages === prev.messages
    ) {
      return prev;
    }
    if (needsInsert && runId) {
      const waitingRun: Run = {
        id: runId,
        botId: event.botId,
        threadId: event.threadId,
        taskId: runId,
        status,
        trigger: "bot_message",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: event.createdAt,
        completedAt: null,
        createdAt: event.createdAt,
      };
      const baseActive = prev.activeRuns ?? (prev.run ? [prev.run] : []);
      const activeRuns = [...baseActive.filter((candidate) => candidate.id !== runId), waitingRun];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor: event.seq,
        members,
        messages,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    return {
      ...prev,
      cursor: event.seq,
      members,
      messages,
      run: runChanged && prev.run ? { ...prev.run, status } : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === runId ? { ...candidate, status } : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (event.type === "run.retry_scheduled") {
    const retryRunId = event.runId;
    if (!retryRunId) return { ...prev, cursor: event.seq };
    const waitMs = typeof event.payload.waitMs === "number" ? event.payload.waitMs : 0;
    const providerRetryAt = new Date(Date.parse(event.createdAt) + waitMs).toISOString();
    const markWaiting = (run: Run): Run =>
      run.id === retryRunId ? { ...run, status: "queued", providerRetryAt } : run;
    return {
      ...prev,
      cursor: event.seq,
      members: updateMemberStatus(prev.members, event.botId, "queued"),
      run: prev.run ? markWaiting(prev.run) : prev.run,
      activeRuns: prev.activeRuns?.map(markWaiting),
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // In a group the failing run may be a member run rather than the displayed one, so look
    // it up in activeRuns as well or its error would be dropped with it.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor: event.seq,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      // A failed run stays in run (activeRuns already excludes it) so the transcript can say
      // why it stopped, matching what threads.get returns on the next load.
      run:
        endedRun && failure
          ? {
              ...endedRun,
              status: "failed",
              error: failure,
              runtimeProblem: RuntimeProblemSchema.safeParse(event.payload.runtimeProblem).data,
              providerErrorKind: ProviderErrorKindSchema.safeParse(event.payload.providerErrorKind)
                .data,
            }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(previous?.blocks ?? [], {
      type: "progress",
      payload: event.payload,
    });
    const streaming: ThreadMessage = {
      id: liveId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    return {
      ...prev,
      cursor: event.seq,
      messages: placeLiveDraft(prev.messages, previous, remaining, streaming),
    };
  }
  if (event.type === "agent.tool.called") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(previous?.blocks ?? [], {
      type: "tool",
      name: String(event.payload.name ?? ""),
    });
    const next: ThreadMessage = {
      id: liveId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    return {
      ...prev,
      cursor: event.seq,
      messages: placeLiveDraft(prev.messages, previous, remaining, next),
    };
  }
  if (event.type === "agent.tool.completed") {
    return { ...prev, cursor: event.seq };
  }
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(event.payload);
    const next: ThreadMessage = {
      id: `subagent:${block.agentId}`,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [block],
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    // The card goes after the newest message, above the live drafts still trailing it.
    // Drafts never move here: one that holds its place above later messages keeps it.
    const rest = prev.messages.filter(
      (message) =>
        message.id !== next.id && (!message.id.startsWith("progress:") || Boolean(message.runId)),
    );
    const slot = rest.findLastIndex((message) => !message.id.startsWith("progress:")) + 1;
    return {
      ...prev,
      cursor: event.seq,
      messages: [...rest.slice(0, slot), next, ...rest.slice(slot)],
    };
  }

  if (event.type === "thread.cloud_agent") {
    return {
      ...prev,
      cursor: event.seq,
      messages: updateCloudAgentMessages(prev.messages, event.payload ?? {}),
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    if (event.type === "thread.message.updated" && event.seq <= prev.cursor) return prev;
    const role = (event.payload.role as ThreadMessage["role"]) ?? "bot";
    const blocks = (event.payload.blocks as ThreadMessage["blocks"]) ?? [];
    const next: ThreadMessage = {
      id: String(event.payload.messageId ?? event.id),
      threadId: event.threadId,
      seq: typeof event.payload.messageSeq === "number" ? event.payload.messageSeq : event.seq,
      role,
      blocks,
      botId: event.botId,
      runId: event.runId,
      replyToMessageId:
        typeof event.payload.replyToMessageId === "string"
          ? event.payload.replyToMessageId
          : undefined,
      replyQuote:
        typeof event.payload.replyQuote === "string" ? event.payload.replyQuote : undefined,
      createdAt:
        typeof event.payload.createdAt === "string" ? event.payload.createdAt : event.createdAt,
    };
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const without = prev.messages.filter(
      (message) => !replacedSubagent(message, replacedSubagentIds),
    );
    return {
      ...prev,
      cursor: event.seq,
      messages: placeSavedMessage(
        without,
        progressMessageId(event),
        next,
        event.type === "thread.message.created",
      ),
    };
  }
  return prev;
}

/**
 * A run's live draft holds its place in the thread once it shows reply text: the server
 * holds the reply's position from that first streamed text, and the saved reply fills it.
 * A draft with only tool activity or reasoning has no place yet (and no bubble); it follows
 * the newest message, where its reply will be saved.
 */
function draftHoldsPlace(draft: ThreadMessage | undefined): boolean {
  return draft !== undefined && showsReplyText(draft.blocks);
}

/** Put a run's updated live draft back: in the place it holds, or after the newest message. */
function placeLiveDraft(
  messages: readonly ThreadMessage[],
  previous: ThreadMessage | undefined,
  remaining: ThreadMessage[],
  draft: ThreadMessage,
): ThreadMessage[] {
  return draftHoldsPlace(previous)
    ? upsertAtLivePlace(messages, draft.id, draft)
    : [...remaining, draft];
}

/**
 * Place a saved message the way the server orders it. A new bot message that saves text
 * fills the place its run's draft holds. Everything else lands after the newest message:
 * the owner's messages and notices leave the draft alone, and the run's other messages
 * (cards, or a reply whose draft held no place) keep a draft that holds its place for the
 * reply still to come and drop one that does not.
 */
function placeSavedMessage(
  messages: readonly ThreadMessage[],
  liveId: string,
  next: ThreadMessage,
  created: boolean,
): ThreadMessage[] {
  if (next.role !== "bot") return upsertMessageById(messages, next);
  if (!draftHoldsPlace(messages.find((message) => message.id === liveId))) {
    return upsertMessageById(takeLiveMessage(messages, liveId).remaining, next);
  }
  const fillsDraft =
    created &&
    next.blocks.some((block) => block.kind === "text") &&
    !messages.some((message) => message.id === next.id);
  return fillsDraft ? upsertAtLivePlace(messages, liveId, next) : upsertMessageById(messages, next);
}

function updateMemberStatus(
  members: ThreadSnapshot["members"],
  botId: string,
  status: string,
): ThreadSnapshot["members"] {
  const member = members?.find((candidate) => candidate.botId === botId);
  if (!member || member.status === status) return members;
  return members?.map((candidate) =>
    candidate.botId === botId ? { ...candidate, status } : candidate,
  );
}

export function userHoldsComputerControl(
  computer: Pick<ComputerStatus, "controlHolder" | "controlBotId"> | null | undefined,
  botId: string | undefined,
): boolean {
  return Boolean(botId && computer?.controlHolder === "user" && computer.controlBotId === botId);
}

/** True when a live bot run is blocking Take control (API would return 409). */
export function computerTakeoverBlocked(
  computer: Pick<ComputerStatus, "busyBotName"> | null | undefined,
  runs: readonly Run[],
  botId: string,
): boolean {
  if (!computer?.busyBotName) return false;
  // Only the computer bot's own run counts: in a group the headline run can be another member's.
  const run = activeMemberRun(runs, botId);
  // waiting_takeover is the bot asking for control; no active run clears the block even if
  // busyBotName is briefly stale while the executor still holds the lease in finally.
  return Boolean(run && run.status !== "waiting_takeover");
}

export function computerPanelAutoBoot(
  state: ComputerStatus["state"] | undefined,
  screenUrl?: string | null,
): "boot" | "recover-screen" | "wait" {
  if (state === "booting" || state === "suspended") return "wait";
  if (state === "running") return screenUrl ? "wait" : "recover-screen";
  return "boot";
}

/** Auto panel reconnect must use computer.boot — never computer.recover (that destroys the sandbox). */
export function computerPanelAutoUsesBoot(
  action: ReturnType<typeof computerPanelAutoBoot>,
): boolean {
  return action === "boot" || action === "recover-screen";
}

/** A computer that was never started needs no maintenance; one whose boot failed does. */
export function computerPanelNeedsMaintenance(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  bootFailed: boolean,
): boolean {
  return !booting && (state === "error" || (state === "stopped" && bootFailed));
}

export function reduceComputerStatus(
  prev: ComputerStatus | null,
  event: ProductEvent,
): ComputerStatus | null {
  if (!prev) return prev;
  if (!isComputerStatusEvent(event)) return prev;
  if (event.botId !== prev.botId) return prev;
  if (event.type === "computer.takeover.requested") {
    const retainedControl = event.payload.retainedControl === true;
    const next = {
      ...prev,
      busyBotName: null,
      takeoverRequested: true,
      ...(retainedControl ? {} : { controlHolder: "none" as const, controlBotId: null }),
    };
    return prev.busyBotName === next.busyBotName &&
      prev.takeoverRequested === next.takeoverRequested &&
      prev.controlHolder === next.controlHolder &&
      prev.controlBotId === next.controlBotId
      ? prev
      : next;
  }
  if (event.type === "computer.takeover.granted") {
    const takeoverRequested = event.payload.takeoverRequested === true;
    return prev.controlHolder === "user" &&
      prev.controlBotId === event.botId &&
      prev.takeoverRequested === takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: "user",
          controlBotId: event.botId,
          takeoverRequested,
          busyBotName: null,
        };
  }
  if (event.type === "computer.takeover.released") {
    const holder = event.payload.holder;
    if (holder !== "bot" && holder !== "none") return prev;
    return prev.controlHolder === holder &&
      prev.controlBotId === null &&
      !prev.takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: holder,
          controlBotId: null,
          takeoverRequested: false,
          busyBotName: null,
        };
  }
  const status = event.payload.status;
  if (!isComputerState(status)) return prev;
  const imagePulling = status === "booting" && event.payload.imagePulling === true;
  const imagePullPercent =
    imagePulling &&
    (event.payload.imagePullPercent === null ||
      (typeof event.payload.imagePullPercent === "number" &&
        Number.isInteger(event.payload.imagePullPercent) &&
        event.payload.imagePullPercent >= 0 &&
        event.payload.imagePullPercent <= 100))
      ? (event.payload.imagePullPercent as number | null)
      : undefined;
  const screenAvailable = status === "running" || status === "booting" || prev.screenAvailable;
  if (
    status === prev.state &&
    screenAvailable === prev.screenAvailable &&
    imagePulling === prev.imagePulling &&
    imagePullPercent === prev.imagePullPercent
  )
    return prev;
  return {
    ...prev,
    state: status,
    screenAvailable,
    imagePulling,
    imagePullPercent,
  };
}

export function isComputerStatusEvent(event: ProductEvent): boolean {
  return (
    event.type === "computer.status" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.granted" ||
    event.type === "computer.takeover.released"
  );
}

function isComputerState(value: unknown): value is ComputerStatus["state"] {
  return computerStates.has(value);
}

function replacedSubagent(message: ThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}
