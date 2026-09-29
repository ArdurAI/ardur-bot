import { desktopBridge } from "./desktop";

export function isOwnerWaitingStatus(status: string | null | undefined): boolean {
  return status === "waiting_input" || status === "waiting_takeover";
}

/** `0` is a real update. The same number as last time is not sent again. */
export function nextDockWaitingCount(previous: number | null, count: number): number | null {
  return previous === count ? null : count;
}

export function createDockWaitingPublisher(
  send: (count: number) => void | Promise<void> | false,
): (count: number) => void {
  let previous: number | null = null;
  return (count) => {
    if (nextDockWaitingCount(previous, count) === null) return;
    let result: void | Promise<void> | false;
    try {
      result = send(count);
    } catch {
      return;
    }
    if (result === false) return;
    previous = count;
    if (typeof result === "object" && result && typeof result.then === "function") {
      void result.catch(() => {
        if (previous === count) previous = null;
      });
    }
  };
}

const publishChangedCount = createDockWaitingPublisher((count) => {
  const send = desktopBridge()?.dock?.setWaitingCount;
  if (!send) return false;
  return send(count);
});

/** Tells the desktop shell how many bots are waiting. No-op in a browser. */
export function publishDockWaitingCount(count: number): void {
  publishChangedCount(count);
}

export function countOwnerWaiting(input: {
  bots: readonly { id: string; threadId: string; status: string }[];
  groups?: readonly {
    id: string;
    threadId: string;
    members: readonly { botId: string; status?: string | null }[];
  }[];
  spaces?: readonly {
    id: string;
    bots: readonly { id: string; status: string }[];
    groups: readonly {
      id: string;
      members: readonly { botId: string; status?: string | null }[];
    }[];
  }[];
  currentSpaceId?: string | null;
  snapshot?: { threadId: string; runs: readonly { botId?: string; status: string }[] } | null;
}): number {
  const threads = new Set<string>();
  const countedBots = new Set<string>();
  for (const bot of input.bots) {
    if (!isOwnerWaitingStatus(bot.status)) continue;
    threads.add(bot.threadId);
    countedBots.add(bot.id);
  }
  if (input.currentSpaceId) {
    for (const space of input.spaces ?? []) {
      if (space.id === input.currentSpaceId) continue;
      for (const bot of space.bots) {
        if (!isOwnerWaitingStatus(bot.status)) continue;
        threads.add(`bot:${bot.id}`);
        countedBots.add(bot.id);
      }
      for (const group of space.groups) {
        addGroupThread(threads, `group:${group.id}`, group.members, countedBots);
      }
    }
  }
  for (const group of input.groups ?? []) {
    addGroupThread(threads, group.threadId, group.members, countedBots);
  }
  if (input.snapshot) applySnapshot(threads, countedBots, input.snapshot);
  return threads.size;
}

function addGroupThread(
  threads: Set<string>,
  threadId: string,
  members: readonly { botId: string; status?: string | null }[],
  countedBots: ReadonlySet<string>,
) {
  const waiting = members.filter((member) => isOwnerWaitingStatus(member.status));
  if (waiting.length === 0) return;
  if (waiting.every((member) => countedBots.has(member.botId))) return;
  threads.add(threadId);
}

function applySnapshot(
  threads: Set<string>,
  countedBots: ReadonlySet<string>,
  snapshot: { threadId: string; runs: readonly { botId?: string; status: string }[] },
) {
  const waiting = snapshot.runs.filter((run) => isOwnerWaitingStatus(run.status));
  if (waiting.length === 0) {
    threads.delete(snapshot.threadId);
    return;
  }
  if (threads.has(snapshot.threadId)) return;
  const alreadyCounted = waiting.every(
    (run) => run.botId !== undefined && countedBots.has(run.botId),
  );
  if (!alreadyCounted) threads.add(snapshot.threadId);
}
