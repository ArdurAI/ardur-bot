import type { IdeFile } from "@ardurbot/contracts";

export type WorkspaceOpenFile = IdeFile & {
  id: string;
  savedContent: string;
  source: "live" | "saved";
};

export type WorkspaceFileSession = {
  tabs: WorkspaceOpenFile[];
  active: string;
};

const sessions = new Map<string, WorkspaceFileSession>();
const listeners = new Set<() => void>();
let savingCount = 0;
let snapshot = { dirty: false, saving: false };

export function workspaceFileSessionId(botId: string, computerId: string, generation: number) {
  return `${botId}:${computerId}:${generation}`;
}

export function readWorkspaceFileSession(id: string): WorkspaceFileSession {
  return sessions.get(id) ?? { tabs: [], active: "" };
}

function publish(notify: boolean) {
  let dirty = false;
  for (const session of sessions.values()) {
    if (session.tabs.some((tab) => tab.content !== tab.savedContent)) {
      dirty = true;
      break;
    }
  }
  const saving = savingCount > 0;
  if (snapshot.dirty !== dirty || snapshot.saving !== saving) snapshot = { dirty, saving };
  if (!notify) return;
  for (const listener of listeners) listener();
}

/** `notify` stays false when a render is only moving from one session to another. */
export function writeWorkspaceFileSession(
  id: string,
  session: WorkspaceFileSession,
  notify = true,
) {
  sessions.set(id, session);
  publish(notify);
}

export function subscribeWorkspaceFiles(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function workspaceFilesSnapshot() {
  return snapshot;
}

export function setWorkspaceFileSaving(active: boolean) {
  savingCount += active ? 1 : -1;
  if (savingCount < 0) savingCount = 0;
  publish(true);
}

export function resetWorkspaceFileSessions() {
  sessions.clear();
  savingCount = 0;
  snapshot = { dirty: false, saving: false };
  for (const listener of listeners) listener();
}
