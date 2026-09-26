---
title: "ADR-002 implementation: native runtimes"
description: "Date: 2026-09-23. Status: experimental implementation; real-binary release gates remain open."
source_path: "docs/decisions/ADR-002-native-runtimes.md"
---

> [Source: docs/decisions/ADR-002-native-runtimes.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/decisions/ADR-002-native-runtimes.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Date: 2026-09-23. Status: experimental implementation; real-binary release gates remain open.
This note supplements [ADR-002](/docs/decisions/adr-002-runtime-pins/).

## Behavior and ownership

`RuntimePinSchema` adds `runtimeKind`, defaulting absent legacy values to `pi`.
The bot stores the selection, and each run retains its complete original pin. A retry
does not rewrite that pin after a bot edit. `RuntimeRegistry` selects an adapter only
after pin validation. Missing runtimes, unsupported computers, models, or efforts
produce a `RuntimeProblem`; there is no replacement runtime or model.

The additive migration adds `Bot.runtimeKind`, `Bot.runtimeExperimental` (false by
default), and `Run.runtimeInfo`. The last field records runtime kind, observed version,
session ID, and a hash binding the session to the owner, space, bot, thread, computer,
instructions, and complete pin. It is separate from the immutable `Run.runtimePin`.
Children and duplicates copy the runtime choice with the other pin fields.

Native runtimes require a **host process**, a bot assigned
to a `desktop` computer, and authorization to the paired owner (or a single-user deployment in source mode). They use that OS
user's installed binary from absolute PATH entries, without a shell. No binary is
bundled or modified. Container computers are rejected before probing a runtime.
Packaged desktop API/worker containers reach the host through the
[authenticated host service](/docs/host-service/). Windows file effects remain unavailable
in its single-file bundle; macOS/Linux owner acceptance remains a release gate.
Host and container filesystems are not shared or translated implicitly.

## Claude Code

Availability uses `claude --version` and the documented exit status of
`claude auth status`. Authentication output is consumed and discarded; Ardur does
not inspect the authentication file, keychain, or account details. Supported flags
require Claude Code 2.1.259 or later in the 2.1 line. Unknown major/minor lines fail
until their compatibility has been checked.

The turn uses stream-json input/output, partial messages, the exact model and effort,
and the executor's instructions (including its memory context). First-session history
is sent as untrusted conversation text; later turns resume the explicit session ID.
Current-turn images use the documented base64 input shape. Text is streamed once;
observed CLI tool messages never execute a tool a second time. Completion requires
a successful result, exact reported model usage, and a zero process exit status.
Missing or changed model identities fail closed.

`--tools ""` disables built-in tools. `--restricted`, `--strict-mcp-config`,
`--disable-slash-commands`, and `--no-chrome` constrain other entry points.
`--allowedTools mcp__ardur__*` permits the private Ardur MCP surface.
`--permission-mode dontAsk --permission-prompts none` avoids terminal prompts.
There is no permission-bypass flag. Startup attestation rejects reported tools
other than Ardur MCP tools and the CLI's non-effectful `EndConversation` control.
Before startup attestation, MCP calls cannot execute.

Ardur tools perform authorization through the existing executor. An approval pause
is never returned as a successful tool execution. It stops the vendor process;
Ardur persists the ask/approval and resumes using its normal run recovery path.
The adapter does not hold a live vendor permission prompt across a released run lease.
Interrupted-session recovery still needs verification against the real CLI.

The settings disable ordinary hooks, flagged-model switching, and the fallback
chain. **Managed policy can override these settings and managed hooks cannot be
disabled by command-line settings.** The tool list is not proof that startup hooks
did not run. Isolation under managed policy is therefore an explicit release gate.
Native runtimes remain behind a per-bot **Experimental** switch, off by default.

Only exact catalog IDs documented to support effort are offered. The installed CLI
version gates the effort catalog: stable **2.1.259 through 2.1.281**, inclusive, offer
`low`, `medium`, `high`, and `max` for Opus 4.6 and Sonnet 4.6, and also `xhigh` for
the other catalog models (Fable 5 and 5.1, Opus 4.7, 4.8, 5 and 5.5, and Sonnet 5).
Outside that checked range the catalog retains only `low`. The existing runtime
protocol gate still rejects versions below 2.1.259, unknown major/minor lines, and
prereleases. A newer stable 2.1 patch retains `low` until its expanded effort
compatibility is checked. `probeClaude` uses the version probe to build the catalog;
`ClaudeCodeRuntime.run` checks the installed version again before each turn, including
resume, so a saved pin cannot bypass the gate after the binary changes.

The pin records **requested effort**. Every turn passes that exact value with
`--effort`; the adapter does not translate `off` to `low`, clamp a selection, or alias
`xhigh` to `max`. Both `xhigh` and `max` are distinct documented levels and already
exist in `ThinkingLevelSchema`; `max` is the deepest level. The pin UI displays these
literal values. `ultracode` is also accepted by `--effort` on 2.1.203 and later, but
the documentation defines it as workflow orchestration at `xhigh`, not a model
effort level. It is not offered as Thinking, and this change does not enable vendor
workflow orchestration.

Stream-json init reports `model`, and the result reports model identities through
`modelUsage`; both remain subject to exact model validation. The documented optional
init `effort` field is sent only to Remote Control clients and is omitted from the
application stream. The result schema has no effort field. Ordinary runs therefore
record `Run.runtimeInfo.effortAttested: false` and `effortAttestationReason:
"Claude Code does not report the applied effort"` and proceed. This records a request,
not proof that an organization cap or managed setting did not lower it.

If an init or result message supplies `effort`, the parser compares it with the pin.
A matching report records `effortAttested: true` and clears the reason. A mismatch,
including explicit `null` or a malformed value, closes the MCP execution gate and
fails with `pin-effort-unsupported`; a contradictory result cannot complete the run.
Defensive result-field tests cover a possible future report, not a field the current
result schema promises. Attestation starts fresh on each turn; session reuse cannot
carry it forward. Runtime callbacks merge cumulatively so a later model or session
report cannot erase effort evidence.

Web/Electron and mobile headers, the Team execution snapshot, and comparison results
show `high · requested` (or the selected effort) without attestation and the plain
effort with attestation. Older Claude snapshots without evidence also show requested;
other runtimes keep their existing labels. The header accepts evidence only for the
complete current bot pin, including connection and revision. Team and comparison
results retain the run's evidence even after the bot is edited, and comparison JSON
exports retain the attestation and reason. No run pin is rewritten or backfilled.
Usage parsing and learning behavior are unchanged. Subscription model entitlement
is confirmed by the first turn, not inferred from a successful sign-in probe.

## Codex app-server

The adapter starts `codex app-server` over stdio, initializes with
`clientInfo.name: "ardur-bot"`, and requires `account/read` to report a ChatGPT login.
`model/list` supplies exact model IDs and supported efforts. The connection UI starts
`account/login/start` with `type: "chatgpt"` and displays the returned sign-in address
as a **Continue with ChatGPT** link, never as a log message. Ardur retains only a
short-lived owner-scoped login handle and status. Completion, cancellation, expiry,
and process cleanup are handled by `CodexConnections`; the vendor owns credentials.

`thread/start` or `thread/resume` receives the exact model, OpenAI provider, instructions,
read-only sandbox, and reasoning effort. The response must report the same model,
provider, effort and sandbox. `turn/start` repeats the exact model and effort.
`model/rerouted` immediately disables MCP effects and fails with `pin-model-unknown`.
Steering uses `turn/steer` with `expectedTurnId`; stop uses `turn/interrupt` and bounded
process termination. A failed steering delivery fails visibly rather than silently
continuing without the new instruction.

The adapter disables shell/unified execution, hooks, plugins, apps, multi-agent,
memories, remote plugins, automatic skill MCP installation, web search, and the
built-in local image tool. It reads the effective config for the computer's working
directory to disable other configured MCP servers, then supplies the private Ardur
server. An existing server named `ardur` is rejected to prevent merged launch
settings from escaping that boundary. It never writes vendor configuration. Built-in command/file approval
requests are declined and mapped to an Ardur ask card; approving an Ardur card does
not grant a vendor-native effect. Supported effects execute through Ardur MCP.
Effective configuration and tool isolation under real managed policies still require
verification; the switch remains Experimental.

## Shared MCP and credentials

The existing `@modelcontextprotocol/sdk` **1.30.0 (MIT)** supplies the stdio protocol.
No dependency was added. A fixed Node stdio relay connects to a private per-run Unix
socket; SDK handlers remain in the executor process. The temporary directory is
private, the socket is mode 0600, and shutdown closes transports and removes it.
Tool routes remain server-side. Calls are serialized and invoke `authorizeTool`,
`executeTool`/`applyTool`, and `onToolCompleted`, retaining remote ceilings, approvals,
command recording, and exposure records. A pause closes subsequent queued calls.

The subprocess environment uses the host's once-per-process captured login PATH
and a shared OS discovery allowlist, including `SHELL`, `SSH_AUTH_SOCK`, the XDG
config/data/cache directories and `HOMEBREW_PREFIX` when present. `HOME` remains the
actual OS home so the owner's CLIs read their own sign-ins. The Electron supervisor
preserves this same allowlist before launching the packaged host. Provider keys,
OAuth variables, custom agent secrets, secret-pattern names and runtime injection
variables are not inherited. Windows reads the registry-backed PATH without a login
shell. A broken login profile keeps a default PATH and reports a diagnostic in
Settings and the run's single-paragraph environment note. The host command bridge
resolves approved absolute binaries from that PATH and accepts the executor's
`bash -c` arguments under the owner's Ask-first rules, with no caller environment
or pty. Host commands do not reload Bash's login profile. See the full
[environment and inventory policy](/docs/host-service/#owner-environment-and-tool-inventory). Native requests containing API-key or OAuth material are rejected.
The Pi API-key runtime remains separate. The credential-boundary scan is unchanged.

`run_subagent` is omitted from the native MCP surface: its real implementation is
inside Pi, while the executor branch only echoes a request. Exposing that branch
would report work that never ran. Shared helper execution remains unfinished.
Pi also rejects native pins for auxiliary calls; compaction/judging cannot silently
run a native pin through a Pi provider. A complete native auxiliary-call workflow
and detailed usage accounting remain unfinished.

## Persona impact and visible copy

- **Operator:** sees the selected runtime in the header and a recovery sentence when
  its binary, sign-in, model, or computer cannot honor the pin. Approval denial has
  no effect, and runtime/session provenance is retained for diagnosis.
- **Builder:** can select a runtime per bot using the same adapter and tool contracts;
  deterministic protocol tests do not require a subscription or network access.
- **Researcher:** a run retains its requested model, effort, runtime, and binding even
  after bot settings change; mismatches fail instead of contaminating comparisons.
- **Team lead:** children and duplicates preserve runtime intent. Packaged host
  pairing authorizes only the deployment owner; unpaired source deployments still
  require a single application user before using that OS sign-in.
- **Local-first user:** can use an installed vendor binary without adding an API key
  to Ardur; Pi remains the default and native services are optional.

Web/Electron and mobile settings add **Runs on**, with **Ardur (built-in)**,
**Claude Code (your claude sign-in)**, and **Codex (your ChatGPT sign-in)**.
The native-only **Experimental** switch communicates the release gate at the point
of selection. **Check again**, **Connect**, and **Continue with ChatGPT** appear only
in the native configuration flow. Unavailable selections stay visible.

Recovery copy includes **claude is not installed on this computer**,
**Not signed in — run `claude` in a terminal once**, and
**Codex app-server unavailable**. Unsupported computers report
**Claude Code runs on host computers for now — change the bot's computer or its runtime.**
These sentences identify the action needed to keep the saved pin usable. Removing
them would leave an unavailable choice without a recovery path. They appear only
where the native selection or failure makes them relevant.

The effort change adds only **requested** as visible copy, appended to the existing
effort label when it is not attested. Removing or hiding this suffix would make a
requested value look verified. It helps builders select deeper reasoning and lets
researchers and team leads distinguish requested effort from runtime evidence without
adding a persistent explanation. The pin picker uses the unchanged literal labels
`low`, `medium`, `high`, `xhigh`, and `max`, restricted by model and installed version.

## Official documentation checked

All entries below were checked on **2026-09-23**. Documentation and locally generated
protocol types are compatibility evidence, not evidence of a successful signed-in run.

| Flags, fields, or methods | Primary source |
| --- | --- |
| `--version`, `auth status`; `-p`, input/output `stream-json`, `--verbose`, `--include-partial-messages`; `--model`, `--effort`, `--system-prompt` | [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) |
| `--tools`, `--restricted`, `--strict-mcp-config`, `--mcp-config`, `--allowedTools`; `dontAsk`, `--permission-prompts none`; `--disable-slash-commands`, `--no-chrome`, `--settings`; `--resume`, `--session-id` | [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Shell selection from `SHELL`; `CLAUDE_CODE_SHELL` override (rechecked 2026-09-24) | [Environment variables](https://code.claude.com/docs/en/env-vars) |
| SDK overview and streaming event format | [SDK entry point](https://code.claude.com/docs/en/sdk), [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output), [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) |
| Exact IDs, supported effort, silent effort caps, `switchModelsOnFlag`, `fallbackModel` | [Model configuration](https://code.claude.com/docs/en/model-config) |
| Effort values, model-specific `xhigh`, separate `max`, and `ultracode` workflow semantics (rechecked 2026-09-24) | [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags), [effort levels](https://code.claude.com/docs/en/model-config#adjust-effort-level) |
| Application stream versus Remote Control: `SDKSystemMessage.model`, optional Remote-Control-only `effort`, and `SDKResultMessage.modelUsage` with no effort field (rechecked 2026-09-24) | [TypeScript message reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdksystemmessage), [result message](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage), [CLI streaming](https://code.claude.com/docs/en/headless#stream-responses) |
| `disableAllHooks` and managed-hook limitations | [Hooks reference](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks), [settings precedence](https://code.claude.com/docs/en/settings) |
| `app-server`, `initialize`, `initialized`; `account/read`, `account/login/start`, `account/login/completed`, `account/login/cancel`; `model/list`, `config/read` | [App-server protocol](https://learn.chatgpt.com/docs/app-server) |
| `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`; `item/agentMessage/delta`, `turn/completed`, `model/rerouted`; typed command/file approval requests | [App-server protocol](https://learn.chatgpt.com/docs/app-server) |
| `-c`, feature flags, `web_search`, `tools.view_image`, MCP configuration | [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [official configuration schema](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json) |

Generated types from `codex app-server generate-ts` on version **0.156.1** were also
checked. They use `on-request` for the approval policy and `read-only` for thread
sandbox mode; the returned sandbox policy uses `readOnly`. These exact wire values
take precedence over differently formatted examples in the prose documentation.

## Owner verification and release gates

1. Apply the additive migration through the normal deployment process. Run the API
   and worker directly on the host under its signed-in user, with a host `desktop`
   computer and a single Ardur user, or follow the [packaged host acceptance](/docs/host-service/#owner-acceptance).
2. Install the unmodified Claude binary yourself and run `claude` once to complete
   its own sign-in. In bot settings select **Runs on → Claude Code (your claude
   sign-in)**, select an offered exact model and `high`, and enable **Experimental**
   only when testing these gates. Without sign-in, settings show the terminal
   instruction; a run fails without switching to Pi.
   Use **Check again** to refresh the installed-version catalog. Save the pin and
   confirm `high · requested` in the header. Send a short message, then expand the
   Team row's **Executing** details and open the corresponding comparison result to
   confirm the same label. Inspect the saved run's `runtimePin.effort` and
   `runtimeInfo.effortAttested` separately. Repeat on mobile. A documented ordinary
   CLI stream is expected to remain requested even after a successful turn.
3. Select **Runs on → Codex (your ChatGPT sign-in)**. In a source deployment, choose **Connect**
   and use **Continue with ChatGPT** if needed. For the packaged host bridge, sign in
   through the installed Codex CLI first. After completion, choose an offered model and
   effort and enable **Experimental** for verification. Missing executables show
   the unavailable sentence; no ChatGPT login remains an actionable configuration
   failure. Existing Pi connections are not moved or copied.
4. Verify exact model and effort, ordinary/managed settings, startup hooks, MCP-only
   execution, denial with no effect, images, second-turn session continuity, and
   stop/restart recovery against the installed binaries. Inspect run pin and runtime
   info separately. Confirm that changing the bot affects new runs only.
5. Assign a container computer and verify the unsupported-computer sentence, with
   no native process launched. Verify web and mobile recovery controls and the
   runtime header. The web screenshot test is in `model-recovery.spec.ts`; native
   mobile chrome needs device verification.

Native turns consume the owner's vendor usage allowance and may use configured
vendor overage billing. This implementation neither changes vendor billing settings
nor estimates that cost. No signed-in model turn, real approval exchange, or native
device acceptance test is claimed by the offline suite.

## Merge and deployment

Keep `pi` as the additive default. Reconcile migration timestamp prefixes before
merging concurrent database work, regenerate Prisma, and apply the SQL before
starting an API or worker built with these fields. Older run JSON remains readable;
do not backfill or overwrite non-null run snapshots. Review concurrent model-picker,
pin-resolver, router, and executor edits together. Keep both native runtimes
Experimental until the release gates above are evidenced.

## Effort validation (2026-09-24)

- Installed CLI verification: `claude --version` reports **2.1.281**; `claude --help`
  lists `--effort <level>`; `claude auth status` exits successfully. Authentication
  output was discarded. Calling the updated `probeClaude` reports available at
  2.1.281 with the documented effort sets for all nine catalog models. These probes
  are not evidence of a signed-in model turn.
- `pnpm -r --workspace-concurrency=4 run check`: passed, including Expo's online
  dependency check. `EXPO_OFFLINE=1` was not needed.
- `pnpm exec biome check --write .`, followed by `pnpm lint`: passed with the
  existing 31 warnings and 7 informational diagnostics.
- Vitest: **32 files, 523 tests; 521 passed and 2 failed**. The selection includes
  every changed unit test, Claude runtime/process/MCP, runtime pins and sessions,
  executor suites, bot settings, host callbacks, Team, comparisons, and mobile.
  Every added effort test passed. The two failures also reproduce in an isolated
  source snapshot of `HEAD`: `apps/mobile/lib/api.test.ts` expects a legacy pin
  without the schema's default `runtimeKind`; `apps/mobile/lib/i18n.test.ts` reports
  pre-existing missing translations. These unrelated failures were not suppressed.
- `pnpm --filter @ardurbot/web intl:extract`: passed. The sole new message,
  `requested`, has translations in all eight non-English web catalogs and both
  non-English mobile catalogs; its mobile locale test passed.
- `git diff --check`: passed. No dependencies, database migrations, renames,
  commits, or publication were added. Usage and learning behavior are unchanged.
- The web screenshot case in `apps/web/e2e/model-recovery.spec.ts` now checks the
  five-level picker and `high · requested` header. It remains for CI; desktop
  Playwright, native device acceptance, and signed-in model turns were not run.

## Native-runtime validation before the host bridge

- `pnpm db:generate`: passed; no database migration was applied.
- `pnpm check`: blocked by the execution sandbox denying the `tsx` IPC listener
  used by token generation. The requested fallback,
  `pnpm -r --workspace-concurrency=4 run check`, passed.
- `pnpm exec biome check --write .`: formatted the implementation, but the sandbox
  rejected a write to a protected skill test. Formatting `apps packages scripts`
  passed, and the subsequent `pnpm lint` passed with existing warnings and infos.
- Vitest: **23 files, 343 tests passed**, covering every touched unit test plus
  executor, pin resolution, run pins, bot settings, and the unchanged credential scan.
  Native process fixtures and in-memory MCP transports keep this suite offline.
- `pnpm --filter @ardurbot/web intl:extract`: passed; all nine catalogs updated.
- `git diff --check`: passed. The new migration prefix is unique; historical
  duplicate prefixes were left unchanged.
- The desktop Playwright suite was not run. The added web screenshot test and
  native mobile UI still require CI/device verification. No authenticated vendor
  turn or real approval/session-recovery exchange was run.
