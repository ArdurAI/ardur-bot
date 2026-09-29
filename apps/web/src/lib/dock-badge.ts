import { desktopBridge } from "./desktop";

export function isOwnerWaitingStatus(status: string | null | undefined): boolean {
  return status === "waiting_input" || status === "waiting_takeover";
}

let lastSent: number | null = null;

/** Tells the desktop shell how many bots are waiting. No-op in a browser. */
export function publishDockWaitingCount(count: number): void {
  if (lastSent === count) return;
  const send = desktopBridge()?.dock?.setWaitingCount;
  if (!send) return;
  const pending = send(count);
  lastSent = count;
  void Promise.resolve(pending).catch(() => undefined);
}

/** The open thread, or nothing once the owner has left it. */
export function openDockSnapshot<T extends { threadId: string }>(
  threadOpen: boolean,
  snapshot: T | null,
): { snapshot: T | null; viewingThreadId: string | null } {
  if (!threadOpen || snapshot === null) return { snapshot: null, viewingThreadId: null };
  return { snapshot, viewingThreadId: snapshot.threadId };
}

type WaitingRun = { botId?: string; status: string };

/**
 * Distinct bots waiting on the owner.
 * A bot's list status is its newest run in any thread, so the open thread may
 * add a wait the lists have not caught up with, and must not clear one.
 * A null viewing id means that thread is not on screen: a leftover snapshot
 * does not count. Omitting the id means the snapshot is the open thread.
 */
export function countOwnerWaiting(input: {
  bots: readonly { id: string; threadId?: string; status: string }[];
  groups?: readonly {
    id: string;
    threadId?: string;
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
  snapshot?: { threadId: string; runs: readonly WaitingRun[] } | null;
  viewingThreadId?: string | null;
}): number {
  const waiting = new Set<string>();
  const add = (id: string, status: string | null | undefined) => {
    if (isOwnerWaitingStatus(status)) waiting.add(id);
  };
  for (const bot of input.bots) add(bot.id, bot.status);
  if (input.currentSpaceId) {
    for (const space of input.spaces ?? []) {
      if (space.id === input.currentSpaceId) continue;
      for (const bot of space.bots) add(bot.id, bot.status);
      for (const group of space.groups) {
        for (const member of group.members) add(member.botId, member.status);
      }
    }
  }
  for (const group of input.groups ?? []) {
    for (const member of group.members) add(member.botId, member.status);
  }
  const snapshot = input.snapshot;
  if (!snapshot || !snapshotIsOpen(snapshot.threadId, input.viewingThreadId)) return waiting.size;
  for (const run of snapshot.runs) {
    if (run.botId) add(run.botId, run.status);
  }
  return waiting.size;
}

function snapshotIsOpen(threadId: string, viewingThreadId: string | null | undefined): boolean {
  if (viewingThreadId === undefined) return true;
  return viewingThreadId === threadId;
}
