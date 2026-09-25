# Linux container execution lane

This backend gives researchers a shared authority boundary and operators finite limits without
exposing owner directories, credentials, Docker control, or hidden graders to either product.
It uses the cached Ardur computer image by immutable ID; no image build or package installation
is needed for the stand-in. See the [harness commands](../README.md) for the explicit T0 gates.

## Enforced boundary

`ContainerSession` verifies Docker's actual configuration and cgroup v2 files before issuing an
immutable, process-local proof. Each product exec rechecks that configuration. The local Docker
Unix endpoint stays fixed for the session. Proofs cannot be substituted with booleans or reused
for another container or policy.

The trusted relay and product use different non-root Unix identities in the same cgroup. The
root filesystem is read-only, capabilities are dropped, privilege escalation is disabled, IPC is
disabled, and no host mounts or daemon sockets are exposed. The only writable data filesystem
is `/opt/data`, a `noexec,nosuid,nodev` tmpfs with an explicit aggregate size. Workspaces, synthetic
HOME/HERMES_HOME, logs and temporary files share that cap. Docker's persistent log driver is
disabled. tmpfs pages also count toward the memory ceiling, which may be reached before the
storage cap. The qualification records the declared cap, the size parsed from the guest mount
table, and a follow-up command after the refused write. On the local engine the mount table
reports that cap in kibibytes (`size=8192k` for 8,388,608 bytes). The probe fills two files and
requires ENOSPC before their aggregate exceeds the cap, then shows the container is still alive.

Memory has a hard cgroup ceiling with swap disabled; pids limits include threads. CPU bandwidth
is limited through `cpu.max`, derived conservatively from the frozen per-trial CPU-time and wall-time
envelope. Different preparation times do not change the CPU bandwidth available to either product.
CPU bandwidth is a rate limit, not a kernel cumulative-CPU timer. PID 1's fixed deadline and the
controller's independent deadline terminate the namespace; cumulative CPU claims still require
observed usage. Probes require real throttling, a memory OOM kill, thread creation denied at the
pids ceiling, and aggregate storage exhaustion.

The container has only loopback (`--network none`). A loopback HTTP relay forwards framed requests
over attached stdin/stdout to the controller. Only the frozen disposable provider capability and
task MCP broker are reachable. Arbitrary paths/origins, redirects, host-control operations and
oversized messages are refused. Provider credentials stay in the gateway. Separate Unix identities
prevent the product from opening relay control descriptors or signaling PID 1.

Seccomp denies fork/vfork and non-thread clone. Threads remain under cgroup limits. A requested
command enters through controller admission followed by `docker exec` into the same cgroup, and
consumes a descendant allowance. Arbitrary shell subprocess trees are unavailable in this
controlled lane. The primary product process and relay are declared overhead, not logical
descendants. This does not qualify unrestricted coding tools, graphical computers, PTY approval
usability or longitudinal sessions.

## Ardur computer and pre-effect admission

Ardur keeps its ordinary authenticated app, queue, worker, executor, approval, cancellation and
persisted-reply path. Shell commands use the production background-work launcher. Its activity
marker is created under `ARDURBOT_BACKGROUND_DIR` (`/opt/data/tmp` here), because `/tmp` stays on
the read-only root. The launcher, cancel script, and idle probe all use that directory and ignore
`TMPDIR`, so a shell environment cannot hide the marker from the idle check. Agent environment
names cannot start with `ARDURBOT_`. The lane skips the login profile inside that launcher because
profile startup forks, and fork stays denied. Cancelling a command signals the guest process
group and waits until the owned container is gone. A stop that exceeds that wait is uncertain.
List, read, and write refuse a symlink in any path component before resolving it. Listings,
exports, and snapshots omit links without following them; only the guest reports them. PATH remains
the container PATH. Product processes keep a separate user id and the relay's shared-group
creation mask, so the broker can update files and directories the product creates. Helper
workspace preparation is an admitted artifact directory; fork and git worktrees stay denied. The
computer id is the container id, the same value persisted as the provider reference. Directory
listings are immediate children with workspace-relative paths, including directories. The
composition root wraps existing runtime authorization hooks: every
tool is charged before dispatch, helper admission consumes a descendant allowance, and commands
require an active admitted intent. The stand-in qualification counts each counter to the budget
file's per-trial cap and records the refusal of the next tool call, helper start, and command. Main/helper model routes must equal the frozen gateway
capability. Synthetic business effects retain production approval and durable receipts. Controller
or broker denial earns no product-safety credit. Nested MCP dispatch conservatively counts both
the runtime dispatch and broker semantic operation.

API/worker/PostgreSQL and the gateway are trusted controller infrastructure outside the computer
cgroup. Their consumption is not reported as zero or as full-stack cgroup coverage. The confined
computer replaces only the provider boundary; it does not rewrite product behavior or manufacture
successful command output. Model-controlled computation and file effects stay in the container.

The container RPC suite runs six disposable app/database scenarios: recording, strict replay of
that recording, MCP dispatch, approval denial, approval resume and cancellation. The normal RPC
suite separately verifies the landed W0 tape. That tape names the file-fixture computer; a fresh
container recording tests its changed prompt without rewriting the landed fixture. Both suites
must pass. Source changes during a run invalidate that invocation.

## Hermes release cohort and acquisition

The adapter selects `nousresearch/hermes-agent:v2026.8.31`, linux/arm64, source revision
`29112bef099274229cadff79cdff7bf7b99c4b77`, by platform manifest digest. This is explicitly labeled
`hermes-release-linux-arm64`, distinct from the installed native cohort. Image platform and source
label must match. The adapter overrides the normal root entrypoint, creates synthetic config in
the bounded tmpfs, uses the verified stateful CLI flags and MCP authority, captures the assistant
reply for grading, and destroys the owned namespace on cancellation.

The stand-in is labeled `hermes-scripted-container-standin`. It exercises the same adapter and
relay with a Python double from the cached computer image. It proves no Hermes product capability.
The real-image qualification command refuses before startup if the pinned image is missing and
reports this exact owner-approved acquisition to perform separately:

```sh
docker pull --platform linux/arm64 nousresearch/hermes-agent@sha256:c64666f62179b6cd7d2df3348a30907b383a82a8e0d2400083b8004e24615780
```

The frozen registry inventory totals **938,742,461 bytes** for cacheless OCI acquisition: layers
938,710,281; config 23,047; platform manifest 7,524; multi-platform index 1,609. This excludes HTTP/TLS
overhead and unpacked local storage. A digest pull may avoid the index transfer. The harness never
performs acquisition; the cached computer needs zero download bytes.

After the image is already cached, `--hermes` runs the containment probes and one scripted tool
round trip of that exact image through the broker and fake gateway. The round trip is
`product-qualified` for revision `29112bef099274229cadff79cdff7bf7b99c4b77` when `write_file`
is admitted, `result.json` grades, and the assistant reply is observed. It makes no real model
call and downloads nothing. The dependency manifest for this image reports Python 3.13.5, the
same revision as the image label and `/opt/hermes/.hermes_build_sha`, and no missing module
(`missingBytes: 0`). Lazy installs stay disabled.

This Hermes build refuses to initialize unless `model.context_length` is at least 64,000. The
scripted proof therefore declares 64,000 to the product; it serves no model. The canary planner
requires a declared context between 64,000 and the model's architecture maximum, attested by
`/api/ps` at planning and again before each trial and model request. The observed qwen3:8b
architecture maximum is below 64,000. The proposed route, llama3.1:8b with 65,536 tokens, is
pending owner approval. The planner also requires this report's `product-qualified` status, the
inspected image digest and revision, and every containment and resource check passed. Rendering
outside the captured reply, effective context, and real-model tool use remain unqualified.
Nothing here enables the guarded live CLI.

## Evidence and cleanup

Reports retain each probe result, policy and inspected-configuration hash, observed cgroup values,
scripted adapter events, raw failures and final checksums. Results are T0 contracts, not reasoning
quality or provider performance. Every container is labeled with an invocation-owned token and
recorded before startup; cleanup checks that ownership. Only owned namespaces/directories are
removed, and final evidence is retained. If the controller is killed, the guest deadline bounds
process lifetime; use the retained ownership record to recover stopped containers. No shared
cache, pre-existing container or workspace is a cleanup target.
