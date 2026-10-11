import {
  GOAL_DEFAULT_MAX_DESCENDANTS,
  GOAL_DEFAULT_PER_WORKER_TOKENS,
  GOAL_FINAL_REVIEW_DESCRIPTION,
  GOAL_MAX_DEPTH,
  GOAL_MAX_HOPS,
} from "@ardurbot/contracts";
import { integrationCatalog } from "../../../packages/adapters/src/integration-catalog";

const now = "2026-09-24T12:00:00.000Z";

/** Isolated, offline states for the second documentation capture tranche. */
export function routineDocsFixture() {
  const routine = {
    id: "morning-brief",
    botId: "bot",
    name: "Morning brief",
    prompt: "Summarize the sample plan.",
    crons: ["0 8 * * 1-5"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    lastRunAt: null,
    nextRunAt: "2026-09-25T08:00:00.000Z",
    createdAt: now,
  };
  let current = { ...routine };
  let ran = false;
  return {
    get current() {
      return current;
    },
    routines: [routine],
    rpc(procedure: string, input?: Record<string, unknown>): unknown {
      if (procedure === "routines/list") return [current];
      if (procedure === "routines/update") {
        current = { ...current, ...input, id: routine.id };
        return current;
      }
      if (procedure === "routines/testRun") {
        ran = true;
        return { runId: "morning-run" };
      }
      if (procedure === "routines/history")
        return ran
          ? [{ id: "morning-run", status: "completed", createdAt: now, completedAt: now }]
          : [];
      return undefined;
    },
  };
}

export function memoryDocsFixture() {
  const document = {
    id: "preferences",
    kind: "preferences",
    content: "Use concise answers.",
    path: "learned/preferences.md",
    revision: 1,
    scopeKey: { kind: "user", spaceId: "space", userId: "fixture-user" },
    author: { kind: "user", userId: "fixture-user" },
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    delivery: { status: "delivered", generation: 0, provider: null },
  };
  const proposal = {
    id: "memory-change",
    type: "memory",
    scope: { spaceId: "space", userId: "fixture-user" },
    target: {},
    documentKind: "preferences",
    proposedContent: "Use concise answers and cite sources.",
    rationale: "Requested memory change.",
    evidenceIds: ["review"],
    diff: "--- current\n+++ proposed\n+Use concise answers and cite sources.",
    status: "pending",
    operation: "memory-edit",
    expiresAt: "2099-01-01T00:00:00Z",
  };
  let proposed = false;
  let approved = false;
  const current = () =>
    approved ? { ...document, content: proposal.proposedContent, revision: 2 } : document;
  const revision = (content: string, number: number) => ({
    kind: document.kind,
    documentId: document.id,
    revision: number,
    scopeKey: document.scopeKey,
    path: document.path,
    content,
    author: document.author,
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: now,
    deletedAt: null,
  });
  return {
    get approved() {
      return approved;
    },
    rpc(procedure: string): unknown {
      if (procedure === "memory/list") return { items: [current()], nextCursor: null };
      if (procedure === "memory/get") return current();
      if (procedure === "memory/history")
        return {
          items: approved
            ? [revision(proposal.proposedContent, 2), revision(document.content, 1)]
            : [revision(document.content, 1)],
          nextCursor: null,
        };
      if (procedure === "learning/list")
        return {
          reviews: [],
          proposals: proposed && !approved ? [proposal] : [],
          pendingCount: proposed && !approved ? 1 : 0,
          appliedThisWeek: approved ? 1 : 0,
        };
      if (procedure === "memory/propose") {
        proposed = true;
        return [proposal];
      }
      if (procedure === "learning/approve") {
        approved = true;
        return { proposal: { ...proposal, status: "applied" } };
      }
      return undefined;
    },
  };
}

export function computerDocsFixture() {
  const capacity = {
    cpuCount: 8,
    cpuLoad1m: 0.5,
    memoryTotal: 32 * 1024 ** 3,
    memoryFree: 24 * 1024 ** 3,
    diskFree: 100 * 1024 ** 3,
    sampledAt: now,
    source: "ssh",
  };
  const target = {
    id: "workshop",
    name: "Workshop computer",
    kind: "ssh",
    connectionId: "workshop",
    state: "connected",
    capacity,
    bots: [],
    ssh: { host: "fixture.invalid", user: "runner", port: 22, authentication: "agent" },
  };
  let fail = false;
  const currentTarget = () =>
    fail
      ? {
          ...target,
          state: "unavailable",
          reachability: { status: "not-reachable", reason: "not-reachable", checkedAt: now },
        }
      : { ...target, reachability: { status: "running", reason: null, checkedAt: now } };
  return {
    setFail(value: boolean) {
      fail = value;
    },
    rpc(procedure: string): unknown {
      if (procedure === "fleet/list")
        return {
          targets: [currentTarget()],
          placement: { mode: "free-memory", preferredTargetId: "workshop", minimumFreeGb: 4 },
          bots: [],
        };
      if (procedure === "fleet/discover") return [];
      if (procedure === "fleet/test")
        return fail
          ? { ok: false, reason: "not-reachable", checkedAt: now, targets: [currentTarget()] }
          : { ok: true, checkedAt: now, targets: [currentTarget()] };
      return undefined;
    },
  };
}

export function integrationDocsFixture() {
  let connection = {
    id: "notes-connection",
    catalogId: "notion",
    state: "connected",
    needsReview: false,
    spaceAllowedTools: ["read_notes", "update_notes"],
    spaceToolPolicies: {},
    manifest: {
      capturedAt: now,
      serverVersion: null,
      account: "Sample account",
      workspace: "Sample workspace",
      scopes: ["read", "write"],
      tools: [
        {
          id: "read_notes",
          description: "Read sample notes",
          inputSchemaDigest: "a".repeat(64),
          annotations: { readOnlyHint: true },
        },
        {
          id: "update_notes",
          description: "Update sample notes",
          inputSchemaDigest: "b".repeat(64),
        },
      ],
    },
  };
  return {
    get connection() {
      return connection;
    },
    rpc(procedure: string, input?: Record<string, unknown>): unknown {
      if (procedure === "integrations/list")
        return { catalog: integrationCatalog, connections: [connection] };
      if (procedure === "integrations/grants" || procedure === "integrations/resourceTools")
        return [];
      if (procedure === "integrations/status") return connection;
      if (procedure === "integrations/toolReview")
        return {
          revision: 1,
          manifest: connection.manifest,
          spaceAllowedTools: connection.spaceAllowedTools,
          canApproveSpace: true,
          spaceNeedsReview: false,
        };
      if (procedure === "integrations/discover") return connection.manifest;
      if (procedure === "integrations/assign") {
        if (input?.connectionId !== connection.id || !Array.isArray(input.toolIds))
          throw new Error("Unexpected integration assignment.");
        connection = {
          ...connection,
          spaceAllowedTools: input.toolIds as string[],
          spaceToolPolicies:
            (input.spaceToolPolicies as Record<string, "allow" | "ask-first">) ??
            connection.spaceToolPolicies,
        };
        return [];
      }
      return undefined;
    },
  };
}

export function groupGoalDocsFixture(review = false) {
  const group = {
    id: "operations-group",
    spaceId: "space",
    name: "Operations huddle",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    threadId: "operations-thread",
    preview: "",
    unread: false,
    createdAt: now,
    updatedAt: now,
    coordinatorBotId: "bot",
    members: [
      { botId: "bot", name: "Reviewer", color: "slate", status: "idle" },
      { botId: "bot-1", name: "Planner", color: "slate", status: "idle" },
    ],
  };
  let goal: Record<string, unknown> | null = review
    ? {
        id: "sample-goal",
        spaceId: "space",
        groupId: group.id,
        threadId: group.threadId,
        coordinatorBotId: "bot",
        rootTaskId: "sample-task",
        objective: "Review the sample release plan.",
        doneWhen: [],
        status: "completed",
        usedTokens: 600,
        reservedTokens: 0,
        availableTokens: 599400,
        usageComplete: true,
        tokenLimit: 600000,
        perWorkerTokens: GOAL_DEFAULT_PER_WORKER_TOKENS,
        maxConcurrent: 2,
        maxDescendants: GOAL_DEFAULT_MAX_DESCENDANTS,
        maxDepth: GOAL_MAX_DEPTH,
        maxHops: GOAL_MAX_HOPS,
        untilAt: "2026-09-24T20:00:00.000Z",
        createdAt: now,
        stoppedAt: null,
        currentRevision: {
          id: "sample-revision",
          goalId: "sample-goal",
          summary: "The sample release plan is ready for review.",
          conditions: [
            {
              id: "cond-final",
              description: GOAL_FINAL_REVIEW_DESCRIPTION,
              status: "unknown",
              actorId: null,
              reason: null,
              evidenceId: null,
              createdAt: null,
            },
          ],
          artifacts: [],
          reports: [],
          attempts: 1,
          accountingSnapshot: { usedTokens: 600, reservedTokens: 0 },
          createdAt: now,
        },
      }
    : null;
  return {
    group,
    get goal() {
      return goal;
    },
    rpc(procedure: string, input?: Record<string, unknown>): unknown {
      if (procedure === "groups/list") return [group];
      if (procedure === "goals/get") return goal;
      if (procedure === "goals/accept" || procedure === "goals/reject") {
        goal = { ...goal, status: procedure === "goals/accept" ? "accepted" : "running" };
        return {
          id: "sample-verdict",
          goalId: "sample-goal",
          revisionId: "sample-revision",
          actorId: "user",
          type: procedure === "goals/accept" ? "accept" : "reject",
          reworkNotes: input?.reworkNotes ?? null,
          createdAt: now,
        };
      }
      if (procedure === "goals/start") {
        goal = {
          ...input,
          id: "sample-goal",
          spaceId: "space",
          groupId: group.id,
          threadId: group.threadId,
          coordinatorBotId: "bot",
          rootTaskId: "sample-task",
          status: "running",
          usedTokens: 0,
          perWorkerTokens: GOAL_DEFAULT_PER_WORKER_TOKENS,
          maxConcurrent: 2,
          maxDescendants: GOAL_DEFAULT_MAX_DESCENDANTS,
          maxDepth: GOAL_MAX_DEPTH,
          maxHops: GOAL_MAX_HOPS,
          untilAt: "2026-09-24T20:00:00.000Z",
          createdAt: now,
          stoppedAt: null,
        };
        return goal;
      }
      if (procedure === "goals/stop") {
        goal = { ...goal, status: "stopped", stoppedAt: now };
        return goal;
      }
      if (procedure === "threads/get" || procedure === "threads/head")
        return {
          groupId: group.id,
          groupName: group.name,
          threadId: group.threadId,
          members: group.members,
          cursor: 0,
          olderCursor: null,
          run: null,
          messages: [],
        };
      return undefined;
    },
  };
}
