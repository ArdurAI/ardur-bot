import type { TaskType } from "@ardurbot/contracts";
import type { TaskClassification, TaskClassifier, TaskClassifierInput } from "./classifier.js";

/**
 * The only word lists in the framework, all in one place. They buy precision the structural
 * features cannot reach. Everything else in this file reads structure — length, code fences,
 * stack traces, paths, URLs, shell lines, numbers, tables, lists, punctuation — which works
 * in any language.
 */
const WORD_TABLE = {
  greeting: [
    "hi",
    "hey",
    "hello",
    "yo",
    "sup",
    "gm",
    "morning",
    "bonjour",
    "salut",
    "hola",
    "ciao",
    "hallo",
    "привет",
    "你好",
    "こんにちは",
    "안녕",
  ],
  greetingPhrase: [
    "how are you",
    "how's it going",
    "how are things",
    "ça va",
    "comment ça va",
    "qué tal",
    "cómo estás",
    "wie geht",
    "wie geht's",
    "как дела",
    "как ты",
    "元気ですか",
    "잘 지내",
  ],
  farewell: [
    "bye",
    "goodbye",
    "cya",
    "later",
    "thanks",
    "thank",
    "thx",
    "ty",
    "merci",
    "gracias",
    "danke",
    "спасибо",
    "谢谢",
    "ありがとう",
  ],
  filler: ["lol", "haha", "nice", "cool", "great", "ok", "okay", "wow", "lmao", "jaja", "哈哈"],
  questionWord: [
    "what",
    "when",
    "where",
    "who",
    "why",
    "how",
    "which",
    "does",
    "is",
    "are",
    "can",
    "could",
    "should",
    "qué",
    "cómo",
    "dónde",
    "cuándo",
    "quién",
    "cuál",
    "was",
    "wer",
    "wo",
    "wann",
    "quoi",
    "comment",
    "où",
    "qui",
    "почему",
    "что",
    "как",
    "什么",
    "怎么",
    "几",
    "何",
    "なに",
    "どう",
  ],
  debug: [
    "error",
    "bug",
    "fails",
    "failing",
    "failed",
    "crash",
    "crashes",
    "crashed",
    "exception",
    "traceback",
    "panic",
    "stack",
    "segfault",
    "undefined",
    "fehler",
    "erreur",
    "erro",
    "ошибка",
    "错误",
    "报错",
    "失败",
    "崩溃",
    "エラー",
    "バグ",
  ],
  fix: [
    "fix",
    "fixes",
    "fixing",
    "broken",
    "repair",
    "regression",
    "repro",
    "reproduce",
    "behebe",
    "reparieren",
    "réparer",
    "arreglar",
    "исправь",
    "修复",
    "修一下",
    "修正",
    "直して",
    "고쳐",
  ],
  codeChange: [
    "refactor",
    "implement",
    "implementing",
    "rename",
    "extract",
    "optimize",
    "optimise",
    "migrate",
    "port",
    "wire",
    "remove",
    "delete",
    "update",
    "move",
    "change",
    "重命名",
    "重构",
    "实现",
    "作成",
    "実装",
    "리팩터링",
  ],
  genericCreate: [
    "write",
    "create",
    "build",
    "add",
    "make",
    "generate",
    "schreibe",
    "erstelle",
    "créer",
    "crear",
    "写",
    "创建",
    "新增",
    "作成",
    "生成",
    "만들어",
  ],
  softwareNoun: [
    "button",
    "endpoint",
    "component",
    "function",
    "api",
    "test",
    "tests",
    "hook",
    "route",
    "migration",
    "schema",
    "interface",
    "class",
    "method",
    "page",
    "form",
    "modal",
    "flag",
    "config",
    "module",
    "middleware",
    "query",
    "helper",
    "service",
    "handler",
    "provider",
    "docs",
    "代码",
    "函数",
    "按钮",
    "接口",
    "页面",
  ],
  review: [
    "review",
    "feedback",
    "critique",
    "lgtm",
    "look over",
    "look at",
    "take a look",
    "good to merge",
    "ready to merge",
    "ship it",
    "revisión",
    "revisar",
    "评审",
    "审一下",
    "看一下",
    "看看",
    "レビュー",
    "리뷰",
  ],
  reviewObject: ["pr", "diff", "pull request", "patch", "mr"],
  plan: [
    "plan",
    "roadmap",
    "strategy",
    "milestone",
    "milestones",
    "architecture",
    "architect",
    "design",
    "decompose",
    "breakdown",
    "break down",
    "structure",
    "strukturieren",
    "planifier",
    "planung",
    "planear",
    "計画",
    "計画",
    "계획",
    "计划",
    "规划",
    "方案",
    "設計",
  ],
  research: [
    "research",
    "investigate",
    "compare",
    "survey",
    "literature",
    "paper",
    "papers",
    "arxiv",
    "benchmark",
    "sota",
    "state of the art",
    "find out",
    "dig into",
    "rechercher",
    "untersuchen",
    "forschung",
    "investigar",
    "研究",
    "调研",
    "调查",
    "調査",
    "연구",
  ],
  summary: [
    "summarize",
    "summarise",
    "summary",
    "tldr",
    "tl;dr",
    "recap",
    "digest",
    "condense",
    "key points",
    "main points",
    "short version",
    "résume",
    "resumen",
    "resumir",
    "zusammen",
    "总结",
    "摘要",
    "概括",
    "要約",
    "요약",
  ],
  writing: [
    "draft",
    "essay",
    "blog",
    "tweet",
    "caption",
    "story",
    "poem",
    "haiku",
    "limerick",
    "copy",
    "script",
    "rewrite",
    "reword",
    "polish",
    "translate",
    "translation",
    "gedicht",
    "écrire",
    "écris",
    "rédige",
    "escribir",
    "翻译",
    "润色",
    "書く",
    "번역",
    "작성",
  ],
  operations: [
    "deploy",
    "deployment",
    "restart",
    "reboot",
    "release",
    "rollback",
    "roll",
    "scale",
    "provision",
    "rotate",
    "renew",
    "cron",
    "backup",
    "restore",
    "devops",
    "prod",
    "production",
    "staging",
    "outage",
    "deployen",
    "déployer",
    "desplegar",
    "部署",
    "上线",
    "重启",
    "运维",
    "배포",
  ],
  data: [
    "csv",
    "excel",
    "spreadsheet",
    "spreadsheets",
    "sql",
    "pivot",
    "chart",
    "charts",
    "plot",
    "analyze",
    "analyse",
    "analysis",
    "statistics",
    "stats",
    "average",
    "median",
    "percentile",
    "correlation",
    "dataset",
    "dataframe",
    "daten",
    "analysieren",
    "analyser",
    "analizar",
    "analiza",
    "分析",
    "统计",
    "图表",
    "数据",
    "データ",
    "분석",
  ],
} as const;

/** Any of these in a short message keeps it out of small talk: it asks for real work. */
const ACTION_TABLE: readonly string[] = [
  ...WORD_TABLE.debug,
  ...WORD_TABLE.fix,
  ...WORD_TABLE.codeChange,
  ...WORD_TABLE.genericCreate,
  ...WORD_TABLE.operations,
  ...WORD_TABLE.review,
  ...WORD_TABLE.plan,
  ...WORD_TABLE.research,
  ...WORD_TABLE.data,
  ...WORD_TABLE.summary,
  ...WORD_TABLE.writing,
];

/** CJK needles are matched as substrings: they have no spaces to lean a word boundary on. */
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

/**
 * Word count that survives languages without spaces: each han character is a word-sized
 * token, a run of kana is one, and Latin words split on non-letters as usual.
 */
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

/**
 * A question for information, asked as a question: wh-words at the start, and short. A
 * request in question clothes ("can you fix this?") does not match, so it stays a work task.
 */
const INFORMATION_QUESTION =
  /^¿?\s*(what|when|where|who|why|how|which|whose|is|are|do|does|did|was|wie|wer|wo|wann|que|qué|cómo|dónde|cuándo|quién|cuál|comment|combien|où|qui|почему|что|как|где|когда|кто|什么|怎么|为什么|几|哪|何|なぜ|どう|누구|무엇|어떻게|언제|어디)/i;

type Features = {
  wordCount: number;
  fences: number;
  stackTrace: boolean;
  codeContext: boolean;
  urls: number;
  numberDensity: number;
  tableRows: number;
  diff: boolean;
  question: boolean;
};

function readFeatures(text: string): Features {
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const numeric = tokens.filter((token) => /^[+-]?[\d.,]+%?$/.test(token)).length;
  const fenceMarkers = trimmed.match(/^[ \t]*(```|~~~)/gm)?.length ?? 0;
  const tableLines = trimmed.split(/\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line)).length;
  const stackTrace =
    /\bat\s+.+\([^)]+:\d+:\d+\)/m.test(trimmed) ||
    trimmed.includes("Traceback (most recent call last)") ||
    /^\s*File "[^"]+", line \d+/m.test(trimmed) ||
    trimmed.includes("Caused by: ") ||
    trimmed.includes("Exception in thread");
  const paths = trimmed.match(/(^|\s|[([])(\/[\w.@-]+\/)+[\w.-]+\.[a-zA-Z]{1,5}/g)?.length ?? 0;
  const shell =
    /^\s*\$\s+\S+/m.test(trimmed) ||
    /^\s*>\s+\S+/m.test(trimmed) ||
    /\b(sudo|apt|apt-get|yum|brew|pip|pip3|kubectl|systemctl|docker|curl|wget|chmod|mkdir)\s+\S+/.test(
      trimmed,
    );
  return {
    wordCount: words(trimmed).length,
    fences: Math.floor(fenceMarkers / 2),
    stackTrace,
    codeContext: fenceMarkers >= 2 || shell || paths > 0,
    urls: trimmed.match(/https?:\/\/\S+/g)?.length ?? 0,
    numberDensity: tokens.length === 0 ? 0 : numeric / tokens.length,
    tableRows: tableLines >= 2 ? tableLines : 0,
    diff: /^[-+]{3} /m.test(trimmed) || /^@@ /m.test(trimmed),
    question: trimmed.includes("?") || trimmed.includes("？") || trimmed.includes("吗"),
  };
}

/**
 * The local, deterministic task classifier: structure first, the word table second, and
 * `unknown` whenever the signals are faint or disagree. It does no I/O and answers the
 * same for the same input. When two readings are close it prefers the more careful one —
 * a work message answered at chat effort costs far more than the reverse.
 */
export const localTaskClassifier: TaskClassifier = {
  classify(input: TaskClassifierInput): TaskClassification {
    const trimmed = input.text.trim();
    if (trimmed.length === 0) {
      return { taskType: "unknown", confidence: 0.3, signals: ["empty message"] };
    }
    const lower = trimmed.toLowerCase();
    const f = readFeatures(trimmed);
    const signals: string[] = [];

    const hit = {
      phrase: countHits(lower, WORD_TABLE.greetingPhrase),
      greeting: countHits(lower, WORD_TABLE.greeting),
      farewell: countHits(lower, WORD_TABLE.farewell),
      filler: countHits(lower, WORD_TABLE.filler),
      questionWords: countHits(lower, WORD_TABLE.questionWord),
      debug: countHits(lower, WORD_TABLE.debug) + countHits(lower, WORD_TABLE.fix),
      codeChange: countHits(lower, WORD_TABLE.codeChange),
      genericCreate: countHits(lower, WORD_TABLE.genericCreate),
      softwareNoun: countHits(lower, WORD_TABLE.softwareNoun),
      review: countHits(lower, WORD_TABLE.review),
      reviewObject: countHits(lower, WORD_TABLE.reviewObject),
      plan: countHits(lower, WORD_TABLE.plan),
      research: countHits(lower, WORD_TABLE.research),
      summary: countHits(lower, WORD_TABLE.summary),
      writing: countHits(lower, WORD_TABLE.writing),
      operations: countHits(lower, WORD_TABLE.operations),
      data: countHits(lower, WORD_TABLE.data),
    };
    const actionWords = countHits(lower, ACTION_TABLE);
    const short = f.wordCount <= 12;
    const informationQuestion = INFORMATION_QUESTION.test(trimmed) && f.wordCount <= 15;

    // A stack trace is a debugging report in any language.
    if (f.stackTrace) {
      signals.push("stack trace");
      return done("debugging", f.codeContext ? 0.95 : 0.85, signals);
    }

    // A greeting, thanks or filler alone is chat. A question disqualifies it unless the
    // whole phrase is a social greeting ("how are you?"), and so does any ask for work.
    if (short && actionWords === 0 && !input.hasAttachments && !input.answersBotQuestion) {
      const friendly = hit.greeting + hit.farewell + hit.filler + hit.phrase;
      if (friendly > 0 && (!f.question || hit.phrase > 0)) {
        signals.push(`greeting or filler, ${f.wordCount} words, nothing asked`);
        return done("small-talk", 0.9, signals);
      }
    }

    // Code in the message plus a change verb is a code change, even if it names an error.
    if (f.codeContext && (hit.codeChange > 0 || hit.genericCreate > 0)) {
      signals.push("code in the message with change verbs");
      return done("code-change", 0.9, signals);
    }
    // Errors named with code around them are debugging.
    if (hit.debug > 0 && f.codeContext) {
      signals.push("error words with code");
      return done("debugging", 0.85, signals);
    }
    // A change verb on a software object is a code change, even without pasted code — but
    // a review verb nearby means the changes are being looked at, not made.
    if (hit.codeChange > 0 && hit.review === 0 && (hit.softwareNoun > 0 || f.wordCount <= 10)) {
      signals.push("change verb on code");
      return done("code-change", 0.75, signals);
    }
    if (hit.genericCreate > 0 && hit.softwareNoun > 0) {
      signals.push("create verb on a software object");
      return done("code-change", 0.75, signals);
    }

    // Review: asked to look over work.
    if (hit.review > 0 && (f.fences > 0 || f.diff || f.codeContext)) {
      signals.push("review words with code or a diff");
      return done("review", 0.85, signals);
    }
    if (hit.review > 0 && (hit.reviewObject > 0 || !informationQuestion)) {
      signals.push("review words");
      return done("review", hit.reviewObject > 0 ? 0.75 : 0.7, signals);
    }

    // Operations: run the system. "How do I restart X?" asks how, and is a simple question.
    // An error report that mentions a deploy is debugging unless the message opens with the
    // ops ask itself ("Roll back...", "Restart...") or names a live environment as the
    // problem ("prod is down, fix it").
    const environmentHit = countHits(lower, ["prod", "production", "staging", "outage"]);
    const opensWithOpsAsk =
      hit.operations > 0 &&
      new RegExp(
        `^\\s*(${WORD_TABLE.operations.filter((w) => !isCjk(w) && !w.includes(" ")).join("|")})\\b`,
        "i",
      ).test(trimmed);
    if (
      hit.operations > 0 &&
      !informationQuestion &&
      (hit.debug === 0 || opensWithOpsAsk || (environmentHit > 0 && !f.stackTrace))
    ) {
      signals.push(`ops words, ${f.wordCount} words`);
      return done("operations", f.wordCount <= 40 ? 0.8 : 0.7, signals);
    }

    // Research: breadth words, with sources, length or repetition behind them.
    if (hit.research > 0 && (f.urls > 0 || f.wordCount > 20 || hit.research >= 2)) {
      signals.push("research words with sources or length");
      return done("research", 0.8, signals);
    }
    // A short investigation ask in question clothes ("Is X still worth it? Dig into...").
    if (hit.research > 0 && hit.debug + hit.operations === 0) {
      signals.push("research words");
      return done("research", 0.7, signals);
    }

    // Planning: how to structure the work. A question about plans is still planning.
    if (hit.plan > 0) {
      signals.push("plan words");
      return done("planning", f.wordCount > 15 ? 0.8 : 0.7, signals);
    }

    // Summary of material at hand.
    if (hit.summary > 0) {
      signals.push("summary words");
      return done("summary", 0.85, signals);
    }

    // Errors named with nothing else around them are still debugging — a "build" that
    // "fails" is a failure report, not a request to build something.
    if (hit.debug > 0) {
      signals.push("error words");
      return done("debugging", 0.7, signals);
    }

    // Writing: prose to compose.
    if (hit.writing > 0 && f.wordCount > 3 && !f.codeContext) {
      signals.push("writing words");
      return done("writing", 0.8, signals);
    }
    // A create verb with no software object composes prose rather than code.
    if (hit.genericCreate > 0 && hit.softwareNoun === 0 && !f.codeContext) {
      signals.push("create verb with no software object");
      return done("writing", 0.65, signals);
    }

    // Errors named without code are still debugging.
    if (hit.debug > 0) {
      signals.push("error words");
      return done("debugging", 0.7, signals);
    }

    // Data: tables, queries, dataset vocabulary, or a wall of numbers.
    if (f.tableRows > 0) {
      signals.push(`markdown table, ${f.tableRows} rows`);
      return done("data", 0.85, signals);
    }
    if (/^select\s+.+\s+from\s+/im.test(trimmed)) {
      signals.push("sql query");
      return done("data", 0.85, signals);
    }
    if (
      hit.data > 0 &&
      (f.numberDensity > 0.15 ||
        f.wordCount > 25 ||
        input.hasAttachments ||
        hit.data >= 2 ||
        f.wordCount <= 12)
    ) {
      signals.push(`data words (${hit.data})`);
      return done("data", 0.8, signals);
    }
    if (f.numberDensity > 0.35 && f.wordCount >= 8) {
      signals.push(`number density ${f.numberDensity.toFixed(2)}`);
      return done("data", 0.7, signals);
    }

    // A question with no work markers is a simple question.
    if (f.question && !f.codeContext) {
      signals.push(`question, ${f.wordCount} words`);
      return done("simple-question", f.wordCount <= 25 ? 0.8 : 0.7, signals);
    }

    // Nothing distinctive: say so rather than guess.
    if (input.hasAttachments) {
      signals.push("attachments with no other signal");
      return done("unknown", 0.5, signals);
    }
    signals.push(f.wordCount <= 12 ? "short message, no strong signal" : "no strong signal");
    return done("unknown", 0.4, signals);
  },
};

function done(taskType: TaskType, confidence: number, signals: string[]): TaskClassification {
  return { taskType, confidence: Math.min(1, Math.max(0, confidence)), signals };
}
