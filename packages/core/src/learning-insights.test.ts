import { describe, expect, it } from "vitest";
import {
  APPROVAL_MIN_COUNT,
  APPROVAL_WINDOW_DAYS,
  approvalInsightAllowed,
  CONNECTION_MIN_FAILED_RUNS,
  computeInsights,
  FAILURE_STREAK_RUNS,
  type InsightFacts,
  type InsightPin,
  type InsightRunFact,
  insightFailureClass,
  insightImpact,
  insightTaskKind,
  LEARNING_OFF_MIN_REASONS,
  MEMORY_SEARCH_MIN_BYTES,
  MEMORY_SEARCH_MIN_DOCUMENTS,
  MODEL_CHOICE_MIN_RUNS,
  normalizeInsightPrompt,
  ROUTINE_MIN_COUNT,
  ROUTINE_WINDOW_DAYS,
  reconcileInsights,
  type StoredInsight,
} from "./learning-insights.js";

const now = new Date("2026-09-26T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const daysAgo = (days: number) => hoursAgo(days * 24);

const sonnet: InsightPin = {
  runtimeKind: "pi",
  provider: "anthropic",
  modelId: "claude-sonnet",
  effort: "medium",
  credentialId: "cred-anthropic",
};
const gpt: InsightPin = {
  runtimeKind: "pi",
  provider: "openai",
  modelId: "gpt-4.1",
  effort: "medium",
  credentialId: "cred-openai",
};
const llama: InsightPin = {
  runtimeKind: "pi",
  provider: "ollama",
  modelId: "llama3",
  effort: null,
  credentialId: "cred-ollama",
};
const key = (pin: InsightPin) =>
  [pin.runtimeKind, pin.provider, pin.modelId, pin.effort ?? ""].join("|");

let sequence = 0;
function run(overrides: Partial<InsightRunFact> = {}): InsightRunFact {
  sequence += 1;
  return {
    id: `run-${sequence}`,
    botId: "coder",
    trigger: "user",
    board: false,
    status: "completed",
    at: hoursAgo(sequence),
    durationMs: 60_000,
    pin: gpt,
    tools: ["shell"],
    tokens: 10_000,
    cost: null,
    thumbsUp: false,
    thumbsDown: false,
    failure: null,
    ...overrides,
  };
}
function runs(count: number, overrides: Partial<InsightRunFact>): InsightRunFact[] {
  return Array.from({ length: count }, () => run(overrides));
}

function facts(overrides: Partial<InsightFacts> = {}): InsightFacts {
  return {
    now,
    isOwner: false,
    bots: [{ id: "coder", name: "Coder", pin: gpt }],
    runs: [],
    models: {
      [key(sonnet)]: {
        label: "Claude Sonnet",
        local: false,
        available: true,
        contextWindow: 200_000,
      },
      [key(gpt)]: { label: "GPT-4.1", local: false, available: true, contextWindow: 128_000 },
      [key(llama)]: { label: "llama3", local: true, available: true, contextWindow: 8_192 },
    },
    credentials: [
      { id: "cred-anthropic", provider: "anthropic", label: "Anthropic" },
      { id: "cred-openai", provider: "openai", label: "OpenAI" },
      { id: "cred-ollama", provider: "ollama", label: "Ollama" },
    ],
    providerNames: { anthropic: "Anthropic", openai: "OpenAI" },
    memory: { documents: 0, bytes: 0, semantic: false },
    learningEnabled: true,
    feedbackReasons: 0,
    approvals: [],
    allowRules: [],
    prompts: [],
    routines: [],
    ...overrides,
  };
}
const kinds = (input: InsightFacts) => computeInsights(input).map((insight) => insight.kind);

describe("classification", () => {
  it("classifies runs by trigger first, then tools", () => {
    expect(insightTaskKind({ trigger: "routine", board: false, tools: ["shell"] })).toBe("routine");
    expect(insightTaskKind({ trigger: "user", board: true, tools: [] })).toBe("routine");
    expect(insightTaskKind({ trigger: "user", board: false, tools: ["web_search", "shell"] })).toBe(
      "coding",
    );
    expect(insightTaskKind({ trigger: "user", board: false, tools: ["Edit"] })).toBe("coding");
    expect(insightTaskKind({ trigger: "user", board: false, tools: ["web_fetch"] })).toBe(
      "research",
    );
    expect(insightTaskKind({ trigger: "user", board: false, tools: [] })).toBe("conversation");
    expect(insightTaskKind({ trigger: "user", board: false, tools: ["recall_memory"] })).toBeNull();
  });
  it("classifies failures from typed payloads before text", () => {
    expect(insightFailureClass("anything", { providerErrorKind: "auth" })).toBe("credential");
    expect(insightFailureClass(null, { providerErrorKind: "rate-limit" })).toBe("rate-limit");
    expect(insightFailureClass("x", { runtimeProblem: { code: "pin-credential-missing" } })).toBe(
      "missing-credential",
    );
    expect(insightFailureClass("registry.ollama.ai/library/gemma does not support tools", {})).toBe(
      "tools",
    );
    expect(insightFailureClass("This model's maximum context length is 8192 tokens", {})).toBe(
      "context",
    );
    expect(insightFailureClass("Something else went wrong", {})).toBe("other");
  });
  it("masks numbers and dates in repeated requests", () => {
    expect(normalizeInsightPrompt("  Summarize PRs from 2026-09-21  ")).toBe(
      normalizeInsightPrompt("summarize prs from 2026-09-25"),
    );
    expect(normalizeInsightPrompt("Report for Monday, Sep 21")).toBe("report for #, # #");
  });
});

describe("which model for which work", () => {
  const base = (sonnetCompleted: number, gptCompleted: number, gptTotal = 7) => [
    ...runs(sonnetCompleted, { pin: sonnet, botId: "other" }),
    ...runs(10 - sonnetCompleted, { pin: sonnet, botId: "other", status: "failed" }),
    ...runs(gptCompleted, { pin: gpt }),
    ...runs(gptTotal - gptCompleted, { pin: gpt, status: "failed" }),
  ];
  it("says when an available model finished materially more", () => {
    const [insight] = computeInsights(facts({ runs: base(9, 3) }));
    expect(insight).toMatchObject({
      kind: "model-choice",
      botId: "coder",
      action: { kind: "bot-model", botId: "coder" },
      evidence: {
        variant: "completion",
        taskKind: "coding",
        better: { label: "Claude Sonnet" },
        other: { label: "GPT-4.1" },
        runs: 17,
        days: 30,
      },
    });
    expect(insight!.evidence.kind === "model-choice" && insight!.evidence.rows).toEqual([
      expect.objectContaining({ completed: 9, total: 10, medianTokens: 10_000 }),
      expect.objectContaining({ completed: 3, total: 7 }),
    ]);
  });
  it("needs a gap of at least 25 points", () => {
    // 90% vs 66.7% is 23 points; 90% vs 64% is not tested: 9/10 vs 4/6 fails, 9/10 vs 13/20 = 25.
    expect(kinds(facts({ runs: base(9, 4, 6) }))).not.toContain("model-choice");
    expect(kinds(facts({ runs: base(10, 3, 4) }))).not.toContain("model-choice"); // one failure
    const exact = [
      ...runs(10, { pin: sonnet, botId: "other" }),
      ...runs(15, { pin: gpt }),
      ...runs(5, { pin: gpt, status: "failed" }),
    ];
    expect(kinds(facts({ runs: exact }))).toContain("model-choice"); // 100% vs 75%, 5 failures
  });
  it("needs three failures on the other model", () => {
    const two = [
      ...runs(5, { pin: sonnet, botId: "other" }),
      ...runs(3, { pin: gpt }),
      ...runs(2, { pin: gpt, status: "failed" }),
    ];
    expect(kinds(facts({ runs: two }))).not.toContain("model-choice");
    const three = [...two, run({ pin: gpt, status: "failed" })];
    expect(kinds(facts({ runs: three }))).toContain("model-choice");
  });
  it(`needs ${MODEL_CHOICE_MIN_RUNS} runs on each model`, () => {
    const below = [
      ...runs(MODEL_CHOICE_MIN_RUNS - 1, { pin: sonnet, botId: "other" }),
      ...runs(10, { pin: gpt, status: "failed" }),
    ];
    expect(kinds(facts({ runs: below }))).not.toContain("model-choice");
    const at = [...below, run({ pin: sonnet, botId: "other" })];
    expect(kinds(facts({ runs: at }))).toContain("model-choice");
  });
  it("names only models the space can run now", () => {
    const input = facts({ runs: base(9, 3) });
    input.models[key(sonnet)]!.available = false;
    expect(kinds(input)).not.toContain("model-choice");
  });
  it("never suggests a model outside the bot's locality policy", () => {
    const localOnly = facts({
      runs: base(9, 3),
      bots: [{ id: "coder", name: "Coder", pin: gpt, allowed: [key(llama)] }],
    });
    expect(kinds(localOnly)).not.toContain("model-choice");
    const allowed = facts({
      runs: base(9, 3),
      bots: [{ id: "coder", name: "Coder", pin: gpt, allowed: [key(sonnet)] }],
    });
    expect(kinds(allowed)).toContain("model-choice");
  });
  it("only compares runs in the window and of the same task kind", () => {
    const old = base(9, 3).map((r) => ({ ...r, at: daysAgo(31) }));
    expect(kinds(facts({ runs: old }))).not.toContain("model-choice");
    const research = base(9, 3).map((r) =>
      r.pin === sonnet ? { ...r, tools: ["web_search"] } : r,
    );
    expect(kinds(facts({ runs: research }))).not.toContain("model-choice");
  });
  it("says so when a local model did as well as a hosted one", () => {
    const [insight] = computeInsights(
      facts({
        runs: [...runs(6, { pin: llama, botId: "other" }), ...runs(6, { pin: gpt })],
      }),
    );
    expect(insight?.evidence).toMatchObject({ variant: "local", better: { local: true } });
  });
  it("suggests clearly fewer tokens or less time at a matched completion rate", () => {
    const tokens = [
      ...runs(6, { pin: sonnet, botId: "other", tokens: 6_000 }),
      ...runs(6, { pin: gpt, tokens: 10_000 }),
    ];
    expect(computeInsights(facts({ runs: tokens }))[0]?.evidence).toMatchObject({
      variant: "tokens",
    });
    const barely = [
      ...runs(6, { pin: sonnet, botId: "other", tokens: 6_100 }),
      ...runs(6, { pin: gpt, tokens: 10_000 }),
    ];
    expect(kinds(facts({ runs: barely }))).not.toContain("model-choice");
    const time = [
      ...runs(6, { pin: sonnet, botId: "other", durationMs: 10_000 }),
      ...runs(6, { pin: gpt, durationMs: 60_000 }),
    ];
    expect(computeInsights(facts({ runs: time }))[0]?.evidence).toMatchObject({ variant: "time" });
  });
  it("does not call a model with more thumbs-down a match", () => {
    const input = [
      ...runs(6, { pin: sonnet, botId: "other", tokens: 1_000, thumbsDown: true }),
      ...runs(6, { pin: gpt, tokens: 10_000 }),
    ];
    expect(kinds(facts({ runs: input }))).not.toContain("model-choice");
  });
  it("reports cost only when every run was priced", () => {
    const priced = [
      ...runs(9, { pin: sonnet, botId: "other", cost: 0.5 }),
      ...runs(1, { pin: sonnet, botId: "other", status: "failed" }),
      ...runs(3, { pin: gpt }),
      ...runs(4, { pin: gpt, status: "failed" }),
    ];
    const evidence = computeInsights(facts({ runs: priced }))[0]?.evidence;
    expect(evidence?.kind === "model-choice" && evidence.rows.map((r) => r.costUsd)).toEqual([
      4.5,
      null,
    ]);
  });
});

describe("a model that keeps failing the same way", () => {
  const streak = (count: number, failure: InsightRunFact["failure"], pin = llama) =>
    runs(count, { botId: "local", pin, status: "failed", failure, tools: [] });
  const input = (extra: InsightRunFact[]) =>
    facts({ bots: [{ id: "local", name: "Local", pin: llama }], runs: extra });
  it(`needs the last ${FAILURE_STREAK_RUNS} runs to fail the same way`, () => {
    expect(kinds(input(streak(FAILURE_STREAK_RUNS - 1, "context")))).not.toContain(
      "repeated-failure",
    );
    expect(kinds(input(streak(FAILURE_STREAK_RUNS, "context")))).toContain("repeated-failure");
    const mixed = [
      ...streak(2, "context"),
      run({ botId: "local", pin: llama, status: "failed", failure: "tools" }),
      ...streak(2, "context"),
    ];
    expect(kinds(input(mixed))).not.toContain("repeated-failure");
    // A success in the middle breaks the streak.
    const broken = [
      ...streak(3, "context"),
      run({ botId: "local", pin: llama }),
      ...streak(3, "context"),
    ];
    expect(kinds(input(broken))).not.toContain("repeated-failure");
  });
  it("suggests a larger context from capability data", () => {
    const [insight] = computeInsights(input(streak(6, "context")));
    expect(insight).toMatchObject({
      action: { kind: "bot-model", botId: "local" },
      evidence: {
        failure: "context",
        streak: 6,
        suggested: { label: "Claude Sonnet" },
        contextWindow: 8_192,
        suggestedContextWindow: 200_000,
      },
    });
  });
  it("suggests a model that used tools in the person's runs", () => {
    const [insight] = computeInsights(
      input([...streak(5, "tools"), ...runs(2, { pin: gpt, botId: "other", tools: ["shell"] })]),
    );
    expect(insight?.evidence).toMatchObject({
      failure: "tools",
      suggested: { label: "GPT-4.1" },
      suggestedRuns: 2,
    });
  });
  it("still says it when nothing available would do better", () => {
    const [insight] = computeInsights(input(streak(5, "tools")));
    expect(insight).toMatchObject({
      evidence: { failure: "tools", suggested: null },
      action: { kind: "bot-model" },
    });
  });
  it("ignores other failures", () => {
    expect(kinds(input(streak(8, "other")))).toEqual([]);
  });
  it("sends a rejected credential to its connection", () => {
    const [insight] = computeInsights(
      facts({
        bots: [{ id: "coder", name: "Coder", pin: gpt }],
        credentials: [],
        runs: runs(5, { pin: gpt, status: "failed", failure: "credential", at: daysAgo(20) }),
      }),
    );
    expect(insight).toMatchObject({
      kind: "repeated-failure",
      action: { kind: "connection", provider: "openai", credentialId: "cred-openai" },
    });
  });
});

describe("setup that is holding work back", () => {
  it(`counts runs on a rejected connection from ${CONNECTION_MIN_FAILED_RUNS}`, () => {
    const failed = (count: number) =>
      runs(count, { pin: gpt, status: "failed", failure: "credential", botId: "missing-bot" });
    expect(kinds(facts({ runs: failed(CONNECTION_MIN_FAILED_RUNS - 1) }))).toEqual([]);
    const [insight] = computeInsights(facts({ runs: failed(CONNECTION_MIN_FAILED_RUNS + 1) }));
    expect(insight).toMatchObject({
      kind: "connection",
      evidence: { problem: "rejected", connection: "OpenAI", runs: 3 },
      action: { kind: "connection", provider: "openai", credentialId: "cred-openai" },
    });
  });
  it("forgets rejections from before the connection last worked", () => {
    const input = [
      ...runs(3, { pin: gpt, status: "failed", failure: "credential", at: daysAgo(3), botId: "x" }),
      run({ pin: gpt, at: daysAgo(1), botId: "x" }),
    ];
    expect(kinds(facts({ runs: input }))).toEqual([]);
  });
  it("names a provider that runs needed and nobody connected", () => {
    const input = runs(2, {
      pin: { ...sonnet, credentialId: null },
      status: "failed",
      failure: "missing-credential",
      botId: "x",
    });
    const [insight] = computeInsights(facts({ runs: input, credentials: [] }));
    expect(insight).toMatchObject({
      evidence: { problem: "missing", connection: "Anthropic", runs: 2 },
      action: { kind: "connection", provider: "anthropic" },
    });
  });
  it("suggests memory search above 50 documents or 32 KB, for the owner only", () => {
    const memory = (documents: number, bytes: number, semantic = false) =>
      kinds(facts({ isOwner: true, memory: { documents, bytes, semantic } }));
    expect(memory(MEMORY_SEARCH_MIN_DOCUMENTS, MEMORY_SEARCH_MIN_BYTES)).toEqual([]);
    expect(memory(MEMORY_SEARCH_MIN_DOCUMENTS + 1, 10)).toEqual(["memory-search"]);
    expect(memory(3, MEMORY_SEARCH_MIN_BYTES + 1)).toEqual(["memory-search"]);
    expect(memory(450, 900_000, true)).toEqual([]);
    expect(kinds(facts({ memory: { documents: 450, bytes: 1, semantic: false } }))).toEqual([]);
  });
  it(`suggests Learning after ${LEARNING_OFF_MIN_REASONS} thumbs with reasons, owner only`, () => {
    const learning = (feedbackReasons: number, isOwner = true, learningEnabled = false) =>
      kinds(facts({ isOwner, learningEnabled, feedbackReasons }));
    expect(learning(LEARNING_OFF_MIN_REASONS - 1)).toEqual([]);
    expect(learning(LEARNING_OFF_MIN_REASONS)).toEqual(["learning-off"]);
    expect(learning(LEARNING_OFF_MIN_REASONS + 5, false)).toEqual([]);
    expect(learning(LEARNING_OFF_MIN_REASONS + 5, true, true)).toEqual([]);
  });
});

describe("approvals you always give", () => {
  const approvals = (count: number, tool = "notion_update_page", at = hoursAgo(2)) =>
    Array.from({ length: count }, () => ({ botId: "coder", tool, decision: "allow" as const, at }));
  it(`needs ${APPROVAL_MIN_COUNT} approvals in ${APPROVAL_WINDOW_DAYS} days and no denials`, () => {
    expect(kinds(facts({ approvals: approvals(APPROVAL_MIN_COUNT - 1) }))).toEqual([]);
    const [insight] = computeInsights(facts({ approvals: approvals(12) }));
    expect(insight).toMatchObject({
      kind: "approval",
      evidence: { botName: "Coder", tool: "notion_update_page", approvals: 12, days: 7 },
      action: { kind: "approval-rule", botId: "coder", tool: "notion_update_page" },
    });
    expect(
      kinds(
        facts({
          approvals: [
            ...approvals(6),
            { botId: "coder", tool: "notion_update_page", decision: "deny", at: hoursAgo(1) },
          ],
        }),
      ),
    ).toEqual([]);
    expect(kinds(facts({ approvals: approvals(6, "notion_update_page", daysAgo(8)) }))).toEqual([]);
  });
  it("skips actions that already have a rule", () => {
    expect(
      kinds(
        facts({
          approvals: approvals(6),
          allowRules: [{ botId: null, tool: "notion_update_page" }],
        }),
      ),
    ).toEqual([]);
  });
  it("never suggests secrets, payments, messages or commands", () => {
    for (const tool of [
      "secret_request",
      "stripe_create_refund",
      "shopify_list_orders",
      "gmail_send_email",
      "slack_chat_post_message",
      "destination.write",
      "shell",
      "host_run_command",
      "create_space",
    ]) {
      expect(approvalInsightAllowed(tool), tool).toBe(false);
      expect(kinds(facts({ approvals: approvals(9, tool) })), tool).toEqual([]);
    }
    expect(approvalInsightAllowed("notion_update_page")).toBe(true);
    expect(approvalInsightAllowed("cloud_agent_launch")).toBe(true);
  });
});

describe("repeated work that could be a routine", () => {
  const prompts = (count: number, at = (i: number) => hoursAgo(i + 1)) =>
    Array.from({ length: count }, (_, i) => ({
      botId: "coder",
      text: `Summarize open PRs from ${20 + i} September`,
      at: at(i),
    }));
  it(`needs ${ROUTINE_MIN_COUNT} of the same request in ${ROUTINE_WINDOW_DAYS} days`, () => {
    expect(kinds(facts({ prompts: prompts(ROUTINE_MIN_COUNT - 1) }))).toEqual([]);
    const [insight] = computeInsights(facts({ prompts: prompts(ROUTINE_MIN_COUNT + 1) }));
    expect(insight).toMatchObject({
      kind: "routine",
      evidence: { botName: "Coder", count: 4, prompt: "Summarize open PRs from 20 September" },
      action: { kind: "routine", botId: "coder", prompt: "Summarize open PRs from 20 September" },
    });
    expect(
      kinds(
        facts({ prompts: prompts(ROUTINE_MIN_COUNT, (i) => daysAgo(ROUTINE_WINDOW_DAYS + i)) }),
      ),
    ).toEqual([]);
  });
  it("ignores short replies and requests that already have a routine", () => {
    const short = Array.from({ length: 5 }, (_, i) => ({
      botId: "coder",
      text: "Continue",
      at: hoursAgo(i),
    }));
    expect(kinds(facts({ prompts: short }))).toEqual([]);
    expect(
      kinds(
        facts({
          prompts: prompts(4),
          routines: [{ botId: "coder", prompt: "summarize open PRs from 1 september" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("ordering and dismissal", () => {
  it("puts failing work first", () => {
    const input = facts({
      isOwner: true,
      memory: { documents: 400, bytes: 1, semantic: false },
      approvals: Array.from({ length: 5 }, () => ({
        botId: "coder",
        tool: "notion_update_page",
        decision: "allow" as const,
        at: hoursAgo(1),
      })),
      bots: [
        { id: "coder", name: "Coder", pin: gpt },
        { id: "local", name: "Local", pin: llama },
      ],
      runs: runs(5, { botId: "local", pin: llama, status: "failed", failure: "context" }),
    });
    const ordered = computeInsights(input);
    expect(ordered.map((insight) => insight.kind)).toEqual([
      "repeated-failure",
      "approval",
      "memory-search",
    ]);
    expect(insightImpact(ordered[0]!.evidence)).toBeGreaterThan(
      insightImpact(ordered[1]!.evidence),
    );
  });

  const computed = (approvals: number, tool = "notion_update_page") =>
    computeInsights(
      facts({
        approvals: Array.from({ length: approvals }, () => ({
          botId: "coder",
          tool,
          decision: "allow" as const,
          at: hoursAgo(1),
        })),
      }),
    );
  const stored = (status: StoredInsight["status"], approvals: number, expiresInDays = 30) => {
    const [insight] = computed(approvals);
    return {
      id: "row",
      fingerprint: insight!.fingerprint,
      status,
      evidence: insight!.evidence,
      expiresAt: daysAgo(-expiresInDays),
    } satisfies StoredInsight;
  };
  it("creates, refreshes and expires", () => {
    expect(reconcileInsights([], computed(6), now)).toMatchObject([{ op: "create" }]);
    expect(reconcileInsights([stored("active", 6)], computed(7), now)).toMatchObject([
      { op: "refresh", id: "row" },
    ]);
    expect(reconcileInsights([stored("active", 6)], [], now)).toEqual([
      { op: "expire", id: "row" },
    ]);
    expect(reconcileInsights([stored("expired", 6)], computed(6), now)).toMatchObject([
      { op: "reopen" },
    ]);
  });
  it("keeps a dismissed insight hidden until its count doubles", () => {
    expect(reconcileInsights([stored("dismissed", 6)], computed(11), now)).toEqual([]);
    expect(reconcileInsights([stored("dismissed", 6)], computed(12), now)).toMatchObject([
      { op: "reopen", id: "row" },
    ]);
    expect(reconcileInsights([stored("acted", 6)], computed(8), now)).toEqual([]);
    expect(reconcileInsights([stored("dismissed", 6, -1)], computed(6), now)).toMatchObject([
      { op: "reopen" },
    ]);
  });
  it("treats a different suggestion as a new insight", () => {
    const dismissed = stored("dismissed", 6);
    const other = computed(6, "linear_update_issue");
    expect(reconcileInsights([dismissed], other, now)).toMatchObject([{ op: "create" }]);
  });
});
