import type { TaskType } from "@ardurbot/contracts";
import { EFFORT_ROUTE_MIN_CONFIDENCE } from "@ardurbot/contracts";
import type { TaskClassification, TaskClassifier, TaskClassifierInput } from "./classifier.js";
import { WORD_LISTS } from "./word-lists.js";

/**
 * The local, deterministic task classifier as a signal table. Each signal is one row: a
 * name, a test over the message, and the weight it adds to the task types it supports
 * (or subtracts through `rulesOut`). `decide` folds the table into scores, gates the
 * light routes on the absence of any sign of work, and answers `unknown` below the
 * confidence floor. Adding a signal is one entry here; nothing else changes.
 */

type Weights = Partial<Record<TaskType, number>>;

type SignalSpec = {
  readonly name: string;
  readonly test: (ctx: MessageContext) => boolean;
  readonly weights: Weights;
  readonly rulesOut?: readonly TaskType[];
  /** When this row fires, the named rows' weights are skipped. */
  readonly overrides?: readonly string[];
};

type MessageContext = {
  readonly text: string;
  readonly lower: string;
  readonly wordCount: number;
  readonly tokenCount: number;
  readonly fences: number;
  readonly stackTrace: boolean;
  readonly diff: boolean;
  readonly shell: boolean;
  readonly filePaths: number;
  readonly codeContext: boolean;
  readonly urls: number;
  readonly numberDensity: number;
  readonly tableRows: number;
  readonly sql: boolean;
  readonly question: boolean;
  readonly questionOpener: boolean;
  readonly httpErrorStatus: boolean;
  readonly httpErrorStatusVerbGated: boolean;
  readonly scriptCovered: boolean;
  readonly exceptionName: boolean;
  readonly capsStatus: boolean;
  readonly hasAttachments: boolean;
  readonly answersBotQuestion: boolean;
  readonly opensWithOpsVerb: boolean;
  readonly hits: Readonly<Record<keyof typeof WORD_LISTS, number>>;
};

/** Reading a message: structure first (it survives translation), then the word lists. */
function readContext(text: string, input: TaskClassifierInput): MessageContext {
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const numeric = tokens.filter((token) => /^[+-]?[\d.,]+%?$/.test(token)).length;
  const fenceMarkers = trimmed.match(/^[ \t]*(```|~~~)/gm)?.length ?? 0;
  const tableLineCount = trimmed.split("\n").filter((line) => /^\s*\|.*\|\s*$/.test(line)).length;
  const stackTrace =
    /\bat\s+.+\([^)]+:\d+:\d+\)/m.test(trimmed) ||
    trimmed.includes("Traceback (most recent call last)") ||
    /^\s*File "[^"]+", line \d+/m.test(trimmed) ||
    trimmed.includes("Caused by: ") ||
    trimmed.includes("Exception in thread");
  const filePaths = trimmed.match(/(^|\s|[([])(\/[\w.@-]+\/)+[\w.-]+\.[a-zA-Z]{1,5}/g)?.length ?? 0;
  const shell =
    /^\s*\$\s+\S+/m.test(trimmed) ||
    /^\s*>\s+\S+/m.test(trimmed) ||
    /\b(sudo|apt|apt-get|yum|brew|pip|pip3|kubectl|helm|systemctl|docker|terraform|aws|gcloud|curl|wget|chmod|mkdir)\s+\S+/.test(
      trimmed,
    );
  const lower = trimmed.toLowerCase();
  const masked = maskShorterSynonyms(lower);
  const hits = {} as Record<keyof typeof WORD_LISTS, number>;
  for (const name of Object.keys(WORD_LISTS) as (keyof typeof WORD_LISTS)[]) {
    hits[name] = countHits(masked, WORD_LISTS[name]);
  }
  const firstWords = lower
    .split(/[\s,:;]+/)
    .filter(Boolean)
    .slice(0, 6);
  return {
    text: trimmed,
    lower,
    wordCount: words(trimmed).length,
    tokenCount: tokens.length,
    fences: Math.floor(fenceMarkers / 2),
    stackTrace,
    diff: /^[-+]{3} /m.test(trimmed) || /^@@ /m.test(trimmed),
    shell,
    filePaths,
    codeContext: fenceMarkers >= 2 || shell || filePaths > 0,
    urls: trimmed.match(/https?:\/\/\S+/g)?.length ?? 0,
    numberDensity: tokens.length === 0 ? 0 : numeric / tokens.length,
    tableRows: tableLineCount >= 2 ? tableLineCount : 0,
    sql: /^select\s+.+\s+from\s+/im.test(trimmed),
    question:
      trimmed.includes("?") ||
      trimmed.includes("？") ||
      trimmed.includes("吗") ||
      trimmed.includes("क्या"),
    questionOpener: QUESTION_OPENERS.test(trimmed),
    httpErrorStatus: /(?:\b|: )(4\d\d|5\d\d)(?:\b|s\b)/.test(trimmed),
    httpErrorStatusVerbGated:
      /(?:\b|: )(4\d\d|5\d\d)(?:\b|s\b)/.test(trimmed) &&
      /\b(return|returns|returning|threw|throws|throwing|fail|fails|failing|failed|error|errors|crash|crashes|crashed|respond|responds|5xx|4xx|since|until|stopped|broke|broken)\b/i.test(
        trimmed,
      ),
    exceptionName: EXCEPTION_WORD.test(trimmed),
    capsStatus: CAPS_FAILURE.test(trimmed),
    hasAttachments: input.hasAttachments === true,
    answersBotQuestion: input.answersBotQuestion === true,
    opensWithOpsVerb:
      firstWords.some((word) => countHits(word, WORD_LISTS.opsVerb) > 0) &&
      firstWords.every((word) => countHits(word, WORD_LISTS.debugWord) === 0),
    scriptCovered: scriptCovered(trimmed),
    hits,
  };
}

const QUESTION_OPENERS =
  /^(¿?\s*["'“(]?)(what|when|where|who|why|how|which|whose|is|are|do|does|did|was|wie|wer|wo|wann|warum|welche|was|que|qué|cómo|dónde|cuándo|quién|cuál|comment|combien|où|qui|почему|что|как|где|когда|кто|сколько|什么|怎么|为什么|几|哪|何|なぜ|どう|누구|무엇|어떻게|언제|어디|몇|क्या|कैसे|क्यों|कहाँ|ఎందుకు|ఎలా|ఏమిటి)\b/i;

const EXCEPTION_WORD = /\b\p{Lu}\w*(Exception|Error|Fault|Failure)\b/u;

/** ECONNREFUSED, OOMKilled, ETIMEDOUT, SIGKILL: an all-caps token about failure. */
const CAPS_FAILURE = /\b([A-Z]{2,}[A-Za-z-]*|[A-Z][a-z]+[A-Z][A-Za-z]*)\b/;

const CAPS_FAILURE_FRAGMENTS =
  /(KILL|OOM|REFUS|RESET|BROKEN|PIPE|DEAD|DENIED|EXPIRED|OVERFLOW|CANCEL|ABORT|EXHAUST|UNREACH|TIMED|FAILED|DOWN|PANIC|BACKOFF|NOENT|NOSPC|ACCE|SCHEDUL|EVICT|TERMINAT|CRASH|LOOP)/;

const POLITE = /\b(please|pls|plz|bitte|por favor|お願い|请|s'il vous plaît)\b/u;

const ONSET_FRAME = /\b(since|after|ever since|following|depuis|seit|desde)\b/i;

function isCapsFailureToken(token: string): boolean {
  const shape = /^[A-Z]{2,}[A-Za-z-]*$/.test(token) || /^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(token);
  return shape && CAPS_FAILURE_FRAGMENTS.test(token.toUpperCase());
}

/**
 * A hit on a multiword needle ("error rate") means its shorter synonym ("error") did not
 * fire on its own: masking the shorter one keeps one mention from counting twice.
 */
const MASKED_SYNONYM_PAIRS: readonly (readonly [string, string])[] = [
  ["error rate", "error"],
  ["error rates", "error"],
  ["错误率", "错误"],
];

function maskShorterSynonyms(lower: string): string {
  let masked = lower;
  for (const [phrase, short] of MASKED_SYNONYM_PAIRS) {
    if (countPlain(masked, phrase) > 0) {
      masked = maskPlain(masked, short);
    }
  }
  return masked;
}

function countPlain(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function maskPlain(haystack: string, needle: string): string {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, "gu");
  return haystack.replace(pattern, (_match, before: string, after: string) => {
    const fill = " ".repeat(needle.length);
    return `${before}${fill}${after}`;
  });
}

/**
 * Scripts the word lists cover: any letters, numbers and punctuation, minus the script
 * blocks that have no rules of their own (Indic beyond Devanagari, Thai). A message in
 * an uncovered script must not borrow the light routes.
 */
function scriptCovered(text: string): boolean {
  if (/[\u0980-\u0c7f\u0e00-\u0e7f]/.test(text)) return false;
  return /^[\p{L}\p{N}\p{P}\p{Z}]+$/u.test(text);
}

function isCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHits(haystack: string, needles: readonly string[]): number {
  let count = 0;
  for (const needle of needles) {
    if (isCjk(needle)) {
      if (haystack.includes(needle)) count += 1;
      continue;
    }
    const suffix = needle.endsWith("s") ? "" : "(?:es|s)?";
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}${suffix}([^\\p{L}\\p{N}]|$)`,
      "u",
    );
    if (pattern.test(haystack)) count += 1;
  }
  return count;
}

/** Word count that survives scripts without spaces: one han character or kana run is a word. */
function words(text: string): string[] {
  const tokens: string[] = [];
  for (const piece of text.toLowerCase().split(/([\u3400-\u9fff]|[\u3040-\u30ff]+)/u)) {
    if (!piece) continue;
    if (/^[\u3400-\u9fff]$/.test(piece) || /^[\u3040-\u30ff]+$/.test(piece)) {
      tokens.push(piece);
      continue;
    }
    tokens.push(...piece.split(/[^\p{L}\p{N}']+/u).filter(Boolean));
  }
  return tokens;
}

/** The lists that ask for work. A hit from any of them disqualifies the light routes. */
const WORK_VERB_LISTS = [
  "opsVerb",
  "codeChangeVerb",
  "createVerb",
  "writingVerb",
  "dataVerb",
  "reviewVerb",
  "planWord",
  "researchWord",
  "summaryWord",
  "fix",
  "remediationPhrase",
] as const;

function workVerbHits(ctx: MessageContext): number {
  return WORK_VERB_LISTS.reduce((sum, name) => sum + ctx.hits[name], 0);
}

function anyWorkHit(ctx: MessageContext): boolean {
  if (ctx.hits.debugWord > 0 || ctx.hits.evidence > 0 || ctx.hits.fix > 0) return true;
  if (ctx.codeContext || ctx.hits.reviewObject > 0) return true;
  if (measurementAsk(ctx)) return true;
  if (asksAboutWork(ctx)) return false;
  return (
    workVerbHits(ctx) > 0 ||
    ctx.hits.dataNoun > 0 ||
    ctx.hits.codeArtifact > 0 ||
    ctx.hits.proseArtifact > 0
  );
}

/** True when the message carries a hard sign of a failure, whatever else it looks like. */
function strongFailure(ctx: MessageContext): boolean {
  return (
    ctx.stackTrace ||
    ctx.exceptionName ||
    ctx.httpErrorStatusVerbGated ||
    (ctx.httpErrorStatus && ctx.hits.debugWord > 0) ||
    isCapsFailure(ctx)
  );
}

/** A count, a share or a magnitude over data, as opposed to a fact about the world. */
function measurementAsk(ctx: MessageContext): boolean {
  if (!ctx.question && !ctx.questionOpener) return false;
  if (ctx.hits.quantityPhrase > 0 || ctx.hits.dataNoun > 0) {
    return (
      ctx.hasAttachments ||
      ctx.hits.temporalScope > 0 ||
      ctx.hits.dataNoun >= 2 ||
      ctx.hits.quantityPhrase >= 2 ||
      ctx.hits.debugWord > 0 ||
      ctx.hits.evidence > 0 ||
      (ctx.tokenCount >= 8 && ctx.numberDensity >= 0.3)
    );
  }
  return false;
}

/** A question about work ("how do I restart X?") quotes the verbs; it does not request them. */
function asksAboutWork(ctx: MessageContext): boolean {
  return ctx.questionOpener || /\bhow (do|can|should|did|does|to)\b/i.test(ctx.text);
}

function isCapsFailure(ctx: MessageContext): boolean {
  if (!CAPS_FAILURE.test(ctx.text)) return false;
  return ctx.text
    .split(/[^A-Za-z-]+/)
    .some((token) => token.length > 0 && isCapsFailureToken(token));
}

/**
 * The signal table. Weight units are rough confidence: a lone weak signal cannot clear
 * the 0.6 floor, two independent ones usually can, and the failure signals stand alone.
 */
const SIGNAL_TABLE: readonly SignalSpec[] = [
  {
    name: "stack trace",
    test: (c) => c.stackTrace,
    weights: { debugging: 0.95 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "exception name",
    test: (c) => c.exceptionName,
    weights: { debugging: 0.7 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "all-caps failure status",
    test: (c) => isCapsFailure(c),
    weights: { debugging: 0.7 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "http error status",
    test: (c) => c.httpErrorStatusVerbGated,
    weights: { debugging: 0.4 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "failure word",
    test: (c) => c.hits.debugWord > 0,
    weights: { debugging: 0.4 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "failure word repeated",
    test: (c) => c.hits.debugWord >= 2,
    weights: { debugging: 0.15 },
  },
  {
    name: "fix ask",
    test: (c) => c.hits.fix > 0,
    weights: { debugging: 0.5 },
  },
  {
    name: "evidence named",
    test: (c) => c.hits.evidence > 0,
    weights: { debugging: 0.2 },
  },
  {
    name: "onset frame (since/after a change)",
    test: (c) =>
      ONSET_FRAME.test(c.text) &&
      (c.hits.debugWord > 0 || c.httpErrorStatus || c.hits.evidence > 0 || c.hits.opsVerb > 0),
    weights: { debugging: 0.3 },
  },
  {
    name: "ops verb",
    test: (c) => c.hits.opsVerb > 0,
    weights: { operations: 0.3 },
  },
  {
    name: "ops verb inside a question",
    test: (c) => c.hits.opsVerb > 0 && c.questionOpener && !c.hits.remediationPhrase && !c.shell,
    weights: { operations: -0.55, "code-change": -0.15 },
  },
  {
    name: "infra named",
    test: (c) => c.hits.infra > 0,
    weights: { operations: 0.15, debugging: 0.1 },
  },
  {
    name: "ops verb on infra",
    test: (c) => c.hits.opsVerb > 0 && c.hits.infra > 0 && !c.questionOpener,
    weights: { operations: 0.35 },
    overrides: ["failure word", "infra named", "incident environment named with a failure"],
  },
  {
    name: "message opens with the ops ask",
    test: (c) => c.opensWithOpsVerb && !c.questionOpener,
    weights: { operations: 0.15 },
  },
  {
    name: "incident environment named with a failure",
    test: (c) =>
      countHits(c.lower, ["prod", "production", "staging", "outage"]) > 0 &&
      c.hits.debugWord > 0 &&
      c.hits.opsVerb === 0 &&
      c.hits.codeChangeVerb === 0,
    weights: { operations: 0.5 },
    overrides: ["failure word"],
  },
  {
    name: "remediation phrase",
    test: (c) => c.hits.remediationPhrase > 0,
    weights: { operations: 0.3 },
    overrides: ["fix ask"],
  },
  {
    name: "change verb",
    test: (c) => c.hits.codeChangeVerb > 0,
    weights: { "code-change": 0.3, operations: 0.05 },
  },
  {
    name: "create verb",
    test: (c) => c.hits.createVerb > 0,
    weights: { "code-change": 0.2, writing: 0.35, operations: 0.05 },
  },
  {
    name: "configuration value change",
    test: (c) =>
      (c.hits.codeChangeVerb > 0 || c.hits.opsVerb > 0) &&
      /\b(from \d+ to \d+|(?:to|a) \d+\b|=\s*\d+\b)/i.test(c.text),
    weights: { operations: 0.35 },
    overrides: ["code artifact named", "change verb"],
  },
  {
    name: "code artifact named",
    test: (c) => c.hits.codeArtifact > 0,
    weights: { "code-change": 0.2 },
  },
  {
    name: "change verb with no artifact named",
    test: (c) =>
      (c.hits.codeChangeVerb > 0 || c.hits.createVerb > 0) &&
      c.hits.codeArtifact === 0 &&
      c.hits.proseArtifact === 0 &&
      !c.codeContext &&
      c.hits.infra === 0,
    weights: { "code-change": 0.1 },
  },
  {
    name: "write code ask",
    test: (c) =>
      (c.hits.createVerb > 0 || c.hits.writingVerb > 0) &&
      c.hits.debugWord === 0 &&
      c.hits.proseArtifact === 0 &&
      (c.hits.codeArtifact > 0 || c.codeContext),
    weights: { "code-change": 0.3 },
  },
  {
    name: "prose artifact named",
    test: (c) => c.hits.proseArtifact > 0,
    weights: { writing: 0.3 },
    overrides: ["code artifact named"],
  },
  {
    name: "writing verb",
    test: (c) => c.hits.writingVerb > 0,
    weights: { writing: 0.5 },
    overrides: ["summary word", "failure word"],
  },
  {
    name: "compose ask with no competing reading",
    test: (c) =>
      (c.hits.createVerb > 0 || c.hits.writingVerb > 0 || POLITE.test(c.lower)) &&
      workVerbFamiliesAbsentExceptCreate(c) &&
      c.hits.codeArtifact === 0 &&
      c.hits.infra === 0 &&
      !c.codeContext &&
      !c.question,
    weights: { writing: 0.45 },
  },
  {
    name: "review verb",
    test: (c) => c.hits.reviewVerb > 0,
    weights: { review: 0.55 },
  },
  {
    name: "review object named",
    test: (c) => c.hits.reviewObject > 0,
    weights: { review: 0.25 },
  },
  {
    name: "plan word",
    test: (c) => c.hits.planWord > 0,
    weights: { planning: 0.5 },
  },
  {
    name: "plan word repeated",
    test: (c) => c.hits.planWord >= 2,
    weights: { planning: 0.15 },
  },
  {
    name: "research word",
    test: (c) => c.hits.researchWord > 0,
    weights: { research: 0.5 },
  },
  {
    name: "research word repeated",
    test: (c) => c.hits.researchWord >= 2,
    weights: { research: 0.15 },
  },
  {
    name: "summary word",
    test: (c) => c.hits.summaryWord > 0,
    weights: { summary: 0.55 },
    overrides: ["data verb", "data verb with no competing claim", "data noun", "infra named"],
  },
  {
    name: "error-rate metric named",
    test: (c) => /error rates?\b/.test(c.lower),
    weights: { data: 0.2 },
  },
  {
    name: "data verb",
    test: (c) => c.hits.dataVerb > 0,
    weights: { data: 0.4 },
  },
  {
    name: "data verb with no competing claim",
    test: (c) =>
      c.hits.dataVerb > 0 &&
      c.hits.opsVerb === 0 &&
      c.hits.codeChangeVerb === 0 &&
      c.hits.createVerb === 0 &&
      c.hits.debugWord === 0 &&
      c.hits.writingVerb === 0,
    weights: { data: 0.2 },
  },
  {
    name: "data noun",
    test: (c) => c.hits.dataNoun > 0,
    weights: { data: 0.2 },
  },
  {
    name: "measurement ask",
    test: (c) => measurementAsk(c),
    weights: { data: 0.35 },
  },
  {
    name: "quantity question",
    test: (c) => c.hits.quantityPhrase > 0,
    weights: { data: 0.25 },
  },
  {
    name: "temporal scope",
    test: (c) => c.hits.temporalScope > 0,
    weights: { data: 0.15 },
  },
  {
    name: "number wall",
    test: (c) => c.tokenCount >= 8 && c.numberDensity >= 0.3,
    weights: { data: 0.3 },
  },
  {
    name: "markdown table",
    test: (c) => c.tableRows > 0,
    weights: { data: 0.35 },
  },
  {
    name: "sql query",
    test: (c) => c.sql,
    weights: { data: 0.35 },
  },
  {
    name: "code in the message",
    test: (c) => c.codeContext,
    weights: { "code-change": 0.25, debugging: 0.15, review: 0.15, operations: 0.15 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "diff",
    test: (c) => c.diff,
    weights: { review: 0.25, "code-change": 0.15 },
    rulesOut: ["small-talk", "simple-question"],
  },
  {
    name: "url",
    test: (c) => c.urls > 0,
    weights: { research: 0.15 },
  },
  {
    name: "attachments",
    test: (c) => c.hasAttachments,
    weights: { data: 0.1, unknown: 0.15 },
    rulesOut: ["small-talk"],
  },
  {
    name: "runnable ops command",
    test: (c) => c.shell && /\b(kubectl|helm|systemctl|docker|terraform|aws|gcloud)\b/.test(c.text),
    weights: { operations: 0.5 },
  },
  {
    name: "greeting word",
    test: (c) => c.hits.greeting > 0 || c.hits.greetingPhrase > 0,
    weights: { "small-talk": 0.45 },
  },
  {
    name: "farewell word",
    test: (c) => c.hits.farewell > 0,
    weights: { "small-talk": 0.4 },
  },
  {
    name: "filler word",
    test: (c) => c.hits.filler > 0,
    weights: { "small-talk": 0.3 },
  },
  {
    name: "social words only",
    test: (c) =>
      (c.hits.greeting > 0 ||
        c.hits.greetingPhrase > 0 ||
        c.hits.farewell > 0 ||
        c.hits.filler > 0) &&
      !anyWorkHit(c) &&
      c.wordCount <= 12 &&
      (!c.question || c.hits.greetingPhrase > 0),
    weights: { "small-talk": 0.35 },
  },
  {
    name: "no work words at all",
    test: (c) => !anyWorkHit(c) && !c.hasAttachments && !c.answersBotQuestion,
    weights: { "small-talk": 0.2, "simple-question": 0.15 },
  },
  {
    name: "asks a fact",
    test: (c) =>
      c.scriptCovered &&
      (c.question || c.questionOpener) &&
      workVerbHits(c) === 0 &&
      !measurementAsk(c) &&
      !strongFailure(c) &&
      !c.codeContext &&
      !c.hasAttachments &&
      !c.answersBotQuestion,
    weights: { "simple-question": 0.35 },
  },
  {
    name: "asks how",
    test: (c) =>
      /\bhow (do|can|should|did|does|to)\b/i.test(c.text) ||
      /\bwie (kann|muss|funktioniert)\b/i.test(c.text) ||
      /\bcomment (do|je|peut)\b/i.test(c.text),
    weights: { "simple-question": 0.3 },
    rulesOut: ["operations"],
  },
  {
    name: "question form",
    test: (c) => c.question,
    weights: { "simple-question": 0.2 },
  },
  {
    name: "question opener",
    test: (c) => c.questionOpener,
    weights: { "simple-question": 0.15 },
  },
  {
    name: "very short",
    test: (c) => c.wordCount <= 6,
    weights: { "small-talk": 0.15 },
  },
  {
    name: "short",
    test: (c) => c.wordCount <= 12,
    weights: { "small-talk": 0.1, "simple-question": 0.05 },
  },
  {
    name: "long message",
    test: (c) => c.wordCount > 25,
    weights: { research: 0.1, planning: 0.1 },
  },
];

/** The verb families other than create/write that would compete with a compose ask. */
function workVerbFamiliesAbsentExceptCreate(ctx: MessageContext): boolean {
  return (
    ctx.hits.opsVerb === 0 &&
    ctx.hits.codeChangeVerb === 0 &&
    ctx.hits.dataVerb === 0 &&
    ctx.hits.reviewVerb === 0 &&
    ctx.hits.planWord === 0 &&
    ctx.hits.researchWord === 0 &&
    ctx.hits.summaryWord === 0 &&
    ctx.hits.fix === 0 &&
    ctx.hits.debugWord === 0
  );
}

/** When two readings tie, the one the route table sends more effort wins. */
const EFFORT_RANK: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MULTIPLIERS: Readonly<Record<TaskType, number>> = {
  debugging: 1.15,
  operations: 1.05,
  "code-change": 1.05,
  research: 1.05,
  planning: 1,
  review: 1,
  data: 1,
  summary: 0.95,
  writing: 0.95,
  "simple-question": 0.9,
  "small-talk": 0.9,
  unknown: 1,
};

/** A question about work is not yet a request for it: asking discounts doing. */
const QUESTION_DISCOUNT: readonly TaskType[] = ["operations", "code-change"];

function effortRank(taskType: TaskType): number {
  const route = ROUTE_EFFORT[taskType];
  return EFFORT_RANK.indexOf(route);
}

const ROUTE_EFFORT: Readonly<Record<TaskType, string>> = {
  "small-talk": "minimal",
  "simple-question": "low",
  summary: "low",
  writing: "medium",
  data: "medium",
  operations: "medium",
  "code-change": "high",
  review: "high",
  debugging: "high",
  planning: "high",
  research: "high",
  unknown: "medium",
};

/**
 * The decision: fold the table into scores, gate the light routes, and prefer the more
 * careful reading on a tie. Anything below the confidence floor answers `unknown`.
 */
function decide(ctx: MessageContext): TaskClassification {
  const scores = new Map<TaskType, number>();
  const contributions = new Map<TaskType, string[]>();
  const ruledOut = new Set<TaskType>();
  const fired: string[] = [];
  const overridden = new Set<string>();
  for (const signal of SIGNAL_TABLE) {
    if (signal.test(ctx)) {
      for (const name of signal.overrides ?? []) overridden.add(name);
    }
  }
  for (const signal of SIGNAL_TABLE) {
    if (!signal.test(ctx)) continue;
    if (overridden.has(signal.name)) continue;
    fired.push(signal.name);
    for (const taskType of signal.rulesOut ?? []) ruledOut.add(taskType);
    for (const [taskType, weight] of Object.entries(signal.weights) as [TaskType, number][]) {
      scores.set(taskType, (scores.get(taskType) ?? 0) + weight);
      const list = contributions.get(taskType) ?? [];
      list.push(signal.name);
      contributions.set(taskType, list);
    }
  }

  for (const [taskType, score] of scores) {
    let value = (score + 0.15) * MULTIPLIERS[taskType];
    if (ctx.question && QUESTION_DISCOUNT.includes(taskType)) value *= 0.8;
    scores.set(taskType, Math.min(0.97, value));
  }

  // Light is earned: no sign of work may appear anywhere in the message.
  const lightBlocked =
    ctx.hasAttachments ||
    ctx.answersBotQuestion ||
    strongFailure(ctx) ||
    anyWorkHit(ctx) ||
    ctx.hits.debugWord > 0 ||
    ctx.hits.fix > 0 ||
    ctx.hits.remediationPhrase > 0 ||
    ctx.hits.evidence > 0;
  const candidates = [...scores.entries()].filter(([taskType]) => {
    if (ruledOut.has(taskType)) return false;
    if (taskType === "small-talk") {
      return !lightBlocked && (!ctx.question || ctx.hits.greetingPhrase > 0);
    }
    if (taskType === "simple-question") {
      return !lightBlocked && (ctx.question || ctx.questionOpener);
    }
    return true;
  });
  candidates.sort((a, b) => {
    const byScore = b[1] - a[1];
    if (byScore !== 0) return byScore;
    const byEffort = effortRank(b[0]) - effortRank(a[0]);
    if (byEffort !== 0) return byEffort;
    return (contributions.get(b[0])?.length ?? 0) - (contributions.get(a[0])?.length ?? 0);
  });

  const signals = fired.length > 0 ? fired : ["no signal fired"];
  const winner = candidates[0];
  if (winner === undefined || winner[1] < EFFORT_ROUTE_MIN_CONFIDENCE) {
    const best = winner?.[1] ?? 0;
    return {
      taskType: "unknown",
      confidence: Math.max(0.3, Math.min(0.59, best)),
      signals: [...signals, "below the confidence floor"],
    };
  }
  const [taskType, confidence] = winner;
  const top = contributions.get(taskType) ?? [];
  return {
    taskType,
    confidence,
    signals: [...signals.slice(0, 6), ...top.slice(0, 4)].slice(0, 8),
  };
}

/**
 * The local, deterministic task classifier: the signal table above, folded by `decide`.
 * It does no I/O and answers the same for the same input. When two readings compete it
 * prefers the more careful one — a work message answered at chat effort costs far more
 * than the reverse.
 */
export const localTaskClassifier: TaskClassifier = {
  classify(input: TaskClassifierInput): TaskClassification {
    const trimmed = input.text.trim();
    if (trimmed.length === 0) {
      return { taskType: "unknown", confidence: 0.3, signals: ["empty message"] };
    }
    return decide(readContext(input.text, input));
  },
};
