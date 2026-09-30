import type { TaskType } from "@ardurbot/contracts";

/** One labelled message for testing the classifier. A note starting "tricky" marks a hard case. */
export type EffortExample = {
  text: string;
  taskType: TaskType;
  note?: string;
};

/**
 * The labelled example set: what each kind of task looks like in real messages. It spans
 * every task type and several languages, and carries more than twenty tricky cases —
 * greetings hiding emergencies, questions asking for work, and words that mean two things.
 */
export const EFFORT_EXAMPLES: readonly EffortExample[] = [
  // small-talk
  { text: "hi", taskType: "small-talk" },
  { text: "hello there!", taskType: "small-talk" },
  { text: "hey, how's it going?", taskType: "small-talk" },
  { text: "good morning", taskType: "small-talk" },
  { text: "thanks!", taskType: "small-talk" },
  { text: "thank you so much", taskType: "small-talk" },
  { text: "lol ok", taskType: "small-talk" },
  { text: "haha nice", taskType: "small-talk" },
  { text: "bye!", taskType: "small-talk" },
  { text: "ça va ?", taskType: "small-talk" },
  { text: "¿qué tal?", taskType: "small-talk" },
  { text: "こんにちは", taskType: "small-talk" },
  { text: "你好呀", taskType: "small-talk" },
  { text: "привет!", taskType: "small-talk" },
  {
    text: "maybe later",
    taskType: "small-talk",
    note: "tricky: a farewell word used as a put-off, still chat",
  },

  // simple-question
  { text: "What time is it in Tokyo?", taskType: "simple-question" },
  { text: "Is the store open on Sundays?", taskType: "simple-question" },
  { text: "how many legs does a spider have?", taskType: "simple-question" },
  { text: "What's the capital of Australia?", taskType: "simple-question" },
  { text: "Do penguins fly?", taskType: "simple-question" },
  { text: "Wo liegt der Bahnhof?", taskType: "simple-question" },
  { text: "Comment va ta journée?", taskType: "simple-question" },
  { text: "今天天气怎么样？", taskType: "simple-question" },
  { text: "커피 마셔요?", taskType: "simple-question" },
  {
    text: "what does 404 mean?",
    taskType: "simple-question",
    note: "tricky: a number-heavy message that is still just a question",
  },
  { text: "¿Dónde está la biblioteca?", taskType: "simple-question" },
  {
    text: "when is the next release?",
    taskType: "simple-question",
    note: "tricky: names a release but only asks when",
  },
  {
    text: "how do I restart postgres?",
    taskType: "simple-question",
    note: "tricky: asks how, does not ask for the restart to be done",
  },

  // writing
  { text: "Write a haiku about the ocean", taskType: "writing" },
  { text: "Draft an apology email to a customer whose order arrived late", taskType: "writing" },
  { text: "Translate this paragraph into Portuguese", taskType: "writing" },
  { text: "帮我润色这段话", taskType: "writing" },
  { text: "Write a blog post about our launch", taskType: "writing" },
  { text: "Compose a caption for this photo", taskType: "writing" },
  { text: "Rewrite this paragraph to sound more confident", taskType: "writing" },
  { text: "Écris un poème sur l'automne", taskType: "writing" },
  { text: "Polish the intro of my essay", taskType: "writing" },
  { text: "Ein Gedicht über den Herbst, bitte", taskType: "writing" },
  { text: "帮我写一封道歉邮件", taskType: "writing" },
  {
    text: "翻译一下，谢谢",
    taskType: "writing",
    note: "tricky: thanks and a request in one short message; the request wins",
  },

  // summary
  {
    text: "Summarize this article for me: The quarterly report covers three regions and twelve product lines, with the strongest growth in the northern markets...",
    taskType: "summary",
  },
  { text: "tl;dr please", taskType: "summary" },
  { text: "总结一下这篇文档", taskType: "summary" },
  {
    text: "Can you give me a recap of the meeting?",
    taskType: "summary",
    note: "tricky: a request phrased as a question",
  },
  { text: "Résume ce fil de discussion en trois points", taskType: "summary" },
  { text: "Condense this thread to the key points", taskType: "summary" },
  { text: "short version?", taskType: "summary" },
  { text: "要約してください", taskType: "summary" },
  {
    text: "Summarize this 40-page PDF",
    taskType: "summary",
    note: "tricky: summary of long attached material",
  },

  // code-change
  { text: "Add a logout button to the settings page", taskType: "code-change" },
  {
    text: "Refactor the auth module: split token refresh out of login\n```ts\nexport function refresh(t: string): void {}\n```",
    taskType: "code-change",
  },
  {
    text: "Implement binary search here:\n```ts\nexport function find(xs: number[], x: number): number {\n  return -1;\n}\n```",
    taskType: "code-change",
  },
  {
    text: "Remove the deprecated /v1/legacy endpoint from src/api/routes.ts",
    taskType: "code-change",
  },
  {
    text: "重构一下这个函数，代码如下：\n```js\nfunction load() {}\n```",
    taskType: "code-change",
  },
  { text: "Update the tests to cover the retry path", taskType: "code-change" },
  { text: "Migrate the settings page from props to context", taskType: "code-change" },
  { text: "Remove the dead code in the parser", taskType: "code-change" },
  {
    text: 'Implement rate limiting on the login endpoint:\n```ts\nrouter.post("/login", handler)\n```',
    taskType: "code-change",
  },
  { text: "新增一个导出按钮", taskType: "code-change" },

  // debugging
  {
    text: 'Traceback (most recent call last):\n  File "app.py", line 42, in handler\n    return do_work()\nTypeError: cannot add int and str',
    taskType: "debugging",
  },
  {
    text: "TypeError: Cannot read properties of undefined (reading 'id')\n    at getUser (services/user.ts:31:15)\n    at handler (routes/api.ts:12:9)",
    taskType: "debugging",
  },
  {
    text: "It crashes when I tap save — here's the log:\n```\nFATAL EXCEPTION: main\njava.lang.NullPointerException\n```",
    taskType: "debugging",
  },
  {
    text: "500 error on /api/orders since the last deploy, help",
    taskType: "debugging",
    note: "tricky: mentions a deploy but the message is an error report",
  },
  { text: "Ошибка: приложение падает при запуске", taskType: "debugging" },
  {
    text: "登录的时候一直报错，日志：\n```\nAuthError: token expired\n```",
    taskType: "debugging",
  },
  {
    text: "Getting 'undefined is not a function' after the package upgrade",
    taskType: "debugging",
  },
  { text: "Segfault when running the worker on large inputs, core dumped", taskType: "debugging" },
  { text: "支付接口一直报错，怎么办？", taskType: "debugging" },
  {
    text: "The build fails on CI with exit code 137",
    taskType: "debugging",
    note: "tricky: 'build' is also a create verb; the failure wins",
  },
  {
    text: "Intermittent panic in the worker, trace:\n```\ngoroutine 1 [running]:\nmain.main()\n```",
    taskType: "debugging",
  },
  {
    text: "Fix the off-by-one in the pagination",
    taskType: "debugging",
    note: "tricky: 'fix' without pasted code reads as debugging, not a planned change",
  },
  {
    text: "谢谢你，帮我修复这个bug",
    taskType: "debugging",
    note: "tricky: thanks first, repair request second; never small talk",
  },

  // review
  {
    text: "Review this PR before I merge:\n```diff\n+ const x = compute(y)\n- const x = compute(z)\n```",
    taskType: "review",
  },
  { text: "Can you look over my changes to the tokenizer?", taskType: "review" },
  {
    text: "评审一下这段代码：\n```py\ndef f():\n    pass\n```",
    taskType: "review",
  },
  {
    text: "Please give feedback on the draft design doc",
    taskType: "review",
    note: "tricky: 'draft' and 'design' belong to other lists; feedback wins",
  },
  {
    text: "LGTM from my side, but check the error handling again",
    taskType: "review",
    note: "tricky: mentions an error but is a review verdict",
  },
  {
    text: "レビューお願いします、この差分です：\n```diff\n@@ -1 +1 @@\n-a\n+b\n```",
    taskType: "review",
  },
  {
    text: "Take a look at my query and tell me if the join is right:\n```sql\nselect * from a join b on a.id = b.id\n```",
    taskType: "review",
    note: "tricky: SQL that is being reviewed, not run",
  },
  {
    text: "is this patch good to merge?",
    taskType: "review",
    note: "tricky: a review question about a patch",
  },

  // planning
  {
    text: "Plan the migration to the new billing system: what are the milestones and risks?",
    taskType: "planning",
  },
  { text: "Help me break down this project into tasks", taskType: "planning" },
  { text: "Let's design the architecture for the notification service", taskType: "planning" },
  { text: "给我做一个学习计划，三个月学会日语", taskType: "planning" },
  {
    text: "What's the roadmap for offline mode next quarter?",
    taskType: "planning",
    note: "tricky: a question about plans is still planning",
  },
  { text: "Wie strukturieren wir den Umbau der API?", taskType: "planning" },
  { text: "Outline a rollout strategy with a fallback for each stage", taskType: "planning" },
  { text: "Planifier la refonte du site en trois étapes", taskType: "planning" },

  // research
  {
    text: "Research the best embedded databases for offline-first apps and compare licenses",
    taskType: "research",
  },
  {
    text: "Find out why our signup conversion dropped in March; analytics export: https://internal.example.com/report",
    taskType: "research",
  },
  { text: "调研一下竞品的价格和功能", taskType: "research" },
  {
    text: "Compare ArdurAI, Linear and Height for issue tracking; cite sources",
    taskType: "research",
  },
  {
    text: "What's the state of the art on sparse attention? Summarize the top 3 papers",
    taskType: "research",
    note: "tricky: asks for a summary too; the survey intent wins",
  },
  {
    text: "Investigate whether WebGPU is ready for prime time; check the browser support tables",
    taskType: "research",
  },
  {
    text: "Is RAG still worth it in 2026? Dig into the recent benchmarks",
    taskType: "research",
    note: "tricky: opens like a question, closes like an investigation",
  },
  {
    text: "Suche papers zu RAG und fasse den Stand der Forschung zusammen",
    taskType: "research",
    note: "tricky: ends with a summary ask; the literature survey wins",
  },

  // data
  {
    text: "Analyze this CSV and tell me which region grew fastest:\n| region | 2024 | 2025 |\n| eu | 1.2 | 1.4 |\n| us | 2.2 | 2.5 |",
    taskType: "data",
  },
  { text: "SELECT count(*) FROM orders WHERE status = 'refunded';", taskType: "data" },
  {
    text: "average, median and p95 for the latencies in this sheet: 12, 15, 900, 22, 30",
    taskType: "data",
  },
  { text: "分析这份数据，找出异常值", taskType: "data" },
  { text: "Plot the monthly signups as a bar chart", taskType: "data" },
  {
    text: "Which cohort retained best? Pivot the dataset by signup month",
    taskType: "data",
    note: "tricky: a question that asks for a pivot, not an answer",
  },
  { text: "Dedupe and analyze the spreadsheet I attached", taskType: "data" },
  { text: "Analysiere diese Daten und finde Ausreißer", taskType: "data" },
  {
    text: "Here are the exam scores, what's the average?\n90, 85, 77, 92, 68, 95, 88, 79, 91, 84",
    taskType: "data",
    note: "tricky: question mark plus a wall of numbers",
  },

  // operations
  { text: "Deploy the API to production", taskType: "operations" },
  { text: "Restart the staging server, it's hung", taskType: "operations" },
  {
    text: "Roll back the release; error rate doubled",
    taskType: "operations",
    note: "tricky: names an error but the ask is the rollback",
  },
  { text: "把服务重启一下", taskType: "operations" },
  { text: "Renew the TLS cert before it expires tonight", taskType: "operations" },
  { text: "Take a backup of the database before the migration", taskType: "operations" },
  {
    text: "prod is down, all hands",
    taskType: "operations",
    note: "tricky: short, no verb, an emergency",
  },
  {
    text: "hi, prod is down, fix it",
    taskType: "operations",
    note: "tricky: the canonical greeting-shaped emergency; never small talk",
  },
  { text: "Provision a new staging environment from last night's backup", taskType: "operations" },
  { text: "please restart the worker, it's stuck at 100%", taskType: "operations" },

  // unknown
  { text: "asdf ghjkl", taskType: "unknown" },
  { text: "The quick brown fox jumps over the lazy dog twice", taskType: "unknown" },
  { text: "Tomorrow, maybe, if the weather holds", taskType: "unknown" },
  { text: "看这个", taskType: "unknown" },
  { text: "water the plants", taskType: "unknown" },
  { text: "嗯嗯", taskType: "unknown" },
  { text: "так, ладно", taskType: "unknown" },
  { text: "Friday works for me", taskType: "unknown" },
];
