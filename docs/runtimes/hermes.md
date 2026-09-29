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
