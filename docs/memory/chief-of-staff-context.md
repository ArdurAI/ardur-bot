# Chief of Staff context

One bot can work in several groups without loading every group's transcript on each turn. `assembleTurnContext` in `packages/adapters/src/context/assemble.ts` uses the current group's brief and bounded thread history. Direct conversations use the same pipeline.

## Layers and caching

`ContextBudgetsSchema` in `packages/contracts/src/context.ts` defines character budgets. The owner can change space defaults through `context.configure`; `context.settings` returns effective settings.

| Layer, in order | Default characters | Source | Changes |
| --- | ---: | --- | --- |
| Identity, instructions, rules | 24,000 | Executor instructions and configured capabilities | Stable while configuration is unchanged |
| Group brief | 6,000 | Group-scoped journal document | Per turn |
| Compaction summary | 4,000 | `Thread.historyCompactionSummary` | Per turn |
| Recent messages | 12,000 | Current thread, newest messages first when fitting | Per turn |
| Recalled documents | 6,000 | Authorized semantic provider or local lexical lookup, with citations | Only when the lexical recall gate opens |
| New message | 48,000 | Request plus current execution guidance | Per turn |

The first and last defaults resolve budgets that were not specified for those layers. An oversized instruction block or request fails explicitly instead of silently dropping instructions. Other layers fit within their bounds, including brief, summary and recall framing. Counts cover text supplied by the assembler; tool schemas, images and protocol envelopes are outside these character counts. Token usage is measured separately when reported by the provider.

Clock, workspace and continuation guidance belong to the new-message layer. They cannot change the stable prefix on every turn. Native runtimes start a fresh session with assembled history because resuming their hidden history would bypass these limits. Controlled comparisons retain their captured inputs.

`markStablePrefix` in `packages/adapters/src/context/provider-cache.ts` marks the stable system block with Anthropic `cache_control: { type: "ephemeral" }`. Anthropic caches a prefix spanning tools, system and messages, subject to model minimums and cache lifetime. Tool or instruction changes can invalidate that prefix. See the official [Anthropic prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

OpenAI-compatible and Ollama connections use the provider's automatic prefix reuse, without a custom cache marker. Compatibility alone does not guarantee caching or usage reporting. OpenAI documents automatic exact-prefix caching in its [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching). Ollama documents `prompt_eval_cached_count` in [API usage](https://docs.ollama.com/api/usage); a compatible endpoint may omit that counter. Missing cache measurements remain `null`, including when only some calls report them. Native runtime adapters forward reported cache counters and account for cumulative notifications as deltas.

## Briefs and safe writes

`packages/memory/src/briefs/` owns formatting, protected edits, tool-result capture and maintenance. Each brief uses scope `group`, key `<botId>:<groupId>` or `<botId>:direct`, and the existing memory journal. `BotBrief`, mapped to `bot_briefs`, holds maintenance state rather than a second copy of document content.

The fixed Markdown sections are Goal, People and bots, Open items, Last decisions and Pointers. Section limits are 700, 800, 1,700, 1,300 and 1,300 characters; headings and spacing keep the whole document below 6,000. A human edit during the preceding hour protects existing bytes. Automatic changes can only append within Open items. A stale revision gets one append retry against the latest content. A second conflict leaves the brief pending. Automatic general memory saves follow the same append-on-conflict rule; human revision conflicts remain explicit. The `remember` tool appends a fact with the revision it observed, preserving other groups' facts when writes overlap.

After a group or direct turn, `refreshRunBrief` uses its immutable runtime pin, no tools, at most 2,000 output tokens, a 30-second deadline and bounded JSON input below 30,000 characters. It supplies recent messages, a bounded redacted tool-result record, the prior brief, the thread summary and structured delegation cards. Cards preserve acceptance state; prose cannot establish task acceptance. There is no Board model in this checkout, so no board item identifiers are invented.

Unavailable models leave content unchanged with a recorded reason. There is no alternate model or Auto Review dependency. Brief calls count toward recorded usage and existing task limits; they add one bounded model call after a successful turn when maintenance is needed. This can consume paid provider quota. Scripted runtimes do not synthesize briefs.

`maintainBriefs` runs every ten minutes through the existing background-job host, selects at most five dirty briefs and retries them sequentially. A later message from another bot also makes an existing brief dirty. A bot with no prior run has no runtime pin to maintain from; its empty structured brief becomes populated after its first turn. History generation checks prevent a rewrite that started before clearing a thread from committing afterward. Briefs remain durable memory when conversation history is cleared.

## Routing and concurrency

`routeIncoming` in `packages/adapters/src/routing/route.ts` uses no model:

1. Explicit mention.
2. Reply target.
3. Group coordinator.
4. Sender's last active thread.
5. Space coordinator.
6. Default coordinator, or the first eligible member when none is configured. This records `default` and displays "Routed by default".

Group mentions retain existing explicit multiple-bot and `@everyone` behavior. `admitRoutedDispatch` runs inside dispatch admission after nonce replay. Existing grant limits, reply authorization and external room binding still apply.

`claimBotRun` serializes admission with database locks in bot-then-thread order. Active run leases and brief-maintenance leases consume the same capacity. Defaults allow three concurrent runs per bot across threads, with one run per thread. The bot owner can set 1–16 concurrent runs in bot settings; a null bot override inherits the space default. Queued runs remain in the runs table and use the existing job retry path. Thread compaction is scheduled immediately after eligible turns through the existing compaction job.

## Metrics and surfaces

`Run.contextSnapshot` records layer sizes, recall calls, routing rule, queue wait, time to first text token and reported input/cache tokens. `run.context` events update both clients. Resumed runs preserve their first-token measurement and accumulate recall and usage totals; layer sizes describe the latest assembly. Queue wait measures admission delay separately from model response latency.

`metrics.context` returns owner-scoped per-bot totals and per-bot/per-group aggregates for the current UTC day and trailing seven days. Percentiles use nearest rank. Cache hit ratio is total reported cached input tokens divided by reported input tokens for runs with complete valid cache measurements. Sample counts expose measurement coverage. Unknown values render as an em dash.

There is no `registerDashboardPanel` registry in this checkout. Web and Electron therefore show the Context section in bot settings and current/recent run metrics in the conversation header. Group settings expose each member's brief. Mobile uses native controls, the same contracts and read-only brief content with translated labels. Brief content remains the stored document's language.

Offline tests cover the assembler, recall gate, routing, revision conflicts, human protection, concurrency, maintenance, metrics and both clients. `packages/testkit/src/context.postgres.test.ts` exercises the API, executor, model emulator and real journal across two groups. `apps/web/e2e/context.spec.ts` captures the two-brief settings view and default-routing header in a headless browser.
