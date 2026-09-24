# Packaged host service

The desktop app starts `apps/host-service` as a separate process. Closing its window
keeps the process with the existing dock/tray lifecycle. Quit stops it. The API and
worker remain in Compose; the host connects outward to the API and accepts only the
versioned logical operations in `packages/contracts/src/host-bridge.ts`.

```mermaid
sequenceDiagram
    participant Desktop
    participant Host as Host service
    participant API
    participant Worker
    Desktop->>API: Pair using owner's app session
    API-->>Desktop: One-time host token
    Desktop->>Desktop: Encrypt with safeStorage
    Desktop->>Host: Start compiled bundle; configuration over IPC
    Host->>API: Authenticated outbound WebSocket
    Worker->>API: Active run, bot, space, logical operation
    API->>API: Check owner, registration generation, run, computer, pin
    API->>Host: Logical operation
    Host->>Host: Confine paths; resolve approved executable
    Host-->>API: Bounded stream or tool callback
    API-->>Worker: Correlated stream or callback
    Worker-->>API: Acknowledge or authorize and execute tool
    API-->>Host: Acknowledgement or callback result
```

## Boundaries and limits

- One owner and one paired host per deployment. `host_registrations` stores the
  token's SHA-256 digest, registration generation and registered folders. Pairing
  cannot overwrite an existing host. Disconnect deletes the registration and closes
  its socket. The token never enters Compose, command arguments, logs or health.
- Desktop stores the encrypted configuration under its application data directory.
  Linux `basic_text` storage is refused. Only the app's active main frame can invoke
  pairing or open the native folder picker. The renderer receives no host token.
- The host opens no network listener. The native MCP relay uses a private local
  socket on macOS/Linux and an authenticated named pipe on Windows. The fixed relay
  sets `ELECTRON_RUN_AS_NODE=1`, including when launched by a vendor CLI.
- Host sockets require WSS outside loopback. Worker authentication is a
  purpose-separated HMAC of the existing deployment encryption key. The worker's
  internal API connection uses `API_INTERNAL_URL`; it never receives the host token.
- Each request carries run, bot, owner and space IDs. The API checks the active run,
  cancellation state, computer home and complete saved native pin. Stream frames
  return only to the worker socket that originated the request. Callback execution
  retains worker-owned tool routes, authorization and completion recording.
- Four simultaneous requests, eight unacknowledged stream frames per request,
  256 KiB per frame, 128 KiB per file, 8 MiB cumulative output per request and a
  15-minute operation deadline. Thus retained/transferred output is also bounded
  across the four host slots. Native queues and socket queues are bounded. A native
  turn occupies a slot while its tool callback can use another slot.
- Host loss, cancellation, overflow and revoked grants stop requests with a
  `RuntimeProblem`. Request IDs and disconnected runs are tombstoned for the API process lifetime. The
  reconnect path never resends a request. Giving a disconnected run a new request ID
  cannot resume it. Final acknowledgements are accepted only from the originating
  worker even when the host's terminal frame arrives first.
- Computer homes are derived locally from validated space and home identifiers.
  Their hash includes an unambiguous separator, so identifiers cannot collide across
  spaces. Team Computer file tools preserve absolute host paths for the service to
  validate; relative paths retain the existing bot workspace mapping.
  Caller-provided provider references cannot choose a host directory. Registered
  folders come only from the native picker. Cwd and files undergo realpath checks;
  traversal and symlink escape are refused. The existing contained file writer is
  reused. No caller environment or executable path is accepted.
- Host commands use the owner's tools and saved CLI sign-ins. In
  `packages/host-runtime/src/host-policy.ts`, `hostCommand` resolves `argv[0]` by name
  on the captured login PATH, checks that it is an executable file, and spawns its
  absolute real path with `shell: false`. A caller cannot provide an executable
  path, environment or pty. `bash -c <command>` and the executor's background wrapper
  are accepted without a shell grammar. The owner's Ask-first rules still apply
  to consequential commands before execution. Cwd and file-tool paths are confined
  to registered folders; cwd validation is not an OS filesystem sandbox for shell
  commands. Confined `mkdir -p` preparation retains the existing directory helper.
  Native Claude/Codex operations keep their fixed adapter arguments.
- Host workspaces persist under desktop application data. They are not copied into
  a container home store, and a host checkpoint does not overwrite that store with
  an empty export. Registered folders are not deleted by computer destruction.

## Owner environment and tool inventory

`packages/contracts/src/host-environment.js` defines one OS-variable allowlist for
`hostServiceEnvironment` in Electron and the host runtime. The host never inherits
the whole application environment. The allowed names are `PATH`, `HOME`, `USER`,
`LOGNAME`, `TMPDIR`, `TEMP`, `TMP`, `SystemRoot`, `WINDIR`, `LOCALAPPDATA`, `APPDATA`,
`USERPROFILE`, `LANG`, `LC_ALL`, `SHELL`, `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_CACHE_HOME` and `HOMEBREW_PREFIX`. Variables containing
`TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `CREDENTIAL`, names starting with `AWS_`,
and `GOOGLE_APPLICATION_CREDENTIALS` are excluded, case-insensitively. This includes
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN` and `NPM_TOKEN`.
Injection variables such as `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `ZDOTDIR`,
`LD_PRELOAD` and `DYLD_INSERT_LIBRARIES` are also excluded. Bot-managed environment
secrets are not injected into host commands. Electron adds its own fixed Node-mode
flags only for the host-service launch; native CLIs do not inherit those flags.

`getHostEnvironment` in `packages/host-runtime/src/host-environment.ts` captures one
login PATH per process and shares concurrent initialization. On macOS/Linux it
runs the owner's absolute `SHELL` (or OS login shell) non-interactively with `-lc`,
a three-second timeout and a 16 KiB output limit. NUL-delimited `printf` output
separates PATH from profile banners. Only PATH is imported from this output; the
rest of the login environment is never copied. `HOME` stays the actual OS home,
not the bot workspace, so CLIs can use their own configuration and keychains.
`SSH_AUTH_SOCK` preserves access to the owner's existing SSH agent.

A non-zero exit, signal, start failure, timeout, excessive output or empty PATH
keeps the inherited PATH and appends standard directories. macOS adds
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin`;
Linux uses `/usr/local/sbin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin` and
`/sbin`. The host retains this diagnostic for Settings and the run's environment
note: **Your login shell profile failed to load (<shell>, exit <code>); commands
run with a default PATH**. Restart the source processes or quit and reopen the
packaged app after fixing the profile. The diagnostic contains the shell name
and exit outcome, never profile output.

Windows does not launch a login shell. It reads machine and user `Path` values
using the system `reg.exe`, expands OS-directory references and uses the inherited
PATH if registry discovery fails. Each query has a two-second deadline. Executable
discovery uses absolute PATH directories and `.exe` files. Existing Windows
file-operation limits remain in effect.

`findNativeBinary` and host commands share the captured PATH. The executor uses
`HOST_BACKGROUND_WORK_LAUNCH` for host computers, with `bash -c` after its marker
setup. It does not reload a Bash login profile. Container computers keep their
existing login-shell behavior. A process that cannot start returns empty stdout,
non-zero code and **Command did not run: ...** with the reason. No command fabricates
successful output, including `echo`; a signal exit is also a failure.

Before each host run, `environmentNote` detects `git`, `gh`, `glab`, `kubectl`,
`helm`, `docker`, `podman`, `aws`, `gcloud`, `az`, `terraform`, `node`, `pnpm`, `npm`,
`python3`, `uv`, `go`, `cargo`, `claude`, `codex` and `ollama` on that PATH. It records
`gh --version`, only the exit code of `gh auth status`, and the first line of
`kubectl config current-context`, each with a two-second timeout. Authentication
output is discarded. Context text is bounded, control characters are stripped,
and emails and credential-shaped assignments are redacted. A failed sign-in probe
is **not checked**: its exit code alone cannot distinguish a signed-out account
from a failed network check. Other sign-ins are **not checked**. There is no
`aws sts get-caller-identity`, cluster endpoint lookup
or other cloud identity probe. GitHub CLI itself validates credentials against
its configured hosts when running `gh auth status`; that explicitly permitted
status command is not a strictly offline check.

The environment note stays one paragraph, for example: **This computer uses the
owner's tools and saved CLI sign-ins. Tools on this computer: gh 2.80.0 (signed in),
kubectl (context: "fixture-context"; sign-in not checked). Commands start in
registered folders; Ask-first rules apply to consequential commands.** A login
failure appends its diagnostic to that paragraph. The `computer.environment`
operation computes this on the packaged host, never in the worker container.
Health snapshots list executable names for Settings without running inventory
status commands on each refresh. Source-mode Settings uses
the same discovery implementation in the local API process, with a 30-second
snapshot and the existing single-user ownership check. The source worker captures
its own environment once; restart both processes after a profile change.

Settings → Computers shows **Tools: gh, kubectl, docker** (or **None detected**)
while connected, and shows the login diagnostic only when present. Web and Electron
share this view. Mobile renders the same information without mutation controls.
These labels let the operator see available tools and let the builder diagnose
PATH failures without a permanent explanatory panel. The local-first user keeps
existing sign-ins on the computer; the team lead retains approval and audit rules.

## Build and shared code

`packages/host-runtime` contains the executable desktop provider and native Claude
Code/Codex adapters, their MCP relay, process control, protocol transport and path
policy. Existing adapter import paths re-export the shared implementations. The
worker still runs them directly during source development. A catalog conformance
test checks the native Claude compatibility list against the pinned Pi catalog,
without putting Pi's provider SDKs in the host bundle.

The verified bundle is **798,952 bytes** (about 780 KiB). It contains the host agent,
desktop provider, native adapters, MCP server/relay, shared contract schemas and
command limits, ws, Zod, MCP validation dependencies and small ORPC helpers pulled
in through the contracts. Only Node built-ins remain external. Prisma, Pi and koffi
are absent; there are no runtime TypeScript or workspace imports.

`pnpm --filter @ardurbot/host-service build` uses esbuild to produce exactly
`dist/host-service.cjs`. The desktop build includes it as an extraResource. The
bundle test copies it to an isolated temporary directory and starts it without
workspace packages. It rejects external non-Node imports and Prisma, Pi or native
addon inputs. `pnpm dev` includes the source runner through tsx; without desktop IPC
pairing it is idle, and existing host-worker routing remains unchanged.

The new manifests declare cached **ws 8.21.3 (MIT)** and **esbuild 0.28.2 (MIT)**.
Both versions already existed in the workspace store. esbuild is a build dependency.
The existing MCP SDK 1.30.0 and Zod 4.6.2 are reused. An install with network access
must update the lockfile and normal workspace links before a frozen-lockfile build.
No package version was downloaded for this implementation.

The schema migration creates the mapped `host_registrations` table and a database
constraint enforcing one registration. Apply it before starting the new API/worker.
The connection hub runs in the API process; the host package has no database client.

## Owner acceptance

1. Use a desktop release and app images containing this change, with migration
   `20260924040000_host_bridge` applied by the usual Compose startup. Install the
   release DMG into Applications and open it. This change does not publish a release.
2. Choose **This computer**, finish deployment-owner sign-in, and choose **Use this
   Mac** in **Where should bots run?**. Open
   **Settings → Computers → This Mac → Set up**. Allow the OS secure-storage prompt.
3. Use **Add folder** to register a project folder. Confirm **Host service: Connected**,
   the detected CLI versions and **Tools:** inventory. Install and sign in to the unmodified vendor CLI
   separately if it is absent. Ardur does not collect vendor credentials.
4. Ask a host bot to run `command -v gh` and `gh auth status` separately in a
   registered project folder, and to report the second command's exit code without
   quoting account details. Confirm the installed binary is found and sign-in
   succeeds. Separating the commands keeps a pipeline's exit status from hiding a
   failed sign-in probe. Confirm its environment note lists the detected tools.
5. Assign a host computer to the bot, then select **Claude Code (your claude sign-in)**, an exact supported
   model and **low**, and enable **Experimental**. Ask the bot to read a small file in
   the registered folder. Verify the output, requested pin, native session and tool
   audit. Close the window and verify work continues; reopen it from the dock/tray.
6. Disconnect the host socket during a turn. Confirm a visible runtime failure and
   no automatic replay after reconnection. Start a new run explicitly.
7. Select **Disconnect this computer**. Confirm the token is revoked, an in-flight
   turn stops, and subsequent host work fails. Quit the desktop app and confirm its
   host process stops while Compose remains running.

8. In a disposable source session, launch with `SHELL` pointing to a temporary
   executable shell stub that exits with code 7. Restart API and worker; confirm
   Settings and the bot's environment note show the login-profile diagnostic,
   while standard tools remain discoverable. Repeat with a stub that sleeps past
   three seconds to confirm the timeout message. Restore the normal `SHELL` and
   restart. Do not modify a working login profile just to exercise this test.

Native turns use the owner's vendor allowance, including any vendor overage already
configured. No additional hosted service is required by this bridge.

## Visible copy and persona impact

The operator sees **This Mac** / **This computer**, **Host service: Connected**,
**Not running — open the desktop app**, or **Not set up**, with versions only while
connected. **Set up**, **Add folder**, **Remove**, and **Disconnect this computer**
appear only where usable. Failure text appears only after an action fails. These
labels identify the current grant, state or recovery action; there is no persistent
explanatory paragraph. Mobile shows status and folders without mutation controls.

The builder can inspect a single packaged executable boundary and its offline tests.
The researcher retains exact runtime pins and gets a failed run on host loss instead
of an unnoticed replay. The team lead retains owner/run/space authorization and tool
audit. The local-first user grants folders locally and can revoke the computer
without sharing vendor sign-in material with the API or worker.

## Remaining verification and platform limits

No DMG build, desktop Playwright run, signed-in vendor turn or real Windows/Linux
acceptance was performed in this sandbox. Windows executable discovery, named-pipe
construction, Electron launch environment and absolute taskkill invocation have
stub/source coverage. Windows host writes and directory creation fail closed: the
existing strong relative-handle writer depends on a native addon, incompatible with
the required single JavaScript artifact. The ordinary adapter retains that native
implementation. Windows cannot yet complete the Team Computer file workflow.

Native runtime model/effort, managed-policy isolation, vendor approval behavior and
session recovery remain Experimental release gates from the native-runtime ADR.
Codex sign-in remains in the user's own CLI; this protocol does not add a remote
vendor-login operation. The hub assumes one API process per deployment; horizontally
replicated API routing would need a shared connection owner before use.

## Validation for the host bridge

This record covers the original host bridge implementation, before host parity.

- `pnpm check` was blocked by the sandbox denying the tsx IPC listener used by UI
  token generation. `pnpm -r --workspace-concurrency=4 run check` passed across the
  workspace; a final focused host-runtime check also passed.
- `pnpm exec biome check --write .` formatted the changes. It reported a protected
  skill-file I/O restriction. `pnpm lint` passed with no error-level findings,
  30 warnings and seven informational findings.
- The selected Vitest regression command passed **46 files and 528 tests**. It
  includes protocol limits, host filesystem policy, fake-network command/file
  round-trips, disconnect failure, runtime callbacks, native adapter conformance,
  executor computer safety, desktop process supervision, packaged imports, bundle
  isolation, Settings copy and mobile's read-only surface.
- A separate pin-resolution run passed **three tests**. A desktop networking-helper
  run passed **12 tests**, excluding its
  loopback port-allocation test. That test and `browser-auth.test.ts` cannot run in
  this sandbox because opening listeners returns `EPERM`. Full desktop test runs
  were attempted; the browser-auth setup waits on its denied listener.
- `pnpm --filter @ardurbot/host-service build` and the isolated single-file bundle
  test passed. `pnpm --filter @ardurbot/web build` passed with chunk-size warnings.
- `pnpm db:generate` passed. The migration SQL is included but was not applied to a
  database. `pnpm --filter @ardurbot/web intl:extract` passed for all nine catalogs.
- `git diff --check` passed. No desktop Playwright suite, DMG build, commit or
  publication was performed. The added web screenshot case awaits CI.

## Validation for host parity

Checked on 2026-09-24:

- `pnpm check` hit the sandbox restriction on the UI-token generator's IPC listener.
  The requested fallback, `pnpm -r --workspace-concurrency=4 run check`, passed
  across the workspace. Final focused host-runtime, host-service and API checks
  also passed. Mobile dependency validation used Expo's offline map.
- `pnpm exec biome check --write .` encountered a protected skill-file write.
  Focused formatting passed, and `pnpm lint` passed with no errors, 30 existing
  warnings and seven informational findings.
- The selected Vitest suite covered 28 files and 229 tests: 228 passed, and the
  unchanged Claude catalog comparison exceeded the default 30-second test deadline.
  Its full five-test runtime file passed unchanged in isolation with the invocation
  option `--testTimeout=120000`. No repository test deadline was changed. Together
  these runs cover login capture, secret exclusion, inventory and redaction,
  Windows registry discovery, command failures and confinement, bridge round trips,
  native runtimes, executor computer behavior, desktop supervision, Settings and
  mobile rendering. New environment and inventory tests use stubbed processes and
  temporary binaries; Settings discovery is verified to skip status probes.
- Electron's packaged-import checks passed two tests. The isolated host-service
  bundle test and `pnpm --filter @ardurbot/host-service build` passed.
- `pnpm --filter @ardurbot/web intl:extract` passed for all nine catalogs, and
  `git diff --check` passed. The web screenshot case now includes inventory and the
  diagnostic; its CI screenshot remains pending. No desktop Playwright suite ran.
- Owner-authenticated CLI checks, installed desktop behavior and real Windows/Linux
  checks remain manual. The commands above do not establish those results.

## Primary documentation checked

- [Electron environment variables](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node):
  Node launch mode and the `runAsNode` fuse. This package does not disable that fuse.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage):
  OS key providers and Linux's detectable unprotected `basic_text` fallback.
- [ws API](https://github.com/websockets/ws/blob/master/doc/ws.md):
  `noServer`, authenticated upgrade handling, `maxPayload`, compression control,
  send callbacks and buffered output. The existing Hono server upgrade hook is reused;
  no Hono-specific WebSocket dependency is added.
- [esbuild API](https://esbuild.github.io/api/#bundle):
  bundling, Node built-in externals, package inclusion and metafile output inspection.

## Host parity documentation checked

Checked on 2026-09-24 against primary sources:

- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars):
  `CLAUDE_CODE_SHELL` documents Bash/zsh overrides and auto-detection from `SHELL`,
  then zsh and Bash on PATH and standard locations. The former
  [docs.claude.com settings address](https://docs.claude.com/en/docs/claude-code/settings)
  redirects to the current official site. The documentation does not say that an
  absent `SHELL` always selects Bash. Ardur still disables built-in tools with
  `--tools ""`; the executor's own login-Bash wrapper was a separate failure path.
- [GitHub CLI authentication status](https://cli.github.com/manual/gh_auth_status)
  and [its implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/auth/status/status.go):
  normal status uses an exit code, while JSON mode exits zero despite authentication
  issues. Ardur uses normal mode and discards its output. The implementation checks
  credentials against configured hosts; a failed or timed-out probe is not evidence
  that the binary is missing.
