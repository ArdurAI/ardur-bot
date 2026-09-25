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
    messages: answered
      ? []
      : [
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
                status: "pending",
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
        "board/workspaces": { workspaces: [], problem: null },
        "host/status": { configured: false, connected: false, roots: [], health: null },
        "routines/overview": { next: [], recent: [] },
        "usage/summary": {
          inputTokens: 0,
          outputTokens: 0,
          runs: 0,
          dayStart: now,
          weekStart: "2026-09-21T00:00:00Z",
          asOf: now,
          providers: [],
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
        "memory/config": null,
      };
      values["dashboard/now"] = {
        rows,
        ...(values["runs/list"] as { runs: unknown[] }),
        approvals: snapshot().messages.flatMap((message) =>
          message.blocks.map((block) => ({ runId: message.runId, messageId: message.id, block })),
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
