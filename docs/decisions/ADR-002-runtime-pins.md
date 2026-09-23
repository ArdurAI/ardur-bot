# ADR-002: Pins are promises — fail-closed model pins, per-bot runtimes, and subscriptions through the vendors' own binaries

Status: proposed (2026-09-23)

## Context

A bot's provider, model, effort, runtime and computer are what its owner chose. Today the
inherited code treats the model choice as a soft preference: when a bot's credential is
missing, `packages/adapters/src/model-selection.ts` falls through to the user's or the
deployment's default and drops the bot's effort, and `packages/adapters/src/pi-runtime.ts`
clamps unsupported effort levels. A researcher comparing models, or an operator who paid for
one subscription, cannot tell that this happened.

The agent loop is one deployment-wide runtime (`ExecutorDeps.runtime`, created once in the
API and once in the worker). There is no way to run one bot on a different engine.

Subscriptions have rules. Anthropic allows a Claude Pro/Max subscription to be used only
through the unmodified `claude` binary signed in through Anthropic's own flow; a third-party
app may not collect, store or intermediate Claude.ai credentials or tokens. The inherited
`packages/adapters/src/pi-anthropic-oauth.ts` does exactly that. OpenAI documents
`codex app-server` as the way to embed Codex with a ChatGPT login.

In the packaged desktop app the API and worker run inside containers, while the user's
`claude` binary lives on the host.

The full design, with file references and open verification gates, is the hub page
"Runtime and pin design (codex, 2026-09-23)".

## Decision

1. **A bot's pin is complete and immutable per run.** Provider, model, explicit effort,
   connection binding and pin revision are persisted on the bot and snapshotted on every run.
   Resolution returns either a resolved pin or a typed problem. There is no fallback chain:
   a pin that cannot be honoured stops the bot before any model call or tool effect with
   "This bot is pinned to X; connect it or change the pin", offering Connect and Change pin.
   Defaults exist only when creating or editing a bot, never at run time. Auxiliary calls
   (compaction, judging, automatic review) use the same resolver or an explicitly configured
   auxiliary pin.
2. **Runtimes are resolved per bot.** `Bot.runtimeKind` (`pi` by default, later
   `claude-code` and `codex-app-server`) selects the engine through a resolver that replaces
   the single injected runtime. Unknown kinds, missing binaries and disconnected hosts fail
   explicitly. Children and duplicates copy the complete binding; temporary subagents inherit
   the parent's run snapshot unless the owner set another complete binding.
3. **Claude subscriptions run through the user's unmodified `claude` binary** (`claude -p`
   with stream-json input and output, `--mcp-config` for Ardur's tools, `--effort`,
   `--resume`), with authentication entirely inside that binary. Ardur never reads
   `~/.claude/.credentials.json` or the "Claude Code-credentials" keychain item, never
   performs Claude.ai OAuth, and never transports Claude.ai tokens. Native file and shell
   tools of the CLI are disabled; the bot's computer, memory and connectors are exposed
   through Ardur's MCP server. Host computers first; container computers keep their
   filesystem separate from the host process.
4. **The inherited Claude.ai OAuth implementation is deleted**, not flagged: Anthropic is
   API-key-only in the catalog, OAuth begin/finish routes reject it, stored OAuth secrets for
   it are rejected before refresh, and built artifacts are scanned so the code cannot ship.
5. **New ChatGPT connections use `codex app-server`** over stdio (`initialize` with
   `clientInfo.name: "ardur-bot"`, `account/login/start` with type `chatgpt`,
   `thread/start`, `turn/start` with the exact model and effort). A rerouted model ends the
   pinned run. Existing Pi-based connections are migrated by an explicit user action; tokens
   are never transferred.
6. **Packaged deployments reach host binaries through a narrowly authorised host service**
   managed by the desktop app but surviving its window: it connects outward to the API over
   an authenticated WebSocket, accepts logical operations only (never arbitrary commands,
   binaries, arguments or environment), spawns approved absolute binaries without a shell,
   confines working directories to registered roots, bounds concurrency and size, and reports
   health without credentials.

## Consequences

- Disconnections and unsupported selections become visible, actionable failures instead of
  quiet substitutions. Existing tests that expect fallback behaviour are reversed.
- Every runtime adapter needs versioned offline conformance tests (a fake `claude`
  executable emitting recorded stream-json; recorded app-server sessions), durable ownership
  of paused interactions, and explicit recovery rules for resume and cancellation.
- Several release gates are unverified until tested against the real binaries: that
  `claude` honours the requested model and effort with rerouting and fallback disabled, the
  permission-prompt protocol, and app-server's production support. Native-runtime support
  is not advertised until they pass.
- Host execution is a separate security boundary; a compromised authorised container can
  still spend subscription quota within its grants. Host-root or Docker-socket compromise is
  outside this design.
- Implementation order: P1a fail-closed pin and OAuth removal; P1b resolver and
  `runtimeKind`; P1c Claude on host computers; P1d the packaged host bridge; P1e Codex
  app-server.
