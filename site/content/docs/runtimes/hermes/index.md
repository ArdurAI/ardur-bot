---
title: "Hermes runtime (Experimental)"
description: "Hermes is a selectable bot runtime for an owner with a pinned, qualified Hermes"
source_path: "docs/runtimes/hermes.md"
---

> [Source: docs/runtimes/hermes.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/runtimes/hermes.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Hermes is a selectable bot runtime for an owner with a pinned, qualified Hermes
installation on a paired macOS or Linux host. Windows is unavailable until its
native acceptance lane passes. Selecting Hermes reuses the bot's existing Ardur
connection, model, effort, computer, integrations, connectors, MCP assignments,
skills and plugins. It does not import local configuration or ask for a Hermes
account. A missing install, unsupported connection, non-host computer or old host
relay protocol blocks execution without changing the saved pin.

## Install a pinned source checkout

The supported upstream source is revision
`29112bef099274229cadff79cdff7bf7b99c4b77`. Place a checkout at that exact revision at the install
root. From that checkout, create its `.venv` with the project's own lockfile:

```sh
uv sync --locked --extra acp --extra mcp
```

The install root must contain `pyproject.toml`, `uv.lock`, the pinned source
files and `.venv/bin/python`. It must **not** contain a project `.env` file.
Ardur checks the required source hashes and interpreter before offering the
runtime; it never downloads or installs Hermes in this milestone.

On both macOS and Linux desktop, the managed install root is
`<desktop application data>/host-service/runtimes/hermes-agent` (a sibling of
the host service's `workspaces` directory). To keep a qualified checkout in a
different absolute location, set `ARDUR_HERMES_INSTALL=<install-root>` in the
desktop or host-service launch environment; that explicit path takes priority.
The host probes no other location, including `PATH`, pipx, Homebrew or a
personal Hermes directory. Restart the desktop app or host service after
installing or changing the selector. Until qualification passes, settings show
"Hermes is not installed on this computer."

The optional qualification lane needs an owner-provided install and fake
provider; run it separately from normal unit tests:

```sh
ARDUR_HERMES_INSTALL_LANE=1 ARDUR_HERMES_INSTALL=<install-root> \
  pnpm exec vitest run packages/adapters/src/hermes-install-lane.test.ts
```

The current provider path accepts direct `openai-compatible` and Ollama connections
that expose Chat Completions. Anthropic Messages, Responses-only endpoints, OAuth
connections and other routes have no qualified translator. The chosen connection
must have a bounded context window and an output limit at most 65,536 tokens.
Effort is a requested value; seeing the outbound field does not prove the provider
applied it. The bot and run keep their exact credential, model, effort and revision.
Group member model choices must pass the same compatibility check. An admitted run
keeps its immutable pin even if the bot or group choice changes later.

The settings panel exposes two limits: **Model calls per turn** (1–64, default 16)
and **Time limit** (1–600 seconds, default 180). They live together in a versioned
bot field and are copied into the run pin. There is no raw Hermes configuration
editor. A model call ceiling constrains broker admissions; a started request with
unknown usage retains its conservative reservation. These are initial policy
values, not measured performance or spend promises.

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
