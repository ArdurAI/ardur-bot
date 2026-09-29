import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";

export function dashboardFixture(botCount = 1) {
  const now = "2026-09-24T12:00:00.000Z";
  const user = {
    id: "fixture-user",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  };
  const me = {
    userId: user.id,
    email: user.email,
    name: user.name,
    spaceId: "space",
    isDeploymentOwner: true,
    needsModel: false,
    defaultProvider: "fake",
    defaultModel: "fake",
    computerHost: "docker",
    canChooseHostComputer: false,
    sandboxProvider: "fake",
    avatarStyle: "robot",
  };
  const bot = {
    id: "bot",
    spaceId: "space",
    name: "Reviewer",
    title: "",
    description: "",
    instructions: "",
    color: "slate",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread",
    preview: "",
    status: "idle",
    computerMode: "team",
    createdAt: now,
    updatedAt: now,
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
    runtimeKind: "pi",
    modelCredentialId: null,
    pinRevision: 0,
  };
  const bots = Array.from({ length: botCount }, (_, index) =>
    index === 0
      ? bot
      : { ...bot, id: `bot-${index}`, threadId: `thread-${index}`, name: `Reviewer ${index}` },
  );
  const rows = bots.map((entry) => ({
    botId: entry.id,
    botName: entry.name,
    threadId: entry.threadId,
    cursor: 0,
    state: "idle",
    sentence: null,
    requesterName: null,
    reason: null,
    action: null,
    rootTaskId: null,
    delegationId: null,
    canStop: false,
    canAccept: false,
    chain: [],
    executing: null,
    usage: { tokens: 0, costs: [] },
    delegations: [],
  }));
  const space = {
    id: "space",
    name: "Workspace",
    isDefault: true,
    hasContent: true,
    bots,
    groups: [],
    externalConversations: [],
    botSections: [],
  };
  let answered = false;
  let approvedInput: unknown;
  const snapshot = () => ({
    botId: "bot",
    threadId: "thread",
    cursor: 0,
    olderCursor: null,
    run: answered
      ? null
      : {
          id: "run",
          botId: "bot",
          taskId: "task",
          status: "waiting_input",
          trigger: "user",
          createdAt: now,
          updatedAt: now,
        },
    messages: [
      {
        id: "message",
        threadId: "thread",
        runId: "run",
        seq: 1,
        role: "bot",
        createdAt: now,
        blocks: [
          {
            kind: "ask",
            text: "Send the draft?",
            status: answered ? "answered" : "pending",
            ...(answered ? { answer: (approvedInput as { answer: string }).answer } : {}),
            approvalEffectId: "effect",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      },
    ],
  });
  const boardWorkspace = {
    id: "board",
    name: "Planning",
    kind: "space",
    path: "/fixture/board",
    prefix: "work",
    enabled: true,
    initialized: true,
    isDefault: true,
    allowAllBots: true,
    allowedBotIds: [],
  };
  const boardItem = {
    id: "work-1",
    title: "Plan next step",
    description: "Check the work",
    acceptanceCriteria: "",
    type: "task",
    status: "open",
    priority: 2,
    assignee: null,
    labels: [],
    parent: null,
    dependencies: [],
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    externalRef: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    commentCount: 0,
    comments: [],
    history: [],
    closeWhenDone: false,
  };
  let following = false;
  return {
    get approvedInput() {
      return approvedInput;
    },
    session: {
      user,
      session: {
        id: "session",
        userId: user.id,
        token: "fixture-session",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: now,
        updatedAt: now,
      },
    },
    rpc(procedure: string, input?: unknown): unknown {
      const boardInput = input as
        | { itemId?: string; id?: string; patch?: { status?: string }; following?: boolean }
        | undefined;
      if (procedure === "board/update") {
        boardItem.status = boardInput?.patch?.status ?? boardItem.status;
        return { ...boardItem };
      }
      if (procedure === "board/follow") {
        following = boardInput?.following === true;
        return { following };
      }
      const boardSnapshot = {
        items: [{ ...boardItem }],
        allItems: [{ ...boardItem }],
        readyIds: boardItem.status === "open" ? [boardItem.id] : [],
        blockedIds: boardItem.status === "blocked" ? [boardItem.id] : [],
      };
      const values: Record<string, unknown> = {
        me,
        "preferences/get": DEFAULT_USER_PREFERENCES,
        "notifications/activity": {
          userId: user.id,
          preferences: DEFAULT_USER_PREFERENCES,
          activities: [],
        },
        bootstrap: {
          me,
          bots,
          groups: [],
          archivedBots: [],
          archivedGroups: [],
          botSections: [],
          thread: snapshot(),
          routines: [],
          spaces: [space],
        },
        "spaces/list": { current: { ...space, bots }, spaces: [space] },
        "bots/list": [bot],
        "bots/get": bot,
        "team/board": { rows },
        "board/workspaces": { workspaces: [boardWorkspace], problem: null },
        "board/work": {
          workspace: boardWorkspace,
          ready: boardItem.status === "open" ? 1 : 0,
          inProgress: boardItem.status === "in_progress" ? 1 : 0,
          blocked: boardItem.status === "blocked" ? 1 : 0,
          items: boardItem.status === "open" ? [{ ...boardItem }] : [],
        },
        "board/filingOutcomes": {
          bots: [
            { botId: "bot", name: "Reviewer", filed: 3, done: 1, open: 1, closed: 0, other: 1 },
          ],
        },
        "board/view": {
          workspaces: [boardWorkspace],
          workspaceId: "board",
          snapshot: boardSnapshot,
          selected: boardInput?.itemId ? { ...boardItem } : null,
          followingIds: following ? [boardItem.id] : [],
          bots: [bot],
          problem: null,
        },
        "host/status": { configured: false, connected: false, roots: [], health: null },
        "routines/overview": { next: [], recent: [] },
        "workspace/tasks": { runs: [], delegations: [], routines: [], observedAt: now },
        "workspace/describe": {
          botId: (input as { botId?: string } | undefined)?.botId ?? bot.id,
          computerId: null,
          generation: null,
          files: "unavailable",
          observedAt: now,
        },
        "usage/summary": {
          inputTokens: 120,
          outputTokens: 1,
          runs: 1,
          dayStart: "2026-09-24T00:00:00Z",
          weekStart: "2026-09-21T00:00:00Z",
          asOf: now,
          providers: [
            {
              provider: "anthropic",
              today: {
                records: 1,
                inputTokens: 120,
                outputTokens: 1,
                cost: null,
                incomplete: true,
              },
              week: {
                records: 1,
                inputTokens: 120,
                outputTokens: 1,
                cost: null,
                incomplete: true,
              },
              daily: [
                { date: "2026-09-18", records: 0, tokens: 0 },
                { date: "2026-09-19", records: 0, tokens: 0 },
                { date: "2026-09-20", records: 0, tokens: 0 },
                { date: "2026-09-21", records: 0, tokens: 0 },
                { date: "2026-09-22", records: 0, tokens: 0 },
                { date: "2026-09-23", records: 0, tokens: 0 },
                { date: "2026-09-24", records: 1, tokens: 121 },
              ],
            },
          ],
        },
        "learning/list": {
          pendingCount: 0,
          appliedThisWeek: 0,
          proposals: [],
          reviews: [],
          botNames: {},
        },
        "learning/summary": { pendingCount: 0, appliedThisWeek: 0 },
        "features/list": [{ feature: "governance", state: "unavailable" }],
        "threads/get": snapshot(),
        "threads/head": snapshot(),
        "runs/list": {
          runs: answered
            ? []
            : [
                {
                  runId: "run",
                  botId: "bot",
                  botName: "Reviewer",
                  threadId: "thread",
                  groupId: null,
                  groupName: null,
                  status: "waiting_input",
                  trigger: "user",
                  promptSnippet: "Review the draft",
                  updatedAt: now,
                  startedAt: now,
                  notificationsEnabled: false,
                },
              ],
        },
        "messaging/status": { enabled: false, providers: [], identities: [], openSignup: false },
        "voice/status": { transcribe: false, synthesize: false },
        "integrations/list": { catalog: [], connections: [] },
        "mcp/servers/list": [],
        "memory/config": null,
        "memory/providerConfig": {
          generation: 0,
          documentStore: "postgres",
          documentSettings: {},
          provider: "builtin",
          settings: {},
          defaultMemoryScope: "isolated",
          updatedAt: now,
        },
        "memory/list": { items: [], nextCursor: null },
        "learning/settings": {
          enabled: false,
          consolidationEnabled: false,
          reviewerPin: null,
          canConfigure: true,
          destination: {
            runtimeKind: "pi",
            provider: "openai-compatible",
            modelId: "fixture",
            credentialId: "fixture",
            effort: "medium",
            revision: 0,
          },
          budgets: {
            botDailyTokens: 30000,
            spaceDailyTokens: 150000,
            maxProposals: 3,
            timeoutMs: 30000,
            maxOutputTokens: 2000,
            maxOutputChars: 12000,
          },
        },
      };
      values["dashboard/now"] = {
        rows,
        ...(values["runs/list"] as { runs: unknown[] }),
        approvals: snapshot().messages.flatMap((message) =>
          message.blocks
            .filter((block) => block.kind === "ask" && block.status === "pending")
            .map((block) => ({ runId: message.runId, messageId: message.id, block })),
        ),
      };
      if (procedure === "threads/answer") {
        approvedInput = input;
        answered = true;
        return { ok: true };
      }
      return Object.hasOwn(values, procedure) ? values[procedure] : [];
    },
  };
}
