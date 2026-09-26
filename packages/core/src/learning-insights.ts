import type {
  InsightAction,
  InsightEvidence,
  InsightModel,
  InsightModelRow,
  InsightTaskKind,
} from "@ardurbot/contracts";
import { connectorKindFromToolName } from "./action-approval.js";

const DAY_MS = 86_400_000;

/** Runs older than this never count toward model comparisons or failure streaks. */
export const INSIGHT_RUN_WINDOW_DAYS = 30;
/** Each compared model or effort needs this many finished runs of one task kind. */
export const MODEL_CHOICE_MIN_RUNS = 5;
/** A completion rate this much higher (as a fraction) counts as materially better. */
export const MODEL_CHOICE_COMPLETION_GAP = 0.25;
/** …and only when the other model failed at least this many runs. */
export const MODEL_CHOICE_MIN_OTHER_FAILURES = 3;
/** "Matched": completion and thumbs-down rates within this fraction of each other. */
export const MODEL_CHOICE_MATCH_TOLERANCE = 0.05;
/** "Clearly lower": the median tokens or time is at most this fraction of the other's. */
export const MODEL_CHOICE_CLEARLY_LOWER = 0.6;
/** Rows shown in Details. */
export const MODEL_CHOICE_MAX_ROWS = 6;
/** The last this-many runs on one pin must fail the same way. */
export const FAILURE_STREAK_RUNS = 5;
/** Connection failures are counted over this window. */
export const CONNECTION_WINDOW_DAYS = 14;
/** Runs that failed on a rejected or missing connection before it is worth saying. */
export const CONNECTION_MIN_FAILED_RUNS = 2;
/** More than this many personal memory documents, or more than this many bytes of them. */
export const MEMORY_SEARCH_MIN_DOCUMENTS = 50;
export const MEMORY_SEARCH_MIN_BYTES = 32 * 1024;
/** Thumbs with reasons, while Learning is off. */
export const LEARNING_OFF_WINDOW_DAYS = 14;
export const LEARNING_OFF_MIN_REASONS = 3;
/** The same action approved for the same bot, with no denials. */
export const APPROVAL_WINDOW_DAYS = 7;
export const APPROVAL_MIN_COUNT = 5;
/** The same request sent to the same bot. */
export const ROUTINE_WINDOW_DAYS = 14;
export const ROUTINE_MIN_COUNT = 3;
/** Shorter normalized requests ("ok", "continue") are replies, not repeated work. */
export const ROUTINE_MIN_PROMPT_CHARS = 12;
export const ROUTINE_MAX_PROMPT_CHARS = 4000;
/** Shown at once, highest impact first. */
export const MAX_ACTIVE_INSIGHTS = 5;
/** An active insight lapses unless a pass confirms it again. */
export const INSIGHT_ACTIVE_TTL_DAYS = 2;
/** A dismissed or used insight stays hidden this long unless its evidence changes. */
export const INSIGHT_SUPPRESSION_DAYS = 90;
/** Evidence changes materially when its count at least doubles. */
export const INSIGHT_MATERIAL_FACTOR = 2;

export type InsightFailure =
  | "tools"
  | "context"
  | "rate-limit"
  | "credential"
  | "missing-credential"
  | "other";

export interface InsightPin {
  runtimeKind: string;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
  credentialId: string | null;
}

export interface InsightRunFact {
  id: string;
  botId: string;
  trigger: string;
  board: boolean;
  status: string;
  at: Date;
  durationMs: number | null;
  pin: InsightPin | null;
  tools: string[];
  /** Null when no usage was recorded. */
  tokens: number | null;
  /** Null unless every usage record was priced with provenance. */
  cost: number | null;
  thumbsUp: boolean;
  thumbsDown: boolean;
  failure: InsightFailure | null;
}

export interface InsightModelFact {
  label: string;
  local: boolean;
  /** This space can run it now: a working connection or local runtime. */
  available: boolean;
  contextWindow?: number;
}

export interface InsightFacts {
  now: Date;
  isOwner: boolean;
  /** `allowed` lists model keys the bot's locality policy permits; null permits any. */
  bots: Array<{ id: string; name: string; pin: InsightPin | null; allowed?: string[] | null }>;
  runs: InsightRunFact[];
  models: Record<string, InsightModelFact>;
  credentials: Array<{ id: string; provider: string; label: string }>;
  /** Display names for providers, for connections that do not exist yet. */
  providerNames: Record<string, string>;
  memory: { documents: number; bytes: number; semantic: boolean };
  learningEnabled: boolean;
  /** Thumbs with a nonempty reason, not retracted, in the learning-off window. */
  feedbackReasons: number;
  approvals: Array<{ botId: string; tool: string; decision: "allow" | "deny"; at: Date }>;
  /** Existing always-allow tool rules; null botId applies to every bot. */
  allowRules: Array<{ botId: string | null; tool: string }>;
  prompts: Array<{ botId: string; text: string; at: Date }>;
  routines: Array<{ botId: string; prompt: string }>;
}

export interface ComputedInsight {
  kind: InsightEvidence["kind"];
  botId: string | null;
  fingerprint: string;
  evidence: InsightEvidence;
  action: InsightAction;
}

const CODING_TOOLS = new Set([
  "shell",
  "write_file",
  "edit_file",
  "apply_patch",
  "bash",
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "commandexecution",
  "filechange",
]);
const RESEARCH_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "websearch",
  "webfetch",
]);

/** Coarse and deterministic: the trigger first, then what the run's tools did. */
export function insightTaskKind(run: Pick<InsightRunFact, "trigger" | "board" | "tools">) {
  if (run.board || run.trigger === "routine") return "routine" satisfies InsightTaskKind;
  const tools = run.tools.map((tool) => tool.toLowerCase());
  if (tools.some((tool) => CODING_TOOLS.has(tool))) return "coding" satisfies InsightTaskKind;
  if (tools.some((tool) => RESEARCH_TOOLS.has(tool) || tool.startsWith("browser_")))
    return "research" satisfies InsightTaskKind;
  if (!tools.length) return "conversation" satisfies InsightTaskKind;
  // Other tools alone (memory, messages, connectors) are not one of the compared classes.
  return null;
}

/** Deterministic failure classes from the recorded error sentence and typed failure payload. */
export function insightFailureClass(error: string | null, payload: unknown): InsightFailure {
  const typed = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const problem = typed.runtimeProblem as { code?: unknown } | undefined;
  if (problem?.code === "pin-credential-missing") return "missing-credential";
  if (typed.providerErrorKind === "auth") return "credential";
  if (typed.providerErrorKind === "rate-limit") return "rate-limit";
  const text = error ?? "";
  if (
    /\b(?:does not|doesn't|do not|cannot|can't) support (?:tools|tool[ _-]?(?:use|calling|calls)|function[ _-]?calling)\b|\b(?:tools?|tool[ _-]?(?:use|calling|calls)|function[ _-]?calling) (?:is |are )?not supported\b/i.test(
      text,
    )
  )
    return "tools";
  if (
    /context[ _-]?(?:length|window)[ _-]?exceeded|exceeds? the (?:model'?s? )?(?:maximum )?context|maximum context length|prompt is too long|input is too long|too many tokens|context window/i.test(
      text,
    )
  )
    return "context";
  if (/\b(rate limit|rate-limited|too many requests|quota exceeded)\b/i.test(text))
    return "rate-limit";
  if (
    /\b(unauthorized|invalid api key|expired token|token expired|credential rejected)\b/i.test(text)
  )
    return "credential";
  return "other";
}

export function insightModelKey(pin: InsightPin | null): string | null {
  if (!pin?.modelId) return null;
  return [pin.runtimeKind, pin.provider ?? "", pin.modelId, pin.effort ?? ""].join("|");
}

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAYS =
  "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|yesterday";

/** Trimmed, case-folded, whitespace collapsed, with numbers and dates masked. */
export function normalizeInsightPrompt(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(new RegExp(`\\b(?:${MONTHS}|${WEEKDAYS})\\b`, "g"), "#")
    .replace(/\d+(?:[./:-]\d+)*(?:st|nd|rd|th)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Short, stable, not secret: two FNV-1a passes over the key. */
export function insightFingerprint(parts: readonly (string | null | undefined)[]): string {
  const key = JSON.stringify(parts.map((part) => part ?? ""));
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${parts[0] ?? "insight"}:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** The count a dismissal is measured against. */
export function insightMagnitude(evidence: InsightEvidence): number {
  switch (evidence.kind) {
    case "model-choice":
    case "connection":
      return evidence.runs;
    case "repeated-failure":
      return evidence.streak;
    case "memory-search":
      return evidence.documents;
    case "learning-off":
      return evidence.reasons;
    case "approval":
      return evidence.approvals;
    case "routine":
      return evidence.count;
  }
}

const KIND_IMPACT: Record<InsightEvidence["kind"], number> = {
  "repeated-failure": 600,
  connection: 500,
  "model-choice": 400,
  approval: 300,
  routine: 200,
  "memory-search": 150,
  "learning-off": 100,
};

/** Work that is failing first, then quality and time saved, then setup. */
export function insightImpact(evidence: InsightEvidence): number {
  return KIND_IMPACT[evidence.kind] + Math.min(99, insightMagnitude(evidence));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(
    sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
  );
}

function finished(run: InsightRunFact) {
  return run.status === "completed" || run.status === "failed";
}

function sinceDays(now: Date, days: number) {
  return now.getTime() - days * DAY_MS;
}

interface ModelStats {
  key: string;
  completed: number;
  failed: number;
  total: number;
  thumbsUp: number;
  thumbsDown: number;
  durations: number[];
  tokens: number[];
  costs: number[];
  unpriced: boolean;
}

/** Suggest only what this bot can run now: available, and inside its locality policy. */
function usable(facts: InsightFacts, bot: InsightFacts["bots"][number], key: string) {
  return !!facts.models[key]?.available && (!bot.allowed || bot.allowed.includes(key));
}

function modelView(facts: InsightFacts, key: string): InsightModel {
  const model = facts.models[key];
  return { key, label: model?.label ?? key.split("|")[2] ?? key, local: model?.local ?? false };
}

function row(facts: InsightFacts, stats: ModelStats): InsightModelRow {
  return {
    model: modelView(facts, stats.key),
    completed: stats.completed,
    total: stats.total,
    thumbsUp: stats.thumbsUp,
    thumbsDown: stats.thumbsDown,
    medianMs: median(stats.durations),
    medianTokens: median(stats.tokens),
    costUsd:
      stats.unpriced || !stats.costs.length
        ? null
        : Math.round(stats.costs.reduce((sum, cost) => sum + cost, 0) * 1e6) / 1e6,
  };
}

function statsByTask(runs: InsightRunFact[]) {
  const byTask = new Map<InsightTaskKind, Map<string, ModelStats>>();
  for (const run of runs) {
    const task = insightTaskKind(run);
    const key = insightModelKey(run.pin);
    if (!task || !key) continue;
    const models = byTask.get(task) ?? new Map<string, ModelStats>();
    byTask.set(task, models);
    const stats = models.get(key) ?? {
      key,
      completed: 0,
      failed: 0,
      total: 0,
      thumbsUp: 0,
      thumbsDown: 0,
      durations: [],
      tokens: [],
      costs: [],
      unpriced: false,
    };
    models.set(key, stats);
    stats.total += 1;
    if (run.status === "completed") {
      stats.completed += 1;
      if (run.durationMs !== null) stats.durations.push(run.durationMs);
      if (run.tokens !== null) stats.tokens.push(run.tokens);
      if (run.cost === null) stats.unpriced = true;
      else stats.costs.push(run.cost);
    } else stats.failed += 1;
    if (run.thumbsUp) stats.thumbsUp += 1;
    if (run.thumbsDown) stats.thumbsDown += 1;
  }
  return byTask;
}

type Variant = "completion" | "local" | "tokens" | "time";

/** Why `a` is worth suggesting over `b`, if it is, with a strength for picking one. */
export function modelChoiceVariant(
  a: Pick<ModelStats, "completed" | "total" | "thumbsDown"> & {
    medianTokens: number | null;
    medianMs: number | null;
    local: boolean;
  },
  b: Pick<ModelStats, "completed" | "failed" | "total" | "thumbsDown"> & {
    medianTokens: number | null;
    medianMs: number | null;
    local: boolean;
  },
): { variant: Variant; strength: number } | null {
  if (a.total < MODEL_CHOICE_MIN_RUNS || b.total < MODEL_CHOICE_MIN_RUNS) return null;
  const rateA = a.completed / a.total;
  const rateB = b.completed / b.total;
  const gap = rateA - rateB;
  // Rates are ratios of small counts; compare with a hair of tolerance for float noise.
  if (gap >= MODEL_CHOICE_COMPLETION_GAP - 1e-9 && b.failed >= MODEL_CHOICE_MIN_OTHER_FAILURES)
    return { variant: "completion", strength: 3 + gap };
  const matched =
    rateA >= rateB - MODEL_CHOICE_MATCH_TOLERANCE &&
    a.thumbsDown / a.total <= b.thumbsDown / b.total + MODEL_CHOICE_MATCH_TOLERANCE;
  if (!matched) return null;
  if (a.local && !b.local) return { variant: "local", strength: 2 };
  const lower = (x: number | null, y: number | null) =>
    x !== null && y !== null && y > 0 && x <= y * MODEL_CHOICE_CLEARLY_LOWER ? 1 - x / y : null;
  const tokens = lower(a.medianTokens, b.medianTokens);
  const time = lower(a.medianMs, b.medianMs);
  if (tokens !== null && (time === null || tokens >= time))
    return { variant: "tokens", strength: 1 + tokens };
  if (time !== null) return { variant: "time", strength: 1 + time };
  return null;
}

function modelChoice(facts: InsightFacts, recent: InsightRunFact[]): ComputedInsight[] {
  const out: ComputedInsight[] = [];
  const seen = new Set<string>();
  for (const [task, models] of statsByTask(recent)) {
    const qualified = [...models.values()].filter((s) => s.total >= MODEL_CHOICE_MIN_RUNS);
    if (qualified.length < 2) continue;
    const taskRuns = [...models.values()].reduce((sum, s) => sum + s.total, 0);
    const candidates: Array<{
      bot: InsightFacts["bots"][number];
      a: ModelStats;
      b: ModelStats;
      variant: Variant;
      strength: number;
      botRuns: number;
    }> = [];
    for (const bot of facts.bots) {
      const current = insightModelKey(bot.pin);
      const b = qualified.find((s) => s.key === current);
      if (!b) continue;
      const botRuns = recent.filter(
        (run) =>
          run.botId === bot.id &&
          insightTaskKind(run) === task &&
          insightModelKey(run.pin) === b.key,
      ).length;
      if (!botRuns) continue;
      for (const a of qualified) {
        if (a.key === b.key || !usable(facts, bot, a.key)) continue;
        const rowA = row(facts, a);
        const rowB = row(facts, b);
        const choice = modelChoiceVariant(
          {
            ...a,
            medianTokens: rowA.medianTokens,
            medianMs: rowA.medianMs,
            local: rowA.model.local,
          },
          {
            ...b,
            medianTokens: rowB.medianTokens,
            medianMs: rowB.medianMs,
            local: rowB.model.local,
          },
        );
        if (choice) candidates.push({ bot, a, b, ...choice, botRuns });
      }
    }
    candidates.sort((x, y) => y.strength - x.strength || y.botRuns - x.botRuns);
    for (const candidate of candidates) {
      // One insight per comparison, on the bot that used the weaker choice most.
      const pair = `${task}|${candidate.a.key}|${candidate.b.key}`;
      if (seen.has(pair) || seen.has(`${task}|${candidate.bot.id}`)) continue;
      seen.add(pair);
      seen.add(`${task}|${candidate.bot.id}`);
      out.push({
        kind: "model-choice",
        botId: candidate.bot.id,
        fingerprint: insightFingerprint([
          "model-choice",
          task,
          candidate.bot.id,
          candidate.a.key,
          candidate.b.key,
          candidate.variant,
        ]),
        evidence: {
          kind: "model-choice",
          variant: candidate.variant,
          taskKind: task,
          botName: candidate.bot.name,
          better: modelView(facts, candidate.a.key),
          other: modelView(facts, candidate.b.key),
          rows: [...models.values()]
            .sort((x, y) => y.total - x.total || x.key.localeCompare(y.key))
            .slice(0, MODEL_CHOICE_MAX_ROWS)
            .map((stats) => row(facts, stats)),
          runs: taskRuns,
          days: INSIGHT_RUN_WINDOW_DAYS,
        },
        action: { kind: "bot-model", botId: candidate.bot.id },
      });
    }
  }
  return out;
}

const STREAK_FAILURES = new Set<InsightFailure>(["tools", "context", "rate-limit", "credential"]);

function repeatedFailures(
  facts: InsightFacts,
  recent: InsightRunFact[],
  connectionIssues: Set<string>,
): ComputedInsight[] {
  const out: ComputedInsight[] = [];
  for (const bot of facts.bots) {
    const key = insightModelKey(bot.pin);
    if (!key) continue;
    const runs = recent
      .filter((run) => run.botId === bot.id && finished(run) && insightModelKey(run.pin) === key)
      .sort((x, y) => y.at.getTime() - x.at.getTime());
    const failure = runs[0]?.failure;
    if (runs[0]?.status !== "failed" || !failure || !STREAK_FAILURES.has(failure)) continue;
    let streak = 0;
    while (
      streak < runs.length &&
      runs[streak]!.status === "failed" &&
      runs[streak]!.failure === failure
    )
      streak += 1;
    if (streak < FAILURE_STREAK_RUNS) continue;
    const pin = bot.pin!;
    if (failure === "credential" && pin.credentialId && connectionIssues.has(pin.credentialId))
      continue;
    const completedElsewhere = (predicate: (run: InsightRunFact) => boolean) => {
      const counts = new Map<string, number>();
      for (const run of recent) {
        const other = insightModelKey(run.pin);
        if (!other || other === key || run.status !== "completed" || !predicate(run)) continue;
        if (!usable(facts, bot, other)) continue;
        counts.set(other, (counts.get(other) ?? 0) + 1);
      }
      return [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    };
    let suggested: [string, number] | undefined;
    let contextWindows: { contextWindow?: number; suggestedContextWindow?: number } = {};
    if (failure === "tools") suggested = completedElsewhere((run) => run.tools.length > 0);
    else if (failure === "rate-limit")
      suggested = completedElsewhere((run) => (run.pin?.provider ?? "") !== (pin.provider ?? ""));
    else if (failure === "context") {
      const current = facts.models[key]?.contextWindow;
      const larger = Object.entries(facts.models)
        .filter(
          ([other, model]) =>
            other !== key &&
            usable(facts, bot, other) &&
            current !== undefined &&
            model.contextWindow !== undefined &&
            model.contextWindow > current,
        )
        .sort((x, y) => y[1].contextWindow! - x[1].contextWindow! || x[0].localeCompare(y[0]))[0];
      if (larger) {
        suggested = [larger[0], 0];
        contextWindows = {
          contextWindow: current,
          suggestedContextWindow: larger[1].contextWindow,
        };
      }
    }
    out.push({
      kind: "repeated-failure",
      botId: bot.id,
      fingerprint: insightFingerprint(["repeated-failure", bot.id, key, failure, suggested?.[0]]),
      evidence: {
        kind: "repeated-failure",
        failure: failure as "tools" | "context" | "rate-limit" | "credential",
        botName: bot.name,
        model: modelView(facts, key),
        streak,
        suggested: suggested ? modelView(facts, suggested[0]) : null,
        ...(suggested && failure !== "context" ? { suggestedRuns: suggested[1] } : {}),
        ...contextWindows,
        runs: runs.length,
        days: INSIGHT_RUN_WINDOW_DAYS,
      },
      action:
        failure === "credential" && !suggested && pin.provider
          ? {
              kind: "connection",
              provider: pin.provider,
              ...(pin.credentialId ? { credentialId: pin.credentialId } : {}),
            }
          : { kind: "bot-model", botId: bot.id },
    });
  }
  return out;
}

function connections(facts: InsightFacts, runs: InsightRunFact[]): ComputedInsight[] {
  const out: ComputedInsight[] = [];
  const since = sinceDays(facts.now, CONNECTION_WINDOW_DAYS);
  const window = runs.filter((run) => run.at.getTime() >= since);
  for (const credential of facts.credentials) {
    const onCredential = runs.filter((run) => run.pin?.credentialId === credential.id);
    const lastWorked = Math.max(
      0,
      ...onCredential.filter((run) => run.status === "completed").map((run) => run.at.getTime()),
    );
    const rejected = window.filter(
      (run) =>
        run.pin?.credentialId === credential.id &&
        run.status === "failed" &&
        run.failure === "credential" &&
        run.at.getTime() > lastWorked,
    ).length;
    if (rejected < CONNECTION_MIN_FAILED_RUNS) continue;
    out.push({
      kind: "connection",
      botId: null,
      fingerprint: insightFingerprint(["connection", "rejected", credential.id]),
      evidence: {
        kind: "connection",
        problem: "rejected",
        connection: credential.label || credential.provider,
        runs: rejected,
        days: CONNECTION_WINDOW_DAYS,
      },
      action: { kind: "connection", provider: credential.provider, credentialId: credential.id },
    });
  }
  const connected = new Set(facts.credentials.map((credential) => credential.provider));
  const missing = new Map<string, number>();
  for (const run of window) {
    const provider = run.pin?.provider;
    if (run.failure !== "missing-credential" || run.pin?.runtimeKind !== "pi" || !provider)
      continue;
    if (connected.has(provider)) continue;
    missing.set(provider, (missing.get(provider) ?? 0) + 1);
  }
  for (const [provider, count] of missing) {
    if (count < CONNECTION_MIN_FAILED_RUNS) continue;
    out.push({
      kind: "connection",
      botId: null,
      fingerprint: insightFingerprint(["connection", "missing", provider]),
      evidence: {
        kind: "connection",
        problem: "missing",
        connection: facts.providerNames[provider] ?? provider,
        runs: count,
        days: CONNECTION_WINDOW_DAYS,
      },
      action: { kind: "connection", provider },
    });
  }
  return out;
}

function setup(facts: InsightFacts): ComputedInsight[] {
  if (!facts.isOwner) return [];
  const out: ComputedInsight[] = [];
  const { documents, bytes, semantic } = facts.memory;
  if (!semantic && (documents > MEMORY_SEARCH_MIN_DOCUMENTS || bytes > MEMORY_SEARCH_MIN_BYTES))
    out.push({
      kind: "memory-search",
      botId: null,
      fingerprint: insightFingerprint(["memory-search"]),
      evidence: { kind: "memory-search", documents, bytes },
      action: { kind: "memory-settings" },
    });
  if (!facts.learningEnabled && facts.feedbackReasons >= LEARNING_OFF_MIN_REASONS)
    out.push({
      kind: "learning-off",
      botId: null,
      fingerprint: insightFingerprint(["learning-off"]),
      evidence: {
        kind: "learning-off",
        reasons: facts.feedbackReasons,
        days: LEARNING_OFF_WINDOW_DAYS,
      },
      action: { kind: "learning-settings" },
    });
  return out;
}

const PAYMENT_CONNECTORS = new Set(["stripe", "shopify", "paypal", "square"]);
const MESSAGE_CONNECTORS = new Set([
  "gmail",
  "outlook",
  "microsoft_outlook",
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "twilio",
  "teams",
  "microsoft_teams",
  "sms",
  "linkedin",
  "twitter",
  "x",
]);

/**
 * Never suggested: secret access, payments, messages sent on the person's behalf, and commands
 * or writes outside a bot's own folders. Conservative by name, so unknown shapes stay excluded.
 */
export function approvalInsightAllowed(tool: string): boolean {
  const name = tool.toLowerCase();
  const connector = connectorKindFromToolName(name);
  if (/secret|credential|password|passwd|token|oauth|api_?key/.test(name)) return false;
  if (PAYMENT_CONNECTORS.has(connector)) return false;
  if (/purchase|pay(?:ment)?|charge|checkout|buy|invoice|refund|payout|transfer|subscri/.test(name))
    return false;
  if (MESSAGE_CONNECTORS.has(connector)) return false;
  if (
    /send|reply|post|forward|message|mail|publish|invite|share|tweet|comment|notify|dm\b/.test(name)
  )
    return false;
  if (/shell|command|exec|terminal|host|script|ssh|run_code|destination|create_space/.test(name))
    return false;
  return true;
}

function approvals(facts: InsightFacts): ComputedInsight[] {
  const since = sinceDays(facts.now, APPROVAL_WINDOW_DAYS);
  const groups = new Map<string, { botId: string; tool: string; allow: number; deny: number }>();
  for (const approval of facts.approvals) {
    if (approval.at.getTime() < since) continue;
    const key = JSON.stringify([approval.botId, approval.tool]);
    const group = groups.get(key) ?? {
      botId: approval.botId,
      tool: approval.tool,
      allow: 0,
      deny: 0,
    };
    groups.set(key, group);
    group[approval.decision] += 1;
  }
  const out: ComputedInsight[] = [];
  for (const group of groups.values()) {
    if (group.allow < APPROVAL_MIN_COUNT || group.deny > 0) continue;
    if (!approvalInsightAllowed(group.tool)) continue;
    const bot = facts.bots.find((candidate) => candidate.id === group.botId);
    if (!bot) continue;
    if (
      facts.allowRules.some(
        (rule) =>
          rule.tool.toLowerCase() === group.tool.toLowerCase() &&
          (rule.botId === null || rule.botId === group.botId),
      )
    )
      continue;
    out.push({
      kind: "approval",
      botId: bot.id,
      fingerprint: insightFingerprint(["approval", bot.id, group.tool]),
      evidence: {
        kind: "approval",
        botName: bot.name,
        tool: group.tool,
        approvals: group.allow,
        days: APPROVAL_WINDOW_DAYS,
      },
      action: { kind: "approval-rule", botId: bot.id, tool: group.tool },
    });
  }
  return out;
}

function routines(facts: InsightFacts): ComputedInsight[] {
  const since = sinceDays(facts.now, ROUTINE_WINDOW_DAYS);
  const existing = new Set(
    facts.routines.map((routine) =>
      JSON.stringify([routine.botId, normalizeInsightPrompt(routine.prompt)]),
    ),
  );
  const groups = new Map<
    string,
    { botId: string; normalized: string; latest: { text: string; at: Date }; count: number }
  >();
  for (const prompt of facts.prompts) {
    if (prompt.at.getTime() < since) continue;
    const normalized = normalizeInsightPrompt(prompt.text);
    if (normalized.replace(/[#\s]/g, "").length < ROUTINE_MIN_PROMPT_CHARS) continue;
    const key = JSON.stringify([prompt.botId, normalized]);
    if (existing.has(key)) continue;
    const group = groups.get(key) ?? { botId: prompt.botId, normalized, latest: prompt, count: 0 };
    groups.set(key, group);
    group.count += 1;
    if (prompt.at >= group.latest.at) group.latest = prompt;
  }
  const out: ComputedInsight[] = [];
  for (const group of groups.values()) {
    if (group.count < ROUTINE_MIN_COUNT) continue;
    const bot = facts.bots.find((candidate) => candidate.id === group.botId);
    if (!bot) continue;
    const prompt = group.latest.text.trim().slice(0, ROUTINE_MAX_PROMPT_CHARS);
    out.push({
      kind: "routine",
      botId: bot.id,
      fingerprint: insightFingerprint(["routine", bot.id, group.normalized]),
      evidence: {
        kind: "routine",
        botName: bot.name,
        prompt,
        count: group.count,
        days: ROUTINE_WINDOW_DAYS,
      },
      action: { kind: "routine", botId: bot.id, prompt },
    });
  }
  return out;
}

/** Every insight this person's own recorded facts support right now. Pure and deterministic. */
export function computeInsights(facts: InsightFacts): ComputedInsight[] {
  const since = sinceDays(facts.now, INSIGHT_RUN_WINDOW_DAYS);
  const recent = facts.runs.filter((run) => run.at.getTime() >= since && finished(run));
  const connectionInsights = connections(facts, recent);
  const issues = new Set(
    connectionInsights.flatMap((insight) =>
      insight.action.kind === "connection" && insight.action.credentialId
        ? [insight.action.credentialId]
        : [],
    ),
  );
  return [
    ...repeatedFailures(facts, recent, issues),
    ...connectionInsights,
    ...modelChoice(facts, recent),
    ...approvals(facts),
    ...routines(facts),
    ...setup(facts),
  ].sort((x, y) => insightImpact(y.evidence) - insightImpact(x.evidence));
}

export interface StoredInsight {
  id: string;
  fingerprint: string;
  status: "active" | "dismissed" | "acted" | "expired";
  evidence: InsightEvidence;
  expiresAt: Date;
}

export type InsightChange =
  | { op: "create"; insight: ComputedInsight; expiresAt: Date }
  | { op: "refresh"; id: string; insight: ComputedInsight; expiresAt: Date }
  | { op: "reopen"; id: string; insight: ComputedInsight; expiresAt: Date }
  | { op: "expire"; id: string };

/**
 * Keeps one row per fingerprint. A dismissed or used insight stays hidden until its suppression
 * lapses or its count at least doubles; a different suggestion is a different fingerprint.
 */
export function reconcileInsights(
  stored: StoredInsight[],
  computed: ComputedInsight[],
  now: Date,
): InsightChange[] {
  const byFingerprint = new Map(stored.map((row) => [row.fingerprint, row]));
  const expiresAt = new Date(now.getTime() + INSIGHT_ACTIVE_TTL_DAYS * DAY_MS);
  const changes: InsightChange[] = [];
  const confirmed = new Set<string>();
  for (const insight of computed) {
    if (confirmed.has(insight.fingerprint)) continue;
    confirmed.add(insight.fingerprint);
    const row = byFingerprint.get(insight.fingerprint);
    if (!row) {
      changes.push({ op: "create", insight, expiresAt });
      continue;
    }
    if (row.status === "active") {
      changes.push({ op: "refresh", id: row.id, insight, expiresAt });
      continue;
    }
    if (row.status === "dismissed" || row.status === "acted") {
      const suppressed = row.expiresAt.getTime() > now.getTime();
      const doubled =
        insightMagnitude(insight.evidence) >=
        insightMagnitude(row.evidence) * INSIGHT_MATERIAL_FACTOR;
      if (suppressed && !doubled) continue;
    }
    changes.push({ op: "reopen", id: row.id, insight, expiresAt });
  }
  for (const row of stored)
    if (row.status === "active" && !confirmed.has(row.fingerprint))
      changes.push({ op: "expire", id: row.id });
  return changes;
}
