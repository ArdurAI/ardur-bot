# Hermes runtime (Experimental)

Hermes is a selectable bot runtime for an owner with a pinned, qualified Hermes
installation on a paired macOS or Linux host, or running Ardur natively on this computer in local mode or the dev stack. Windows is unavailable until its
native acceptance lane passes. Selecting Hermes reuses the bot's existing Ardur
connection, model, effort, computer, integrations, connectors, MCP assignments,
skills and plugins. It does not import local configuration or ask for a Hermes
account. A missing install, unsupported connection, non-host computer, or old host
relay protocol blocks execution without changing the saved pin. Local mode and the
dev stack still need a desktop host computer.

## Install Hermes from settings

On this computer, in desktop local mode or the dev stack, an owner who picks
Hermes and sees that it is not installed gets an **Install Hermes** button.
A paired host keeps that message and does not show the button. Windows stays
unavailable.

The button does not ask for a path, an address, or a version. It downloads the
pinned Hermes source from GitHub, uv 0.12.19 for this Mac or Linux computer,
and Python 3.13 with the locked packages for the extras `acp`, `mcp`,
`computer-use`, and `web`. Those packages are about 200 MB. uv chooses the
exact Python patch from its own checked list, and Ardur records that patch.

Ardur checks the download before the bot can use it. The unpacked files must
match git tree `daaffc303ae437041b7f76be17c5f61b14f2ce99`, the file tree of
commit `29112bef099274229cadff79cdff7bf7b99c4b77`. The uv download must match
its published checksum. If the files do not match, Ardur removes them and
stops. Ardur then writes `.ardur-install.json` with the commit, the tree, the
uv version, the Python version, and the time. Each later launch still checks
the pinned source-file hashes.

The files live under `<DATA_DIR>/hermes/runtimes`. The versioned directory is
`hermes-agent-29112bef0992`. When the checks pass, `hermes-agent` points at
that directory. Per-turn staging stays at `<DATA_DIR>/hermes/staging`.

## Install a pinned source checkout

The same revision can be placed by hand. From that checkout, create its
`.venv` with the project's own lockfile:

```sh
uv sync --locked --extra acp --extra mcp --extra computer-use --extra web
```

The install root must contain `pyproject.toml`, `uv.lock`, the pinned source
files and `.venv/bin/python`. It must **not** contain a project `.env` file.
A git checkout is accepted when `HEAD` is the pinned commit. A directory
without `.git` is accepted when `.ardur-install.json` records that same commit
and tree. Ardur checks the required source hashes and interpreter before
offering the runtime.

On both macOS and Linux desktop, the host-service install root is
`<desktop application data>/host-service/runtimes/hermes-agent` (a sibling of
the host service's `workspaces` directory). To keep a qualified checkout in a
different absolute location, set `ARDUR_HERMES_INSTALL=<install-root>` in the
desktop or host-service launch environment; that explicit path takes priority.
When running locally (local mode or the dev stack), the local Hermes root is
`<DATA_DIR>/hermes`, with per-turn staging at `<DATA_DIR>/hermes/staging` and
the managed install at `<DATA_DIR>/hermes/runtimes/hermes-agent`. A relative
`DATA_DIR` resolves against each process's working directory, so set
`ARDUR_HERMES_INSTALL` or a shared absolute `DATA_DIR` to keep one install
path across the stack.
The host probes no other location, including `PATH`, pipx, Homebrew or a
personal Hermes directory. Restart the desktop app or host service after
installing or changing the selector. A missing install shows "Hermes is not
installed on this computer." On this computer, that message is where **Install
Hermes** appears. An install that fails its safety check shows "The Hermes
install on this computer failed its safety check." When that install is the
managed one, **Install Hermes** appears again so reinstalling repairs it; an
install chosen with `ARDUR_HERMES_INSTALL` belongs to the operator and shows
the same message without the button. Windows shows "Hermes isn't available on
Windows yet."

The optional qualification lane needs an owner-provided install and fake
provider; run it separately from normal unit tests:

```sh
ARDUR_HERMES_INSTALL_LANE=1 ARDUR_HERMES_INSTALL=<install-root> \
  pnpm exec vitest run packages/adapters/src/hermes-install-lane.test.ts
```

The provider path accepts two kinds of API-key connections. Custom endpoints
(OpenAI-compatible servers and Ollama) expose Chat Completions directly, and
Ardur passes requests through unchanged. Every other key-based connection —
Anthropic, Google (AI Studio or a Vertex key), OpenAI, OpenRouter, Kimi for
Coding, Z.AI and the remaining key-based catalog providers — is translated
through Ardur's provider layer, so Hermes speaks the same Chat Completions
protocol either way. The real key stays in the worker; a per-turn grant stands
in for it, with the same request and token caps on both routes.

Sign-in (subscription) connections cannot back Hermes. Anthropic does not
permit third-party apps to offer Claude.ai login or to route requests through
Free, Pro or Max plan credentials, so a Claude subscription only works in
Anthropic's own apps; use an Anthropic API key instead
(<https://code.claude.com/docs/en/legal-and-compliance>). A ChatGPT sign-in is
sanctioned only inside Codex, which runs a stateful agent loop rather than the
plain model turns Hermes needs; use an OpenAI API key instead. The settings
picker keeps these connections visible but disabled with the reason, a run
pinned to one is refused, and any other sign-in connection is refused the same
way. A run on an Anthropic sign-in saved by an older version is refused with
"Reconnect with an API key." The chosen connection
must have a bounded context window and an output limit at most 65,536 tokens.
The pinned runtime rejects a model context window below 64,000 tokens. That
session-start refusal shows “Hermes needs a model with at least 64K context;
change the model and try again.” The context limit in bot settings controls
Ardur’s supplied instructions, not the model’s context window.
Effort is a requested value; seeing the outbound field does not prove the provider
applied it. The bot and run keep their exact credential, model, effort and revision.
Group member model choices must pass the same compatibility check. An admitted run
keeps its immutable pin even if the bot or group choice changes later.

The settings panel exposes three tunable limits and an Advanced inspector:
**Model calls per turn** (1–64, default 16), **Time limit (seconds)**
(1–600 s, default 180) and **Context limit (KiB)** (4–64 KiB, default 16).
They live together in a versioned bot field and are copied into the run pin.
Advanced edits the same document as strict JSON and previews the effective
configuration server-side; familiar harness keys for model, connections,
tools, paths, native memory, children or compression are rejected with a
specific reason because Ardur owns those. Native Hermes memory, learning,
child agents, automatic compression and independent provider routes stay
disabled in this release. A model call ceiling constrains broker
admissions; a started request with unknown usage retains its conservative
reservation. These are initial policy values, not measured performance or
spend promises.

## Host and tool authority

Hermes runs as a native process with the paired host owner's access. A model
catalog allowlist does not sandbox that process. The host verifies an explicitly
configured pinned install and launches it with a fresh synthetic home for each
turn. The generated configuration has no native provider collection, MCP servers,
plugins, hooks, copied skills, persistent memory, profile, background review or
automatic learning. Project discovery and inline shell are disabled. Only the
Ardur MCP bridge is supplied to the session. Ardur still owns tool assignment,
approval, routing, effects, replay and audit. The host's ephemeral loopback relay
uses a per-turn grant; the provider credential stays in the worker. The grant is
revoked on Stop, pause, failure, completion or lease loss, and the child and home
are cleaned up. Existing bot-secret tools remain backend-injected HTTP operations,
not values made visible to Hermes.

Ardur delivers required instructions and prior turns in a bounded, explicitly
labeled quoted context document. This is not native provider-role history parity.
Images are supported only when the selected connection and run transport accept
them. Ardur memory remains canonical. Provider usage is counted from broker
receipts; absent usage stays unknown, and ACP aggregate usage is not counted again.
Internal calls without a proven purpose are recorded as `unknown`. Run evidence
distinguishes the requested effort and observed outbound wire field from provider
attestation.

## Verification boundary

Deterministic unit tests use fake transports and providers. A real pinned install
must pass the opt-in launcher and ACP lane against a fake provider before native
acceptance is claimed. macOS and Linux need separate results; Windows remains
unavailable. Browser screenshot execution and packaged desktop acceptance also
require their own lanes. No benchmark result should mix Ardur/Hermes with the
built-in runtime or Hermes standalone. The five comparison identities are
Ardur/built-in, Ardur/Hermes, Hermes standalone, Ardur/Prime and Prime standalone.


## Model context limit

Hermes needs a model context limit of at least 64,000 tokens. The model picker
checks the connection on the server before saving and names **Settings → Models**
when the limit is too small. Exactly 64,000 is accepted. The built-in runtime can
still use a smaller saved window.

In **Settings → Models**, the context field shows the resolved connection limit.
Saved metadata wins over provider catalog facts. When neither is known, compatible
connections use 65,536 with **Context limit (estimated)**. An untouched estimate is
not saved as metadata. Hermes uses that estimate; the built-in runtime keeps its
conservative 32,768 budget until metadata or catalog capacity is known. Known catalog limits show **Context limit (from the provider)**.
The compatible endpoint catalog currently lists model IDs, not endpoint-qualified
context lengths, so those connections use saved metadata or the explicit estimate.

This is separate from a bot's **Context limit (KiB)**, which bounds the text Ardur
supplies to a turn. Changing that byte limit does not change the model's capacity.
An estimate is not proof of actual capacity; set the provider's documented limit
if it differs. No provider, model, effort, source pin or runtime fallback changes.

## Failure recovery

Only confirmed safe causes receive a specific sentence. An unknown startup
exception keeps the generic session-start message; a tool count alone is not a
diagnosis.

| Confirmed cause | Sentence | Next step |
| --- | --- | --- |
| Model context below 64,000 tokens | Hermes needs a model with at least 64K context; change the model and try again. | Change the model. |
| the tool list differs from the confirmed startup list | Hermes's tool list changed during startup. Check the connected tools and try again. | Check the named cause and try again. |
| the runtime did not confirm its effective settings | Hermes's settings were not confirmed. Check this bot's settings and try again. | Check the named cause and try again. |
| the model request exceeded a byte limit | Hermes's model request was too large. Narrow the task and try again. | Check the named cause and try again. |
| the model response exceeded a byte limit | Hermes's model response was too large. Narrow the task and try again. | Check the named cause and try again. |
| the model request was outside the run grant or its grant expired | Hermes's model request was outside this run's allowance. Narrow the task and try again. | Check the named cause and try again. |
| the provider returned HTTP 401 or 403 | Hermes's model provider rejected the connection key. Check it in Settings, under Models. | Check the connection key. |
| the provider failed with an HTTP error other than 401, 403 or 429, or an unknown safe reason | Hermes's model request failed. Check the connection in Settings, under Models, and try again. | Check the named cause and try again. |

Tool names in the profile allow-list, progress gate and provider broker share the
pinned MCP naming rule. Connected names containing punctuation use the same
underscores Hermes registers. Collisions are refused before a child is launched;
this does not grant any additional tool access.

Both main and tools-free summary requests accept the pinned streaming
`stream_options: { include_usage: true }`. Other streaming options and a streaming
option on a non-streaming request remain refused. Profile acknowledgment is still
required for summary turns.

Provider failure logs contain only a fixed reason, a fixed grant-refusal category
when known, and a validated HTTP status when available. They never include the request body, headers, raw exception text,
cause, or private ACP error data. Normal ACP summaries keep their existing
redaction boundary. Unknown provider errors remain unknown rather than being
guessed from their prose.

### Grant-refusal diagnostics

The visible allowance sentence remains unchanged. A category in the safe log
identifies the failed check, not the private value or a confirmed incident cause.

| Safe category | Failed check | Investigation |
| --- | --- | --- |
| `model` | Exact pinned model | Compare the launcher and grant model identities without recording their values. |
| `output-tokens` | Output cap or conflicting cap fields | Compare the launcher cap with the grant; do not raise the grant. |
| `tools`, `tool-choice` | Granted tool list or selection | Check the consented catalog and pinned name translation. |
| `messages` | Message shape or supported roles/content | Reproduce the unsupported shape with fake content. |
| `effort` | Shared effort validation | Check the pinned effort and route before changing the request. |
| `stream-options`, `sampling` | Strict streaming or sampling fields | Reproduce the unsupported shape; keep validation strict. |
| `context` | Required Ardur context absent from prepared messages | Check whether context loading, scanning or truncation changed the supplied document. |
| `request-bytes` | Encoded admitted body over its byte limit | Narrow the task; keep the byte limit. |
| `run-budget` | Reservation invalid or started receipt could not commit | Inspect admission/persistence safely; this category alone does not prove budget exhaustion. |
| `grant` | Grant identity, scope, lifecycle or active-run check | Check expiry, lease and revocation; never reuse another run's grant. |
| `unknown-field:<fixed name>` | Unsupported known request field | Reproduce that field with fake data before admitting it. |
| `unknown-field` | Any other unsupported field | Arbitrary names and all values stay out of the log. |

Known field names come from a fixed list. Typed failures and message-only paired
host callbacks preserve the category; unknown exception text still becomes a
generic provider failure. The HTTP response and conversation do not expose the
category, request body, headers or private error data. Old peers can retain the
generic provider failure when they do not recognize the newer fixed signature.
