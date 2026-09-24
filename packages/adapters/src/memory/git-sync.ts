import { randomUUID } from "node:crypto";
import type { DocumentRevision, MemoryAccess, MemorySyncState } from "@ardurbot/adapter-kit";
import type { JournalDocument } from "@ardurbot/memory";
import type { GitTransport } from "./git-transport.js";
import { contentHash } from "./markdown-files.js";

export interface GitSnapshot {
  oid: string | null;
  documents: JournalDocument[];
  files: Map<string, string>;
}
export interface GitLocalState {
  version: 1;
  remote: Record<string, string>;
  status: MemorySyncState["status"];
  quarantined: boolean;
  delivery: Record<string, JournalDocument["delivery"]>;
}
export interface GitSyncRepository {
  transport: GitTransport;
  branch: string;
  targetBranch: string;
  machineId: string;
  state(): Promise<GitLocalState>;
  saveState(state: GitLocalState): Promise<void>;
  snapshot(oid?: string | null, signal?: AbortSignal): Promise<GitSnapshot>;
  integrate(remote: GitSnapshot, access: MemoryAccess, signal: AbortSignal): Promise<void>;
  quarantine(state: GitLocalState): Promise<void>;
}
export function revisionHash(revision: DocumentRevision): string {
  const { commitId: _commitId, ...portable } = revision;
  return contentHash(JSON.stringify(portable));
}
/** Upstream keeps its identity. A divergent local history becomes a complete sibling document. */
export function reconcileGitDocuments(
  remote: JournalDocument[],
  local: JournalDocument[],
  machine: string,
): JournalDocument[] {
  const result = structuredClone(remote);
  for (const document of local) {
    const head = document.revisions.at(-1)!;
    const existing = result.find(
      (other) => other.id === document.id || other.revisions[0]!.path === head.path,
    );
    if (!existing) {
      result.push(structuredClone(document));
      continue;
    }
    const sameHistory =
      existing.id === document.id &&
      existing.revisions
        .slice(0, Math.min(existing.revisions.length, document.revisions.length))
        .every(
          (revision, index) => revisionHash(revision) === revisionHash(document.revisions[index]!),
        );
    if (sameHistory) {
      if (document.revisions.length > existing.revisions.length)
        Object.assign(existing, structuredClone(document));
      continue;
    }
    const id = randomUUID();
    const siblingPath = `${head.path.replace(/\.md$/iu, "").slice(0, 350)}.conflict-${machine}-${id}.md`;
    result.push({
      ...structuredClone(document),
      id,
      revisions: document.revisions.map((revision) => ({
        ...revision,
        documentId: id,
        path: siblingPath,
      })),
    });
  }
  return result;
}
async function fetchChecked(
  repo: GitSyncRepository,
  branch: string,
  state: GitLocalState,
  signal: AbortSignal,
) {
  const oid = await repo.transport.fetch(branch, signal);
  const previous = state.remote[branch];
  if (previous && (!oid || !(await repo.transport.ancestor(previous, oid, signal)))) {
    await repo.quarantine(state);
    throw new Error("Repository history changed. Review the saved copy before continuing.");
  }
  const snapshot = await repo.snapshot(oid, signal);
  if (oid) state.remote[branch] = oid;
  return snapshot;
}
/** One deadline covers fetch and reconciliation. The child is stopped before the lock is released. */
export async function pullGitMemory(
  repo: GitSyncRepository,
  access: MemoryAccess,
  deadlineMs = 10_000,
): Promise<void> {
  const state = await repo.state();
  if (state.quarantined) return;
  const signal = AbortSignal.any([access.signal, AbortSignal.timeout(deadlineMs)]);
  try {
    const published = await fetchChecked(repo, repo.branch, state, signal);
    if (repo.targetBranch !== repo.branch) {
      const proposed = await fetchChecked(repo, repo.targetBranch, state, signal);
      await repo.integrate(proposed, access, signal);
    }
    await repo.integrate(published, access, signal);
    const local = await repo.snapshot(undefined, signal);
    state.status = local.oid && local.oid !== state.remote[repo.targetBranch] ? "pending" : "ready";
    await repo.saveState(state);
  } catch {
    const current = await repo.state();
    if (!current.quarantined) await repo.saveState({ ...current, status: "last-copy" });
  }
}
export async function pushGitMemory(repo: GitSyncRepository, access: MemoryAccess): Promise<void> {
  const signal = AbortSignal.any([access.signal, AbortSignal.timeout(30_000)]);
  try {
    // Re-fetch on a competing push. Never force, rebase, or drop a committed local revision.
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await repo.state();
      if (state.quarantined)
        throw new Error("Repository history changed. Review the saved copy before continuing.");
      const published = await fetchChecked(repo, repo.branch, state, signal);
      if (repo.targetBranch !== repo.branch) {
        await repo.integrate(
          await fetchChecked(repo, repo.targetBranch, state, signal),
          access,
          signal,
        );
      }
      await repo.integrate(published, access, signal);
      const local = await repo.snapshot(undefined, signal);
      await repo.saveState(state);
      if (!local.oid) return;
      try {
        await repo.transport.push(local.oid, repo.targetBranch, signal);
      } catch {
        if (attempt < 2 && !signal.aborted) continue;
        throw new Error("push failed");
      }
      state.remote[repo.targetBranch] = local.oid;
      state.status = "ready";
      await repo.saveState(state);
      return;
    }
  } catch {
    const state = await repo.state();
    if (!state.quarantined) await repo.saveState({ ...state, status: "failed" });
    throw new Error("Saved locally. GitHub sync failed.");
  }
}
