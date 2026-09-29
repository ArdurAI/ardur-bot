# Virtual machine computers (design)

Status: design only; nothing in the app creates or manages virtual machines yet.
The reviewed Lima template is
[`infra/sandboxes/vm/lima-computer.yaml`](../infra/sandboxes/vm/lima-computer.yaml); it passes
`limactl validate` with Lima 2.2.0 for both `vz` and `qemu`, but no VM has been booted from it. Points that still need a live run are marked **To verify** and listed in
[What is not verified yet](#what-is-not-verified-yet).

A bot on a container computer cannot build containers or start a kind cluster safely: the
container has no engine, the host engine's socket would hand over every container on that engine,
and kind needs privileged node containers, which the Kubernetes path forbids. A virtual machine per
computer moves the boundary one layer down. Builders test containers and clusters without risking
their machine. Local-first users need no hosted service. Operators get fixed resource limits, sleep
and wake, and a single place to remove what a computer left behind.

## What the owner gets

- A new computer kind, **Virtual machine** (engine and kind `vm`). Each bot computer placed on a
  virtual machine connection gets its own VM; a Team Computer is one VM shared by its bots.
- The VM is a full Ubuntu 24.04 LTS system with Docker Engine (rootless, with Buildx and Compose),
  kind and kubectl. `docker run hello-world` and `kind create cluster` work from the bot's shell.
- It runs on the owner's machine through [Lima](https://lima-vm.io/): Apple's Virtualization
  framework (`vz`) on macOS 13 or later, QEMU with KVM on Linux. Lima is installed by the owner
  (for example `brew install lima`); Ardur adds no dependency and bundles no hypervisor.
- **Windows is not offered.** Lima lists Windows hosts as untested on its
  [installation page](https://lima-vm.io/docs/installation/), and its
  [WSL2 driver](https://lima-vm.io/docs/config/vmtype/wsl2/) is experimental, needs rootfs
  archives instead of disk images, and leaves many options unsupported. The **Virtual machine**
  option is not shown when the host is Windows. A Windows owner can run a Linux VM they manage
  and add it as an SSH machine, which [Fleet](fleet.md) already supports.
- The bot is an ordinary user inside its VM, not root. It is root inside its own containers.
  [Security model](#security-model) explains why: Lima's default network lets a guest reach every
  service listening on the host's localhost, and only a firewall the bot cannot change closes that.
- A VM always reaches the public internet. A computer whose network access is turned off cannot
  use one ([Network access](#network-access)).

## Architecture

```mermaid
flowchart LR
  Worker[Worker] -->|dev stack, desktop local mode| Fleet[FleetService on the host]
  Worker -->|worker in a container| Bridge[Host bridge: computer.remote.call] --> Fleet
  Fleet --> Provider[LimaSandboxProvider]
  Provider -->|create, start, stop, delete, list| Lima[limactl, LIMA_HOME = ~/.ardurbot/vm/lima]
  Provider -->|commands, files, terminal, checkpoints| SSH[OpenSSH as bot to 127.0.0.1:port]
  Lima --> VM[Ubuntu VM]
  SSH --> VM
```

### Provider

`LimaSandboxProvider` (new, `packages/host-runtime/src/fleet/lima.ts`) extends
`LinuxFleetSandbox`, like `SshSandboxProvider`. Lifecycle calls go to `limactl`. Everything else
(commands, files, the interactive terminal, workspace export and import) goes through an internal
`SshSandboxProvider` per VM, pointed at `127.0.0.1:<sshLocalPort>` as the guest user `bot`. It
reuses Fleet's OpenSSH argv, BatchMode, strict host keys, SFTP staging, descriptor-confined file
scripts, bounded tar checkpoints and `FleetTerminal`, so none of that is written twice.

```ts
export class LimaSandboxProvider extends LinuxFleetSandbox {
  constructor(settings: ComputerConnectionSettings, options: {
    limaHome: string;            // ~/.ardurbot/vm/lima
    deployment: string;          // label: first 16 hex of SHA-256 of the deployment id
    processes?: FleetProcess;    // tests inject a fake limactl on PATH
    platform?: NodeJS.Platform;
  });
  describe(): SandboxDescriptor; // id and kind "vm", FLEET_LINUX_CAPABILITIES
  provision(): Promise<ComputerRef>;  // derives the name, refuses network off; no VM work
  prepare(): Promise<void>;           // create if missing, start if stopped, check readiness
  stop(): Promise<void>;              // never starts a VM; best-effort cleanup, then limactl stop
  destroy(): Promise<void>;           // limactl delete --force, then drop the host-key pin
  supportsNetworkEgress(): Promise<boolean>; // false: network access cannot be turned off
  capacity(): Promise<CapacitySnapshot>;
  test(context): Promise<{ os: "Linux"; version: string; capacity: CapacitySnapshot }>;
  images(ids: string[]): Promise<ImageState[]>; // this deployment's image references
  reconcile(instances: { name: string; active: boolean }[]): Promise<ReconcileResult>;
  remove(name: string): Promise<void>; // an unused VM, after the owner confirms
  closeAll(): Promise<void>;           // stop running VMs when the app quits
}
```

These rules hold for every call on the host:

- **One lifecycle operation per VM, across processes.** `prepare`, `stop`, `destroy`, `remove`
  and the reconciler's stop hold the VM's lock for their whole run. Each takes it once, at its top
  level, and nothing inside it takes the lock again, so an operation never waits on itself. The
  lock must work across processes: in the dev stack and in desktop local mode the API and the
  worker are separate processes (`scripts/dev.ts`, `apps/desktop/src/local-mode.ts`), both reach
  `FleetService` without the host bridge, and both can run `limactl` for the same VM (the worker
  for runs; the API for the manual boot route, the reconciler and `images`). It is a **database
  lock**: a Postgres session advisory lock, taken with `pg_try_advisory_lock` and polled, the
  pattern the board's filing locks already use (`packages/adapters/src/board/service.ts`). Its
  key is namespace 1380019075 with id 5 in the low three bits and the hash of `vm:<name>` above
  them (ids 1 to 4 are taken). Postgres releases a session lock when its connection ends, so a
  crashed API or worker never leaves a VM locked, and it grants a lock that the same session
  already holds again, so calls in one process first queue on an in-process lock per key
  ([advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)).
  Each process holds its VM locks on one dedicated connection from its lock pool
  (`createFilingLockPool`, `packages/db/src/client.ts`), kept while it holds any. If that
  connection breaks, its locks are gone: operations already running finish, and new ones wait for
  a new connection. In bridge mode the host service is the only process of its deployment that
  runs `limactl`, and it has no database, so it uses the in-process lock alone. `host-runtime`
  sees only a `VmLocks` interface; `localFleetService(locks)` receives the Postgres one from the
  API's and the worker's startup. A lock file was rejected: Node has no `flock`, so a lock file
  needs a stale-lock rule, and breaking a stale lock races with a new holder. A row lock was
  rejected too: `SELECT … FOR UPDATE` holds a transaction open for as long as the lock, up to 14
  minutes.
- **Last use is a file stamp.** Every provider call for a VM sets the modification time of
  `~/.ardurbot/vm/used/<name>` when it starts, every minute while it runs, and when it ends. Any
  process on the machine can read it, so the reconciler sees the worker's calls, and a call that
  is still running always looks recent.
- **A stopped VM is started first, except by `stop`.** Every SSH-backed call (commands, files,
  the terminal, export and import) reads the instance's status and, if it is `Stopped`, runs the
  wake path under the lock before it connects, then releases the lock for the SSH work itself.
  After Quit, computer rows can still say running while their VMs are stopped; a checkpoint, a
  file listing or a terminal then wakes the VM instead of failing. `stop` never starts a VM (see
  [Readiness and time limits](#readiness-and-time-limits)).

The VM name is `ardur-` plus the first 16 hex characters of the SHA-256 of
`fleetComputerKey(spaceId, homeKey)` and the connection id, so each computer gets a different VM on
each VM connection. `fleetComputerKey` is the hash Fleet already uses for SSH homes and remote
containers. The name is shorter than a container's because of Lima's socket path limit (see
[Ardur's Lima home](#ardurs-lima-home)). It is deterministic, so the API can compute every VM name
from its computer rows (which hold the connection id) without a stored reference. The
`ArdurComputer` label records the first 24 characters of `fleetComputerKey`. `prepare` refuses an
existing instance whose labels do not match the computer and the deployment, or whose `cpus`,
`memory`, `disk` or `vmType` in `limactl list --json` differ from what `vmLimits` gives for the
connection's settings, with "This virtual machine is damaged. Reset it in Settings, Computers." It
never adopts a VM of another size silently. Moving a computer between two VM connections (a resize)
therefore always creates a new VM, even when a `recover` move could not delete the old one:
`replaceComputer` ignores a failed destroy in that mode (`computer-lifecycle.ts`), and the old VM
then has no computer row and is reported as unused. The reference is `vm:<name>`; `fresh` is true
when the instance did not exist yet.

### Lima commands

Every call is an argv array through `FleetProcess` (no shell), with `LIMA_HOME` set to Ardur's own
directory and `--tty=false` so nothing prompts. `limactl` is resolved from the owner's `PATH` with
the existing `resolveHostBinary`.

| Operation | Command | Notes |
| --- | --- | --- |
| Check | `limactl --version` | Parse `limactl version X.Y.Z`; require 2.2.0 or later, the version the template was validated with. |
| Create | `limactl --tty=false create --name <name> --set .vmType="vz" --set .cpus=2 --set .memory="4GiB" --set .disk="40GiB" --set .images=[…] --set .param.ArdurComputer="…" --set .param.ArdurDeployment="…" --set .param.ArdurVmType="vz" <template>` | `<template>` is the embedded template written to a private temporary file. `cpus`, `memory` and `disk` come from the connection's resource fields (see [Contracts](#contracts)); `ArdurVmType` always equals `vmType`. `.images` points at Ardur's verified local image (see [Image download](#image-download)). Values are JSON-encoded from validated settings. `create` is not configuration only: it runs Lima's `instance.Prepare` ([`cmd/limactl/start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/cmd/limactl/start.go), `createAction`), which checks the local image's digest and copies it into the instance ([`pkg/downloader/downloader.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/downloader/downloader.go), `copyLocal`), then converts it into the instance's disk (raw for `vz`) and resizes that disk ([`pkg/instance/start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/start.go), `Prepare`; [`pkg/driverutil/disk.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driverutil/disk.go), `EnsureDisk`). That is the heaviest disk work before the first boot. |
| Start and wake | `limactl --tty=false start --timeout <duration> <name>` | `start` runs `Prepare` again, which skips the image once the disk exists; `--timeout` bounds only the wait for the host agent's events after that ([`start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/start.go), `watchHostAgentEvents`). The duration comes from `prepare`'s time budget (see [Readiness and time limits](#readiness-and-time-limits)). |
| Sleep | `limactl --tty=false stop <name>` | `stop --force` if the graceful stop fails or takes more than two minutes. |
| Destroy | `limactl --tty=false delete --force <name>` | Removes the instance directory, including its disk. |
| State | `limactl --tty=false list --json` | One JSON object per line. Ardur reads `name`, `status` (`Running`, `Stopped`, `Broken`, …), `dir`, `vmType`, `cpus`, `memory` and `disk` (both in bytes), `sshLocalPort` and `param`. |
| SSH details | not `show-ssh` | `limactl show-ssh` is deprecated since Lima 0.18. Ardur builds its own OpenSSH options from `sshLocalPort` and the key path, like any SSH machine. |

### Readiness and time limits

`limactl start` waits for provisioning to finish, but not for it to succeed. Lima 2.2.0's host
agent checks three groups of requirements over SSH, in order: essential, optional (which include
any readiness probes, in plain mode too) and final
([`hostagent.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/hostagent/hostagent.go),
[`requirements.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/hostagent/requirements.go)).
The final requirement waits until the guest's boot script has written this boot's instance id to
`/run/lima-boot-done`, which it does after every provisioning script has run, whether the scripts
succeeded or not
([`boot.sh`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.TEMPLATE.d/boot.sh)).
Each requirement is retried up to 200 times, 3 seconds apart, and one that still fails makes
`start` return a "degraded" error
([`start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/start.go)). `--timeout`
bounds the whole wait; on a timeout `start` returns an error and leaves the VM running. Lima's
issue [#209](https://github.com/lima-vm/lima/issues/209) stays open for its second half: a
failing provisioning script does not fail `start`.

So the template has no readiness probe: a probe runs before the final requirement and would only
add retries. The provisioning script records its own outcome instead: `/run/ardur-ready` as its
last step, or `/run/ardur-failed` with a reason on any non-zero exit, through an `EXIT` trap that
covers an explicit `exit` as well as a failing command. The reason is a hint: for a failing
pipeline, bash's `$BASH_COMMAND` names the pipeline's last command, not the one that failed. Both
markers are files directly in `/run`, which is owned by root with mode 755 and empty at every
boot, so the bot cannot create or change them. (Not all of `/run` is closed to it: `/run/lock` is
world-writable and `/run/user/2000` belongs to the bot.)

The marker is a readiness signal, not a safety gate. `prepare` checks it with a command in the
bot's own SSH session, and Ubuntu's bash reads `~/.bashrc` for SSH commands (it is built with
`SSH_SOURCE_BASHRC`,
[`config-top.h`](https://git.launchpad.net/ubuntu/+source/bash/tree/config-top.h?h=applied/ubuntu/noble-updates)),
so a bot that has already used its VM can make that check pass. That only hides a broken setup
from Ardur, on the bot's own computer. Nothing that protects the host depends on the marker: the
firewall loads before the network starts at every boot, whatever provisioning does (see
[The firewall at boot](#the-firewall-at-boot)).

#### First boot and wake

A **first boot** is any `prepare` of a VM that has never passed the readiness check. The host
records that check: after the first readiness check that passes, the provider writes
`~/.ardurbot/vm/provisioned/<name>`, and it deletes the record with the VM (and when a create
finds a stale one). A **wake** is a `prepare` of a VM that has the record. Whether this `prepare`
ran `create` does not matter: a VM whose first provisioning was cut short by Quit or a crash is
still on its first boot when it is retried, and gets the first-boot budget again. The provisioning
script is safe to rerun: its slow step starts over until it records its pinned versions, and an
install that the interruption left half done is finished first (see
[Provisioning](#provisioning)).

#### The time budget

`prepare` stays under the host bridge's 15-minute limit for one operation
(`apps/api/src/host-hub.ts`): its three steps take at most 13 minutes, and the cleanup after a
failure (below) at most one more minute and a forced stop. It logs how long each step took:

1. `create`, if the instance is missing, bounded at 3 minutes. Most of it is the image copy and
   disk conversion above. **To verify:** the measured time; the manual acceptance run records it
   and the bound is set from it.
2. `start`, if the VM is not running, with `--timeout` set to the time left until the 12-minute
   mark on a first boot, or 3 minutes on a wake. The provider stops waiting for the `limactl`
   process at the same moment, because `start`'s own `Prepare` step runs before `--timeout`
   applies.
3. One SSH session as `bot`, bounded at 60 seconds, that requires `/run/ardur-ready` and runs
   `docker version`, `kind version` and `kubectl version --client`. The script already waited for
   the bot's Docker to answer before it wrote the marker.

A first boot must also fit Lima's own budget: the final requirement gives provisioning about ten
minutes after SSH comes up. **To verify:** the first-boot time on an ordinary connection; the
manual acceptance run records it.

#### Failure and rollback

Every failure in these steps ends `prepare` with one sentence, "The virtual machine could not
finish setting up. Check the internet connection and try again.": a `create` or `start` error or
timeout, a login refused because provisioning stopped before the bot's account existed, a missing
ready marker, or a failing tool. The provider logs the reason from `/run/ardur-failed` when it can
read it, and the path of the instance's `ha.stderr.log`.

`prepare` cleans up after itself before it throws, still under its lock: if it began a `start`, it
stops the VM with `limactl stop`, then `stop --force` if that fails or takes more than 60 seconds,
the same bound as Quit. On a timeout `start` returns but leaves the VM running (see above), and
killing the `limactl` client does not stop it either, because `start` runs the host agent as a
separate process in its own process group
([`start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/start.go), `StartWithPaths`;
[`opts_others.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/executil/opts_others.go)); only
`stop` does. A VM that was already running when `prepare` began is left running. The lifecycle's
rollback then runs as today (`rollbackProvisionedComputer` in `computer-lifecycle.ts`): it destroys
a fresh VM with `delete --force`, which also stops a running one
([`limactl delete`](https://lima-vm.io/docs/reference/limactl_delete/)), or calls `stop` on one that
already existed, which finds it stopped and does nothing. Because every step ends in a `limactl`
command that is bounded and forced, a failed `prepare` leaves no VM running and gives the single
sentence, not the "could not be rolled back" error.

`stop`, for sleep, idle suspend and rollback, never starts a VM and never waits on SSH:

- It takes the VM's lock and reads the instance's status. A `Stopped` VM needs nothing more.
- A `Running` VM gets the existing in-guest cleanup (revoke terminals, `LinuxFleetSandbox`'s stop
  script) through the internal SSH provider directly, not through the wake path, bounded at 30
  seconds including the connection, with any failure (for example a guest whose provisioning never
  created `bot`) logged and ignored.
- It always ends with `limactl stop`, then `stop --force` if that fails or takes more than two
  minutes. A `Broken` VM goes straight to `stop --force`.

#### The boot claim

A VM `prepare` can take up to 14 minutes, but the lifecycle treats a `booting` claim older than
`BOOT_CLAIM_STALE_MS` (5 minutes, `computer-lifecycle.ts`) as abandoned unless a run lease is
still heartbeating, and a boot outside a run has no run lease (for example the manual
`computer.boot` route in `apps/api/src/router.ts`). A second caller could then reclaim a live VM
boot, and the first caller's rollback would destroy the fresh VM under it. So `provisionComputer`
renews its claim every minute while `provision` and `prepare` run: it sets `updatedAt` on the row
where `id`, `state: "booting"` and its own `provisioningId` still match, and it waits for the
renewal in flight to finish before it activates or rolls back. The five-minute rule then means
five minutes without a renewal. A crashed worker's boot is still reclaimable five minutes after it
died, and a live `prepare` is never reclaimed, however long it takes. Activation and the failure
write already match on `provisioningId`, not `updatedAt`; activation uses a stamp later than the
last renewal. A reclaimer that observed an older stamp fails its compare-and-set, as it does
today. The renewal applies to every engine: it only keeps live claims live.

### Ardur's Lima home

Ardur never uses the owner's `~/.lima`. It sets `LIMA_HOME=~/.ardurbot/vm/lima` for every call:

- Lima merges `$LIMA_HOME/_config/default.yaml` and `override.yaml` into every instance, and list
  settings such as `mounts` are combined rather than replaced (see the end of Lima's
  [reference template](https://github.com/lima-vm/lima/blob/v2.2.0/templates/default.yaml)). A
  dedicated home means the owner's own Lima settings can never add a mount or port forward to a
  bot's VM.
- Lima refuses to create an instance unless `<instance directory>/ssh.sock.1234567890123456` (the
  SSH control socket plus the 16 characters OpenSSH appends) is shorter than `UNIX_PATH_MAX`: 104
  characters on macOS, 108 on Linux
  ([`create.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/create.go),
  [`filenames.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/filenames/filenames.go),
  [`osutil_others.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/osutil/osutil_others.go),
  [`osutil_linux.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/osutil/osutil_linux.go)).
  Lima measures that path after resolving symbolic links: once `LIMA_HOME` exists, `LimaDir()`
  returns `filepath.EvalSymlinks` of it
  ([`dirnames.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/dirnames/dirnames.go)).
  So the provider first creates `~/.ardurbot/vm/lima`, takes its real path with `fs.realpath`,
  and applies the same rule to `<real path>/<name>/ssh.sock.1234567890123456` before `create`,
  refusing with "This computer's home folder path is too long for virtual machines." Test and
  discovery check the same rule. With 22-character VM names (`ardur-` and 16 hex characters), the
  real path of Ardur's Lima home can have up to 54 characters on macOS and 58 on Linux: without
  symbolic links, a home folder path of up to 36 characters (`/Users/` and a 29-character account
  name) or 40 (`/home/` and 34). A home folder or `~/.ardurbot` that is a symbolic link counts
  with the length of its target. The host service's own data directory under
  `~/Library/Application Support/…` is far longer, so the VM home cannot live there.
- Ardur's VMs stay out of the owner's `limactl list`. To inspect them by hand:
  `LIMA_HOME=~/.ardurbot/vm/lima limactl list`.

| Path under `~/.ardurbot/vm/` | Owner | Content |
| --- | --- | --- |
| `lima/` | Lima | Instances, and `_config/user`, the private key Lima generates for its instances. |
| `images/<image id>-<arch>.img` | Ardur | A verified Ubuntu image, shared by every VM of every deployment on the account. |
| `images/refs/<deployment>` | Ardur | The image ids that one deployment's VM connections use. |
| `images/<image id>-<arch>.img.<random>.part` | Ardur | A download in progress; each writer has its own. |
| `known_hosts/<name>` | Ardur | The VM's pinned SSH host key. |
| `provisioned/<name>` | Ardur | Written when the VM first passes the readiness check; it makes later starts wakes. |
| `used/<name>` | Ardur | Empty; its modification time is the VM's last provider call. |
| `tombstones/<name>` | Ardur | A destroy in progress, retried after a crash. |

Directories are created with mode 0700 and files with 0600. The VM locks are not files (see
[Provider](#provider)).

### Where the calls run

| Setup | Who runs `limactl` | Path |
| --- | --- | --- |
| Dev stack (`pnpm dev`, worker on the host) | The worker for runs; the API process for the manual boot route, reconcile, `images` and `remove` | `ComputerConnections.resolve` → `localFleetService(locks).provider()` → `LimaSandboxProvider`, with the Postgres VM locks |
| Installed desktop app, local mode | The app's own worker and API processes, on the host | Same as the dev stack |
| Worker in a container (`ARDURBOT_HOST_BRIDGE=api`) | The host service only | `RemoteFleetSandbox` → `computer.remote.call` → `HostAgent` → `FleetService.call` → `LimaSandboxProvider`, with the in-process VM locks |
| Server with no connected host service | Nobody | Virtual machine connections are unavailable, and **Test** says why. A container cannot run a hypervisor. |

The existing `computer.remote.call` actions (`capacity`, `test`, `provision`, `prepare`, `sleep`,
`destroy`, `exec`, `files.*`, `export`, `terminal.*`) carry VM computers unchanged. Deployment-wide
VM work gets one new operation, `computer.remote.vm`, which only the API may originate (like
`computer.remote.discover`):

```ts
z.strictObject({
  op: z.literal("computer.remote.vm"),
  action: z.discriminatedUnion("type", [
    // Record the image ids this deployment's VM connections use, start or join the verified
    // download of any that are missing, and delete images that no deployment uses.
    // Result: per id { state, receivedBytes, totalBytes }.
    z.strictObject({ type: z.literal("images"), images: z.array(imageId).max(16) }),
    // Stop VMs whose computers are not active.
    // Result { stopped: string[], unused: { name: string, diskBytes: number }[] }.
    z.strictObject({ type: z.literal("reconcile"), instances: z.array(instance).max(1000) }),
    // Remove one unused VM after the owner confirms.
    z.strictObject({ type: z.literal("remove"), name: vmName }),
  ]),
});
```

The API sends `images` when a VM connection is added or removed, and with every reconcile. In the
dev stack and local mode the API calls the same `FleetService` methods directly, as it does for
discovery, in its own process, which is why the VM locks and last-use stamps work across
processes (see [Provider](#provider)).

### Contracts

`ComputerConnectionSettingsSchema` (`packages/contracts/src/computer-connections.ts`) gains
`engine: "vm"` and one field that only VMs use:

```ts
/** The image the owner agreed to download; an id from packages/contracts/src/vm-images.ts. */
vmImage: z.string().regex(/^[a-z0-9.-]{1,64}$/).optional(),
```

`vmImage` is required exactly when the engine is `vm`. A VM's size uses the resource fields every
connection already has, so there is one source of truth and no new form copy: `cpuLimit` is the
number of virtual CPUs, `memoryLimit` the memory and `storageSize` the disk. For `vm` they must be
whole numbers: 1 to 64 CPUs, 2 to 512 GiB of memory and 20 to 2048 GiB of disk.

When a VM connection leaves them out, they default to `2`, `4Gi` and `40Gi` instead of the container
defaults, and the defaults have to be engine-aware at parse time: today's schema fills `storageSize`
with `.default("10Gi")` and `memoryLimit` with `.default("2Gi")` while it parses, so a VM connection
without a disk size would arrive as `10Gi` and fail the 20 GiB floor. One exported constant,
`VM_RESOURCE_DEFAULTS = { cpuLimit: "2", memoryLimit: "4Gi", storageSize: "40Gi" }`, is the single
source: the schema becomes a `z.preprocess` that, when the input's `engine` is `vm`, fills any of
those three fields the input leaves out from the constant before the field defaults run, and leaves
every other engine as it is. The stored metadata then holds the concrete values, so later parses
never change them. The web form's initial resources (`FleetSettings.tsx`, which starts from the
container defaults today) switch to the same constant when the connection type is **Virtual
machine**. `vmLimits(settings)` in `lima-template.ts` converts them to Lima's `cpus`,
`memory: "4GiB"` and `disk: "40GiB"`, as `engineLimits` does for Docker, and refuses anything else
before a process starts. The request, storage class and namespace fields do not apply to VMs. The
upper bounds are schema limits; the host also checks the request against its own CPUs, memory and
free disk (see [Resource ceilings](#resource-ceilings-and-delete)).

`SandboxKind`, `FLEET_KINDS` and `ENGINE_LABELS` (`vm: "Virtual machine"`) gain `vm`.
`computerCapabilities("vm")` is not graphical and has an interactive terminal. Connections stay in
the existing `connections` table as JSON metadata, so no migration is needed.

`FleetReachabilityReasonSchema` (`packages/contracts/src/fleet.ts`) gains the reasons that Test and
discovery report for VM connections, so the web app translates them like today's engine
diagnostics: `lima-missing` (not installed, or older than 2.2), `macos-too-old`,
`kvm-unavailable` and `vm-path-too-long` (see [Translations](#translations)).

`packages/contracts/src/vm-images.ts` (new) is the image registry: an id such as
`ubuntu-24.04-20260705`, and per architecture the URL, SHA-256 and byte size. A test keeps its
current entry equal to the `images` in the template.

### Files and interfaces

| File | Change |
| --- | --- |
| `infra/sandboxes/vm/lima-computer.yaml` | The template (this change). |
| `packages/host-runtime/src/fleet/lima-template.ts` (new) | Embeds the template text, as `linux-scripts.ts` embeds Python, so every bundle ships it; `vmLimits`; builds the `create` argv. |
| `packages/host-runtime/src/fleet/lima.ts` (new) | `LimaSandboxProvider`, the `limactl` argv builders, the `list --json` parser, the last-use stamps and the first-boot record. |
| `packages/host-runtime/src/fleet/vm-locks.ts` (new) | The `VmLocks` interface and its in-process implementation, used alone by the host service and as the per-key queue in front of the Postgres locks. |
| `packages/host-runtime/src/fleet/vm-image.ts` (new) | The verified image download job and the per-deployment image references. |
| `packages/host-runtime/src/fleet/ssh-sandbox.ts` | `SshTransportOptions` for a key file path, a per-VM known-hosts file, `HostKeyAlias` and `accept-new` while no pin exists. Existing SSH machines keep today's options. |
| `packages/host-runtime/src/fleet/process.ts` | A `FleetProcess` factory that takes its `PATH`, so tests can put a fake `limactl` first. |
| `packages/host-runtime/src/fleet/service.ts` | Route `engine: "vm"` to `LimaSandboxProvider`; `vm:<name>` references; the `computer.remote.vm` operation; stop VMs in `close()` when the host service quits. |
| `packages/host-runtime/src/fleet/discovery.ts` | Report Lima's presence and version so Computers can offer the option. |
| `packages/contracts/src/{fleet,computer-connections,ids,fleet-bridge,vm-images}.ts` | The contracts above, including `VM_RESOURCE_DEFAULTS`, the engine-aware defaults and the new reachability reasons. |
| `packages/adapters/src/computer-connections.ts`, `fleet/service.ts` | Resolve `vm` connections like SSH ones: bridge or local `FleetService`; `localFleetService(locks)` takes the process's VM locks. |
| `packages/adapters/src/fleet/vm-locks.ts` (new) | The Postgres VM locks: `pg_try_advisory_lock` on one dedicated lock-pool connection per process, id 5 for VMs and id 6 for images in namespace 1380019075. |
| `packages/adapters/src/fleet/remote-sandbox.ts`, `catalog.ts` | Kind `vm`; VM connections are their own engine family. |
| `packages/adapters/src/computer-lifecycle.ts` | `provisionComputer` renews its booting claim every minute (see [The boot claim](#the-boot-claim)); `replaceComputer` skips the checkpoint for a stopped or suspended `vm` computer, as it does for Kubernetes, because sleep already recorded one; the existing "Preparing the bot computer…" progress shows for `vm` as it does for Docker. |
| `apps/api/src/computer-settings.ts` | `validateComputerConfiguration` refuses to move a computer whose network access is off to a `vm` connection, before anything is saved or destroyed. |
| `apps/api/src/fleet.ts`, `apps/api/src/host-bridge.ts` | Test and details for VM connections; authorization for `computer.remote.vm`; a VM reconciler next to `reconcileFleetSecretCleanup` that also sends `images`. |
| `apps/api/src/app.ts`, `apps/worker/src/index.ts` | Create the Postgres VM locks from the process's lock pool and pass them to `localFleetService`. |
| `apps/host-service/src/index.ts`, `apps/desktop/src/local-mode.ts` | Stop running VMs on Quit. |
| `apps/web/src/pages/fleet/FleetSettings.tsx`, `apps/mobile/components/fleet-status.tsx` | Phase 2 UI, with the translations in [Translations](#translations). |

## The VM definition

The template is used unchanged; per-computer values are set with `limactl create --set`, a
documented flag that edits the template with yq expressions
([`limactl create`](https://lima-vm.io/docs/reference/limactl_create/)). Every field below is
documented in Lima's reference template,
[`templates/default.yaml` at v2.2.0](https://github.com/lima-vm/lima/blob/v2.2.0/templates/default.yaml),
unless another source is named.

| Field | Value | Why |
| --- | --- | --- |
| `minimumLimaVersion` | `"2.2.0"` | Lima refuses the template on older versions. Lowering it requires validating with that version. |
| `vmType` | `vz` on macOS, `qemu` on Linux | Lima's default is `vz` on macOS 13.5 or later and `qemu` elsewhere; Ardur sets it explicitly. `vz` needs macOS 13 or later ([vz](https://lima-vm.io/docs/config/vmtype/vz/)). The type cannot change after creation ([VM types](https://lima-vm.io/docs/config/vmtype/)). |
| `images` | Ubuntu 24.04 cloud images, dated `release-20260705`, with `sha256` digests | The same entries Lima 2.2.0 ships in [`_images/ubuntu-24.04.yaml`](https://github.com/lima-vm/lima/blob/v2.2.0/templates/_images/ubuntu-24.04.yaml). Ubuntu 24.04 is on Docker's [supported list](https://docs.docker.com/engine/install/ubuntu/). At create time Ardur replaces the URL with its verified local copy and keeps the digest. |
| `cpus`, `memory`, `disk` | From the connection's `cpuLimit`, `memoryLimit` and `storageSize`; defaults 2, `4GiB`, `40GiB` | Lima's defaults are min(4, host cores), min(4 GiB, half of host memory) and 100 GiB. The disk file is sparse, so 40 GiB is a ceiling, not an allocation. |
| `plain` | `true` | [Plain mode](https://lima-vm.io/docs/config/plain/) disables mounts, dynamic port forwarding, the built-in containerd, the guest agent, Rosetta, SSH agent forwarding and host clock synchronization; provisioning scripts and SSH keys still work. |
| `mounts` | `[]` | No host directory is shared. Lima's own default is also `[]`; the explicit value keeps it that way if plain mode is ever turned off. |
| `portForwards` | One rule: `guestIP: "0.0.0.0"`, `proto: any`, `ignore: true` | Lima forwards guest ports to the host's `127.0.0.1` by default through an internal fallback rule covering every port. The reference template documents `ignore: true` with `guestIP: 0.0.0.0` as "don't forward these ports". With plain mode on, dynamic forwarding is already off; the rule keeps it off if plain mode changes. SSH on `ssh.localPort` is the one forward Lima keeps, and it "cannot be overridden". |
| `networks` | `[]` | No `vzNAT`, `socket_vmnet` or `user-v2` network: nothing lets the host, the LAN or another VM connect to the guest. Only Lima's default [user-mode network](https://lima-vm.io/docs/config/network/user/) remains, which gives the guest outbound internet through the host: QEMU's user network (libslirp) on `qemu`, and an in-process gvisor-tap-vsock network on `vz` ([`vm_darwin.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/vz/vm_darwin.go), `startUsernet`). Both use 192.168.5.0/24, with the gateway at 192.168.5.2 standing for the host's loopback. |
| `hostResolver.enabled` | `true` | Matters on `qemu` only. Lima gives the guest one nameserver ([`cidata.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.go), `templateArgs`; the `nameservers` of [`network-config`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.TEMPLATE.d/network-config)). On `vz` it is the gateway, 192.168.5.2, whatever this setting says; gvisor-tap-vsock's own DNS server listens there on port 53. On `qemu` this setting makes it 192.168.5.3; without it the guest would get the host's own nameservers, often a LAN or loopback address the firewall blocks. The guest firewall allows DNS only to that one address (see [Guest firewall](#provisioning)). |
| `ssh.localPort` | `0` | Lima picks a free port on the host's loopback, forwarded to the guest's port 22. Ardur reads it from `limactl list --json` after every start. |
| `ssh.loadDotSSHPubKeys`, `ssh.forwardAgent`, `ssh.forwardX11`, `ssh.forwardX11Trusted` | `false` | Only Lima's own generated key is authorized; the owner's `~/.ssh/*.pub` keys, SSH agent and X11 display never reach the guest. |
| `ssh.overVsock` | `false` | Keeps SSH on the loopback TCP forward that Ardur connects to. Lima uses vsock only with systemd 256 or later, which Ubuntu 24.04 does not have ([port forwarding](https://lima-vm.io/docs/config/port/)), so this changes nothing today but keeps the transport fixed. |
| `containerd.system`, `containerd.user` | `false` | Lima installs nerdctl and containerd by default; Docker's packages are used instead, as in Lima's own [`docker.yaml`](https://github.com/lima-vm/lima/blob/v2.2.0/templates/docker.yaml). |
| `propagateProxyEnv` | `false` | Otherwise Lima copies the host's proxy variables, and any credentials in them, into the guest. |
| `upgradePackages` | `false` | No upgrade at every boot. The Docker packages are held; Ubuntu's own update settings in the image are left as they are. |
| `timezone` | `""` | Keeps the image's UTC instead of copying the host's time zone. |
| `user.name`, `user.comment` | `lima`, `Lima` | Lima's admin user. Without `comment`, Lima copies the host account's full name into the guest (checked with `limactl validate --fill`). |
| `param.ArdurComputer`, `param.ArdurDeployment` | Set per VM | Labels for crash recovery and orphan cleanup; Lima reports them as `param` in `limactl list --json` ([instance fields](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/lima_instance.go)). Lima rejects a param that no script uses, so provisioning writes both to `/etc/ardur-labels`. |
| `param.ArdurVmType` | Set per VM, equal to `vmType` | Tells provisioning where the guest's nameserver is. Lima exports its own `LIMA_CIDATA_*` values to provisioning scripts too, but `limactl validate` warns that scripts should not read them ([`validate.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limayaml/validate.go)), so Ardur passes the one value it needs as a param. |
| `provision` | One `system` script | Runs as root at every boot, from Lima's boot script, which cloud-init runs as a per-boot script ([`user-data`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.TEMPLATE.d/user-data)). It is idempotent and does the slow part once. |
| `probes` | None | Lima's final requirement already waits for provisioning to finish, and a probe would only add retries before it (see [Readiness and time limits](#readiness-and-time-limits)). |

### Provisioning

The `system` script runs with `set -euo pipefail`, resolves commands only from system directories,
and follows one rule: root never writes to, changes or follows a path the bot can write, such as its
home or `/tmp` (see [Root and the bot's files](#root-and-the-bots-files)). Every file it writes goes
through one helper, `write_file`: the content goes to a temporary file in the target's own
root-owned directory, is flushed to disk, is checked when a check applies, and is renamed over the
target only when it differs (an unchanged target only gets its mode set). A rename within one file
system replaces the file in one step
([rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html)), so a full disk or a crash leaves
either the old file or the new one, never a truncated one. Apart from the helpers, it does five
things.

- **apt helpers**, used only on boots that install packages. Quit stops VMs within 60 seconds and
  can cut an install short; apt then refuses to run until `dpkg --configure -a` has finished it
  (`debSystem::Lock` in apt's
  [`debsystem.cc`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/apt-pkg/deb/debsystem.cc)),
  so the install helper runs that first whenever dpkg's journal directory, `/var/lib/dpkg/updates`,
  is not empty, which is the condition apt checks (`debSystem::CheckUpdates`, same file);
  `--configure -a` configures every package that is unpacked but not yet configured
  ([dpkg(1)](https://man7.org/linux/man-pages/man1/dpkg.1.html)).
  Installs pass `-o DPkg::Lock::Timeout=300`, so they wait up to five minutes for the dpkg lock that
  Ubuntu's own daily apt jobs may hold. `apt-get update` takes the package lists' lock without any
  wait (`pkgAcquire::GetLock` in
  [`acquire.cc`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/apt-pkg/acquire.cc)), so it is
  retried up to six times, ten seconds apart.

0. **Labels and a stable host key.** It writes the two labels to `/etc/ardur-labels`, and
   `ssh_deletekeys: false` to `/etc/cloud/cloud.cfg.d/90-ardur-keep-host-keys.cfg`. Lima gives
   cloud-init a new instance id at every boot
   ([`cidata.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.go)), and
   cloud-init's SSH module runs once per instance and deletes and regenerates the host keys unless
   that setting is false
   ([`cc_ssh.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/config/cc_ssh.py)).
   Lima's issue [#678](https://github.com/lima-vm/lima/issues/678), "SSH host keys are regenerated
   each time a VM does a stop/start", is still open. Without this step, Ardur's pinned host key
   would stop matching at the first wake.
1. **Guest firewall.** From `ArdurVmType` it takes the guest's nameserver: 192.168.5.2 on `vz`,
   192.168.5.3 on `qemu` (see the `hostResolver` row above), and it stops unless the nameservers
   the guest actually received, as systemd-resolved lists them in
   `/run/systemd/resolve/resolv.conf`
   ([systemd-resolved.service(8)](https://www.freedesktop.org/software/systemd/man/latest/systemd-resolved.service.html)),
   are exactly that one address. So a param that disagrees with the real VM type cannot open the
   host's port 53. It installs `nftables` if needed and writes `/etc/ardur/firewall.nft`, checked
   with `nft -c -f` before it replaces the old file. The file starts with `flush ruleset` and then
   defines one table, and `nft -f` applies a whole file as one transaction, so a load never leaves
   the guest partly configured ([atomic rule replacement](https://wiki.nftables.org/wiki-nftables/index.php/Atomic_rule_replacement)).
   The table has one `output` chain, in this order:
   1. accept everything on the loopback interface;
   2. reject every IPv6 packet, so IPv6 works only on the guest's own loopback;
   3. accept `ct state established,related ct direction reply`: packets of connections the host
      opened, such as Ardur's SSH, which arrives from 192.168.5.2
      ([ct direction](https://wiki.nftables.org/wiki-nftables/index.php/Matching_connection_tracking_stateful_metainformation));
   4. accept TCP and UDP port 53 to the nameserver above, and UDP port 67 to the gateway;
   5. reject 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (carrier-grade NAT, which covers Tailscale
      addresses), 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16
      (which holds the gateway, 192.168.5.2, the host's loopback), 198.18.0.0/15 and 224.0.0.0/3
      (multicast and reserved, which holds 255.255.255.255).

   Everything else, the public IPv4 internet, is accepted for image pulls. The IPv6 reject comes
   before rule 3, so nothing skips it. Rule 3 has to come before rule 5, because the replies to
   Ardur's SSH go to 192.168.5.2, but it applies only to the reply direction, so a connection the
   guest opens never skips rule 5, even one that got established while no rules were loaded. Rule
   4's DHCP exception exists because systemd-networkd renews its lease with unicast UDP to the
   server, 192.168.5.2, through the normal socket path (`client_send_request` in
   [`sd-dhcp-client.c`](https://github.com/systemd/systemd/blob/v255/src/libsystemd-network/sd-dhcp-client.c)),
   and the vz network's lease lasts one hour
   ([`dhcp.go`](https://github.com/containers/gvisor-tap-vsock/blob/v0.8.9/pkg/services/dhcp/dhcp.go)).
   Neither exception reaches the host: port 53 on the vz gateway and port 67 on either gateway are
   answered by the virtual network itself (see [What it cannot reach](#what-it-cannot-reach)).
   `meta nfproto` selects the address family in an `inet` table
   ([nft](https://www.netfilter.org/projects/nftables/manpage.html)). How the rules load at boot is
   in [The firewall at boot](#the-firewall-at-boot).
2. **The bot's account and login.** It makes the admin home unreadable to other users, copies the
   admin user's `authorized_keys` (only the key Lima generated on the host) to the root-owned
   `/etc/ssh/ardur/bot_authorized_keys`, and writes `/etc/ssh/sshd_config.d/10-ardur-bot.conf`:
   `Match User bot` with `AuthorizedKeysFile` set to that file and
   `SetEnv DOCKER_HOST=unix:///run/user/2000/docker.sock`. `SetEnv` is allowed after `Match` and
   sets the variable in that user's sessions only
   ([sshd_config(5)](https://man.openbsd.org/sshd_config.5); `SSHCFG_ALL` in
   [`servconf.c`](https://github.com/openssh/openssh-portable/blob/V_9_6_P1/servconf.c) at 9.6p1).
   Fleet's command script starts from the session's environment (`LINUX_EXEC_SCRIPT` in
   `linux-scripts.ts`), so the Docker CLI finds the bot's daemon even though Fleet sets `HOME` to
   the computer home. The variable is deliberately not in `/etc/environment`: Ubuntu's sudo reads
   that file through `pam_env.so readenv=1`
   ([`/etc/pam.d/sudo`](https://git.launchpad.net/ubuntu/+source/sudo/tree/debian/etc/pam.d/sudo?h=applied/ubuntu/noble-updates),
   [pam_env(8)](https://man7.org/linux/man-pages/man8/pam_env.8.html)), and sudo merges the PAM
   environment into the command ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/)), so an
   operator's `sudo docker login` in the guest would send credentials to the bot's daemon. It
   creates `bot` (uid 2000) with `useradd --create-home` if it does not exist, and removes it from
   `sudo`, `admin`, `docker` and `lxd`. It then asks sshd which settings a `bot` login gets
   (`sshd -T -C user=bot,host=localhost,addr=127.0.0.1`, which applies matching `Match` blocks;
   [sshd(8)](https://man.openbsd.org/sshd.8)), stops unless both the key file and `DOCKER_HOST` are
   as written, and reloads `ssh.service`. A `Match` block in an included file ends at the end of
   that file ([`servconf.c`](https://github.com/openssh/openssh-portable/blob/V_9_6_P1/servconf.c)
   at OpenSSH 9.6p1, the
   [version in Ubuntu 24.04](https://packages.ubuntu.com/noble/openssh-server)), so the rule changes
   nothing for Lima's admin user.
3. **Pinned software, once.** Downloads and GnuPG use `/var/lib/ardur/work`, which only root can
   write.
   - **Docker, pinned and signed.** Docker's apt repository is added the way Docker documents
     ([Ubuntu install](https://docs.docker.com/engine/install/ubuntu/)), except for the key. apt
     accepts a signature from any key in a `Signed-By` file
     ([sources.list](https://manpages.ubuntu.com/manpages/noble/man5/sources.list.5.html)), and it
     does not read an `.asc` file with GnuPG: apt 2.7 (Ubuntu 24.04) verifies through
     `apt-key --readonly verify` ([`gpgv.cc`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/apt-pkg/contrib/gpgv.cc)),
     which turns an `.asc` file into a keyring with its own small parser that decodes and joins
     every `-----BEGIN` block of any type
     ([`apt-key.in`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/cmdline/apt-key.in),
     `dearmor_keyring`). GnuPG skips blocks it does not recognise, so checking the downloaded file
     with `gpg` and then installing its bytes, as the first revision did, lets a network attacker
     add a key that `gpg` never lists but apt trusts. So the downloaded file is never installed.
     The script imports it into a scratch keyring, exports only the pinned key,
     `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`, as a binary keyring, checks that the
     exported file holds exactly one primary key with that fingerprint (GnuPG's colon listing gives
     each primary key a `pub` record followed by its `fpr` record,
     [`DETAILS`](https://github.com/gpg/gnupg/blob/master/doc/DETAILS)), and installs that file as
     `/etc/apt/keyrings/docker.gpg`, the `Signed-By` of `docker.sources`. apt passes a `.gpg`
     keyring to `gpgv` as it is. It installs `docker-ce`,
     `docker-ce-cli` and `docker-ce-rootless-extras` `5:29.8.1-1~ubuntu.24.04~noble`,
     `containerd.io` `2.3.6-1~ubuntu.24.04~noble`, `docker-buildx-plugin`
     `0.37.1-1~ubuntu.24.04~noble` and `docker-compose-plugin` `5.5.1-1~ubuntu.24.04~noble` (all
     present for arm64 and amd64 in Docker's `noble` pool), then holds them. apt checks every
     package against the repository's signed index
     ([apt-secure](https://manpages.ubuntu.com/manpages/noble/man8/apt-secure.8.html)). The root
     daemon and its sockets are disabled and masked: the guest has no root-owned Docker socket.
   - **kind and kubectl, checksummed.** kind `v0.33.0` comes from its GitHub release and must match
     the SHA-256 GitHub records for the asset. kubectl `v1.37.1` comes from the Kubernetes client
     tarball on `dl.k8s.io`, which must match the SHA-512 published in the
     [1.37 changelog](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.37.md).
     Both checks use `--check --strict` and stop provisioning on a mismatch. kubectl 1.37 is within
     one minor version of kind 0.33's default node, `kindest/node:v1.37.0`
     ([version skew](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)). The script
     also applies kind's documented inotify limits
     ([known issues](https://kind.sigs.k8s.io/docs/user/known-issues/)) and loads the four
     iptables modules rootless kind needs ([rootless kind](https://kind.sigs.k8s.io/docs/user/rootless/)).
   - **The bot's rootless Docker.** `bot` gets subordinate ids, lingering, and its own rootless
     Docker through `dockerd-rootless-setuptool.sh install`, which runs as `bot` through `runuser`
     ([rootless mode](https://docs.docker.com/engine/security/rootless/)). With the rootless extras
     installed from Docker's deb package, the AppArmor profile that lets `rootlesskit` create user
     namespaces under Ubuntu 24.04's restriction already comes with Ubuntu's `apparmor` package
     ([troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/)).
4. **Ready.** At every boot it waits up to 60 seconds, as `bot`, for `docker version` to answer,
   then writes `/run/ardur-ready`.

Nothing in the template or its params is secret: the guest can read both, and the rule is that
neither ever will be.

## Security model

### What the bot can do inside

The bot is the unprivileged user `bot`. It owns its home and the computer workspace inside it,
runs its own rootless Docker daemon, builds and runs containers (root inside them, mapped to its
own subordinate ids), creates kind clusters, and reaches the public internet. It can install
software in containers and in its home; it cannot use `apt` on the VM itself. Team bots on one
VM share this user, as they share one OS user on every computer today.

### What it cannot reach

| Target | Why not |
| --- | --- |
| Host files | No mounts: `plain: true` and `mounts: []`. |
| Services on the host's localhost, over IPv4 | The gateway, 192.168.5.2 (`host.lima.internal`), stands for the host's loopback on both networks: libslirp sends the host alias to `127.0.0.1` (`sotranslate_out4` in [`socket.c`](https://gitlab.freedesktop.org/slirp/libslirp/-/blob/master/src/socket.c)), and Lima gives gvisor-tap-vsock a NAT entry from the gateway to `127.0.0.1` ([`gvproxy.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/networks/usernet/gvproxy.go)). Lima documents no switch to turn that off ([user-mode network](https://lima-vm.io/docs/config/network/user/)). The root-owned guest firewall rejects 192.168.0.0/16. That would otherwise expose, for example, a local model server, a development database or Ardur's own API. |
| Host services through broadcast, on `qemu` | The same libslirp function also sends 255.255.255.255 to the host's `127.0.0.1`, and any process can send a UDP broadcast (`SO_BROADCAST` needs no privilege, [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html)), which would reach UDP services on the host's loopback. The rejected 224.0.0.0/3 holds that address, which is why the template test pins the whole reject set. |
| The two exceptions | Neither reaches a host service on the loopback. DHCP (UDP port 67 on the gateway) is answered by the virtual network: libslirp handles BOOTP to the host alias before it forwards anything (`udp_input` in [`udp.c`](https://gitlab.freedesktop.org/slirp/libslirp/-/blob/master/src/udp.c)), and gvisor-tap-vsock's DHCP server is bound to port 67 inside the network ([`dhcp.go`](https://github.com/containers/gvisor-tap-vsock/blob/v0.8.9/pkg/services/dhcp/dhcp.go)). DNS on `vz` goes to gvisor-tap-vsock's DNS server, bound to the gateway's port 53 inside the network; the NAT to the host's loopback handles only packets no bound endpoint takes ([`services.go`](https://github.com/containers/gvisor-tap-vsock/blob/v0.8.9/pkg/virtualnetwork/services.go); v0.8.9 is the version in Lima's [`go.mod`](https://github.com/lima-vm/lima/blob/v2.2.0/go.mod)). DNS on `qemu` goes to 192.168.5.3, which libslirp forwards to the host's own nameserver, port 53 only (`sotranslate_out4`). That nameserver can itself listen on the host's loopback (for example systemd-resolved at 127.0.0.53), so the one DNS port of the one resolver the host uses is reachable, by design. Allowing both addresses would be wrong: on `qemu`, 192.168.5.2:53 is the host's own `127.0.0.1:53`, and on `vz`, 192.168.5.3 is an ordinary address that the Mac dials on its own network. |
| Services on the host's localhost, over IPv6 | On Linux hosts Lima starts QEMU's user network without `ipv6=off` ([`qemu.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/qemu/qemu.go)). QEMU turns IPv6 on there by default, with the prefix `fec0::/64` ([QEMU](https://www.qemu.org/docs/master/system/invocation.html)), and libslirp sends every address in that prefix except its DNS address to the host's `::1` (`sotranslate_out` in [`socket.c`](https://gitlab.freedesktop.org/slirp/libslirp/-/blob/master/src/socket.c)). The guest firewall allows IPv6 only on the guest's own loopback, so no IPv6 packet leaves the VM, on any host. |
| The owner's LAN and tailnet | The firewall rejects private, link-local and carrier-grade NAT ranges, and all IPv6. |
| Other computers | Each VM has its own user-mode network; no shared network is configured. Other computers' SSH forwards and published ports are on the host's loopback, which is blocked. |
| The host's SSH agent, X11 display, proxy credentials | Forwarding is off, and proxy variables are not copied. |
| Lima's private key | It stays in `~/.ardurbot/vm/lima/_config/user` on the host. Only its public half is in the guest. |

**What stays reachable on the host: its own public addresses.** When the host has a public IPv4
address on one of its interfaces, as a server or a rented VPS usually does, the bot can connect to
that address like any internet address, and the connection is opened by the host's own network
process: libslirp and gvisor-tap-vsock translate only the addresses above and dial everything else
from the host (`sotranslate_out4`; `NAT` in `gvproxy.go`). On Linux a connection to one of the
host's own addresses arrives on the loopback interface, which host firewalls normally accept (ufw's
default rules accept everything on `lo`,
[`before.rules`](https://git.launchpad.net/ufw/tree/conf/before.rules)); on a Mac it likewise comes
from the Mac itself, not from the network. So any host service listening on all interfaces
(`0.0.0.0`), for example a database that the host firewall hides from the internet, is reachable
from the bot on that address. Services listening only on `127.0.0.1` or on a private address stay
unreachable. A Mac behind a home router has only private addresses, which the firewall rejects.
Rejecting the host's public addresses too was considered and left out: they change while a VM runs
(a new network, a new lease), and a list taken at boot would go stale without anyone noticing. The
Linux acceptance list checks this behaviour so that it is known, not assumed.

### The firewall at boot

The rules must be in place before anything the bot controls can use the network, at every boot,
and must never disappear while the VM runs:

- **Loaded before the network.** `/etc/ardur/firewall.nft` is loaded by Ardur's own unit,
  `ardur-firewall.service`, modelled on the nftables package's unit and with its early ordering
  (`DefaultDependencies=no`, `Before=network-pre.target`,
  [`nftables.service`](https://git.launchpad.net/ubuntu/+source/nftables/tree/debian/nftables.service?h=applied/ubuntu/noble-updates))
  plus `Before=systemd-networkd.service`, and `RequiredBy=systemd-networkd.service` in its
  `[Install]` section. Enabling it makes systemd-networkd, which configures the guest's network on
  Ubuntu's cloud image, require it: if the rules fail to load, the network is not started at all
  ([systemd.unit(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html),
  `Requires=`). Its `ExecStartPost` lists the `ardur` table, so the unit fails unless the table is
  actually loaded. The bot's own processes, including its lingering user services and cron jobs, can
  start at boot, but they find no network until the rules are in.
- **Never flushed.** The unit has no `ExecStop`. Stopping or restarting it keeps the rules, and
  `ExecReload` replaces them in one transaction, which is how provisioning applies them on later
  boots (`systemctl reload-or-restart` starts an inactive unit and reloads an active one,
  [systemctl(1)](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)). The
  nftables package's own `nftables.service` is masked. Its `ExecStop` is `nft flush ruleset`, and
  Ubuntu builds the package with `dh_installsystemd --no-enable --no-start --restart-after-upgrade`
  ([`debian/rules`](https://git.launchpad.net/ubuntu/+source/nftables/tree/debian/rules?h=applied/ubuntu/noble-updates)),
  so an upgrade runs `try-restart` on it
  ([`postinst-systemd-restartnostart`](https://salsa.debian.org/debian/debhelper/-/blob/main/autoscripts/postinst-systemd-restartnostart));
  if it were ever running, that restart would leave the guest with no rules between the stop and
  the start. Masked, it never runs, and the upgrade's `try-restart` ignores the error
  (`|| true`). Its `/etc/nftables.conf`, which starts with `flush ruleset`, is never loaded.
- **Never half written.** The rules file is written only through `write_file` (see
  [Provisioning](#provisioning)), checked with `nft -c -f` first, and replaced only when its
  content changes, which after the first boot is never. A full disk or a crash during provisioning
  leaves the previous rules file in place.
- **No lasting hole.** Rule 3 accepts only the reply direction, so a connection that the guest
  opened is checked against the rejects on every packet. Even a moment without rules (which the
  points above rule out) could not leave an established connection to the host open afterwards.

A VM whose rules do not load has no network, so `limactl start` cannot reach it over SSH, `start`
fails, and the owner resets the computer. **To verify:** that the image's network is managed by
systemd-networkd (netplan's default renderer on Ubuntu Server), and the acceptance steps for this
section.

### Who could remove the firewall

The bot has no root: no sudo, no membership in the `docker` group, and its rootless Docker gives
containers network privileges only inside their own network namespace, where the guest's rules do
not live. **Residual risk: a kernel privilege escalation.** Rootless Docker and kind deliberately
give the bot user namespaces in which it holds `CAP_NET_ADMIN` and `CAP_SYS_ADMIN` (Ubuntu 24.04
allows this for `rootlesskit` through the AppArmor profile above). That exposes kernel code that
an unprivileged user cannot otherwise reach, such as nf_tables, which has had local privilege
escalations, for example [CVE-2024-1086](https://nvd.nist.gov/vuln/detail/CVE-2024-1086). A bot
that exploits such a bug becomes root in the VM, can drop the firewall and can then reach the
host's loopback services. The hypervisor still keeps host files and processes out of reach. Kernel
fixes reach the guest only through Ubuntu's unattended security upgrades, which the image runs by
default once a day ([automatic updates](https://documentation.ubuntu.com/server/how-to/software/automatic-updates/)),
not through Lima (`upgradePackages: false`). They need DNS, which the first revision's firewall
broke on `vz` and this one allows. A new kernel takes effect only at the next boot, which for a VM
computer is the next wake, and a new VM starts with the pinned image's kernel until its first
upgrade run. **To verify:** that unattended upgrades are active in the pinned image.

### Root and the bot's files

The provisioning script runs as root at every boot, while the bot owns its home and can replace
anything in it with a symbolic link. A root command that followed such a link would hand the bot
root. For example, copying the SSH key into the bot's `~/.ssh` at every boot with `install -d`
would follow a `~/.ssh` that the bot had pointed at `/etc/systemd/system`, and give the bot that
directory. The design removes that class of problem instead of guarding one path:

- The bot's authorized key lives in a root-owned file that sshd reads through `Match User bot`.
  Root never writes into the bot's home, and the bot cannot change the key or add one.
- The bot's home is created by `useradd` before the bot exists, and root never touches it again.
  The rootless Docker setup and the readiness check run as `bot` through `runuser`.
- Downloads and GnuPG use `/var/lib/ardur/work`, not `/tmp`, and commands resolve only from system
  directories, never from `/usr/local`.
- The outcome markers are files directly in `/run`, which only root can write to (not in
  `/run/lock` or `/run/user/2000`, which the bot can write).

`lima-template.test.ts` keeps it that way (see [Offline tests](#offline-tests)).

### Network access

A VM always reaches the public internet: builders need it to pull images, and the firewall above
is the only filter. A computer whose network access is turned off cannot use one, as on SSH
machines:

- `LimaSandboxProvider.provision` refuses `networkEgress: false` with "Network isolation is not
  available on virtual machine computers.", as `SshSandboxProvider` does for SSH computers
  (`ssh-sandbox.ts`).
- Today only automatic placement checks network support (`packages/adapters/src/fleet/placement.ts`),
  so `validateComputerConfiguration` refuses a manual move of such a computer to a `vm` connection
  with the same sentence, before anything is saved or destroyed.
- `supportsNetworkEgress` is false for `vm`, so automatic placement never picks a VM for it, and
  Capabilities reports network control as unsupported for VM computers
  (`apps/api/src/capability-settings.ts`).

A network-off VM (a firewall that also rejects the public internet) is possible later, but it is
not designed here.

### Why the bot is not root in the VM

Root in the VM would let the bot use `apt` freely, but root can flush any firewall inside the VM,
and Lima offers no host-side switch to hide the host's loopback. Docker and kind both support
rootless operation officially, which delivers what builders asked for: containers and clusters.
If Lima gains a documented way to hide the host's loopback, over IPv4 and IPv6, root inside the VM
becomes safe to offer; that is an [open question](#open-questions-for-the-owner).

### SSH keys and host keys

Ardur connects as `bot` to `127.0.0.1:<sshLocalPort>` with
`-i <LIMA_HOME>/_config/user -o IdentitiesOnly=yes -o IdentityAgent=none`, plus Fleet's existing
options (BatchMode, no agent forwarding, `ClearAllForwardings`). The key file is used in place; it
is never copied into the guest, a template, a param, a command argument sent to the guest, a log,
or the bot's environment.

Lima's own SSH options turn host-key checks off (`StrictHostKeyChecking=no`,
`UserKnownHostsFile=/dev/null` and `NoHostAuthenticationForLocalhost=yes` in
[`sshutil.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/sshutil/sshutil.go)), and a guest's
host keys would change at every boot without provisioning step 0. Ardur checks them. It uses a
per-VM known-hosts file, `UserKnownHostsFile=~/.ardurbot/vm/known_hosts/<name>` with
`GlobalKnownHostsFile=/dev/null` and `HostKeyAlias=<name>`, so a port reused by another VM can
never match. While no pin exists for an instance whose `ArdurDeployment` and `ArdurComputer` labels
match, the connection uses `StrictHostKeyChecking=accept-new`; once a pin exists, it uses `yes`
([ssh_config](https://man.openbsd.org/ssh_config.5)). That covers a first boot interrupted by Quit
or a crash before the pin was recorded: the retry is no longer fresh, but it has no pin yet, so it
connects instead of failing until Reset.

The first key is trusted on first use, over a loopback port held by a Lima process that Ardur
started in its own Lima home. Another account cannot take over a port that process holds, and a
process running as the owner could already read Lima's key. A pin is only recorded after `start`
returned, so step 0 has run and the key stays the same from then on. The pin is deleted with the
VM, and a create that finds a stale pin removes it. A key that no longer matches its pin fails
with "This virtual machine is damaged. Reset it in Settings, Computers."

### Resource ceilings and delete

- **Hard limits.** vCPUs, memory and disk size are fixed in the VM's configuration; the guest
  cannot exceed them.
- **Host ceiling.** Before a create or start, the provider adds the memory of Ardur's running VMs
  (from `limactl list --json`) to the requested memory and refuses above the host's total minus
  2 GiB. It refuses a create below 5 GiB of free disk plus the image size. Free memory is not used
  for this check, because macOS reports file cache as used memory.
- **Delete.** `limactl delete --force` removes the instance directory and its disk. Anything not
  in the workspace checkpoint is gone, including Docker images and kind clusters. The checkpoint
  follows the existing computer rules.

### Compared with other sandboxes

| Option | On a macOS host | Boundary | Docker and kind | Fit |
| --- | --- | --- | --- | --- |
| Lima VM (this design) | Yes, through Apple's Virtualization framework; QEMU with KVM on Linux | A separate guest kernel | Yes, rootless | Runs as the owner's own account (only the unused `socket_vmnet` networks need root-installed files, per the reference template), needs no hosted service, and ends up as a Linux machine reached over SSH, which Fleet already speaks. |
| [Sysbox](https://github.com/nestybox/sysbox) | No: Linux hosts only | User namespaces in a container, sharing the host kernel | Yes, without privileged containers | On a Mac it would itself need a Linux VM. Community-maintained on a best-effort basis. |
| [Rootless Podman in a container](https://www.redhat.com/en/blog/podman-inside-container) | Only inside a Linux VM | A container with `/dev/fuse` and SELinux labelling disabled | Podman yes; kind needs extra rootless setup | Weakens container confinement and still shares the kernel. |
| [gVisor](https://gvisor.dev/docs/tutorials/docker-in-gvisor/) | No: Linux only | A user-space kernel | Docker only with raw sockets, packet writes and Docker's iptables off; kind is not documented | Linux servers only, with a narrower Docker. |
| [Kata Containers](https://katacontainers.io/learn/) | No: Linux host and guest | A VM per pod | Through a container runtime | Needs nested virtualization on a Mac. |
| [Firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md) | No: Linux with `/dev/kvm` | A microVM | Build your own guest | A building block for a cloud follow-up, not a local Mac option. |

## Lifecycle

| Ardur | Lima and the provider |
| --- | --- |
| Add a VM connection (owner confirms the download) | Ardur downloads and verifies the image once and records it for this deployment. |
| `provision` | Derive the name, refuse network off, and check whether the instance exists. No VM work. |
| `prepare`, first boot (no `provisioned/<name>` record yet, including a retry after an interrupted first boot) | `create` if the instance is missing, `start` (which waits for provisioning) until the 12-minute mark, one readiness check over SSH; the host key is trusted on first use, and a passing check writes the record. At most 13 minutes, and one more to stop the VM after a failure, with the booting claim renewed every minute. |
| `prepare`, wake (the record exists) | `start` (3 minutes at most), then the same readiness check. |
| Any SSH-backed call on a stopped VM | Start it first: rows can still say running after Quit stopped their VMs. |
| Sleep and idle suspend | Checkpoint (as today), then `stop`: best-effort cleanup of the bot's processes on a running, ready VM, then `limactl stop`, forced after two minutes. `stop` never starts a VM. The disk persists. |
| Wake | The next `prepare` starts the VM. |
| Destroy and reset | Write a tombstone, `delete --force`, remove the pin, the `provisioned` record, the `used` stamp and the tombstone. |
| Update (rebuild), move and resize | The existing flow: checkpoint, destroy, create with the current template, restore. A stopped or suspended VM is not woken for the checkpoint: `replaceComputer` uses the one idle sleep recorded before `stop` (`computer-idle.ts`), as it does for Kubernetes. |

### Image download

The first VM connection needs Ubuntu 24.04's cloud image: about 600 MB (Ubuntu's listing for the
September 2026 release shows 591 MB for arm64 and 596 MB for amd64). The registry records exact
sizes. Ardur downloads it when the owner adds the connection, not when a bot first needs a VM, for
three reasons:

- the owner confirms the download explicitly, with its size, before it starts;
- Ardur knows the byte count, so Computers shows real progress and time left;
- a failed first `prepare` rolls the new computer back by destroying it, and the host bridge
  limits one operation to 15 minutes. A large download inside `prepare` would risk both.

`vm-image.ts` streams the file with Node's built-in `fetch`, hashes it while writing a private
`.part` file, compares the SHA-256 with the registry, and renames it into
`~/.ardurbot/vm/images/`. A mismatch deletes the partial file. Redirects are followed only to
Ubuntu's `cloud-images.ubuntu.com` and `cloud-images-archive.ubuntu.com`; the pinned digest, not
the transport, is what makes the file trusted. Within one process, one job runs per image id and
callers join it. Two processes (the API and the worker, or two deployments) can still download
the same image at once, so every writer uses its own `.part` name,
`<image id>-<arch>.img.<random>.part`, and the final rename replaces the file in one step
([rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html)): whichever finishes second
replaces verified bytes with the same verified bytes, and a reader that already opened the file
keeps reading the one it opened.
At create time the template's `images` entry points at that file with the same digest, so Lima
checks it again. **To verify:** that `limactl create` and `start` accept a local image path at
runtime (`limactl validate` accepts it), and how the download should honour proxy settings.

Each VM keeps its own disk copy, so the shared image is only needed to create VMs. Every deployment
on the account shares `~/.ardurbot/vm/` (for example a dev stack beside the installed app), but only
a deployment's own database knows which image ids its connections use. So each deployment records
its ids in `images/refs/<deployment>` through the `images` operation, and an image file is deleted
only when no deployment's list names it and no create in the same deployment is using it. That
second condition is enforced by the image's lock, the same kind of lock as the VM locks (id 6, key
`vm-image:<id>`): every `create` holds it shared, with `pg_try_advisory_lock_shared` or the
in-process equivalent, until `create` returns, and deletion takes it exclusively without waiting and
skips the image if that fails. `create` is the only step that reads the image: it copies the image
into the instance (see [Lima commands](#lima-commands)). Across deployments nothing is shared but
the file system, so a create in one deployment can still find its image deleted by another
deployment's `images` call. When a create finds its image missing, the provider starts the verified
download again (the owner agreed to it when adding the connection), and the run fails with "The
Ubuntu download is not finished. Try again when Computers shows it is ready."; the reconciler's next
`images` call restarts it too. A deletion that races with another deployment's new reference
therefore costs that deployment one verified download, never a broken VM. An image referenced only
by a deployment that never runs again stays on disk.

Dated Ubuntu releases move to the archive host after a few months: the `release-20260705`
directory in the template already redirects there, and Lima's own entry is the same one. Each
Ardur release that ships VM support must therefore pin a current dated release, with digests taken
from Ubuntu's signed `SHA256SUMS`, in `vm-images.ts` and the template together; the drift test
keeps them equal. An image already downloaded keeps working after the pin moves on.

The first boot of each VM then installs Docker, kind and kubectl from the internet. That time is
not measured yet; the manual acceptance run records it.

### Capacity

A VM connection's Fleet row reports the host's capacity (`hostCapacity`, source `host`, cached for
30 seconds), because its VMs draw on the host. Free memory is shown as usual. VM connections are
their own engine family, so automatic placement never moves a computer into or out of a VM.

### Checkpoints and profile changes

Checkpoints use `LinuxFleetSandbox`'s bounded tar over SSH, with Fleet's existing limits: 64 MiB
directly, 8 MiB through the host bridge. They contain the computer workspace only. Docker images,
kind clusters and anything outside the workspace survive sleep and wake on the VM's disk, but not
a move, reset or rebuild.

Image profiles (Standard, Developer) do not apply to VMs, so Settings hides that control, as it
does for host computers. A VM's CPUs, memory and disk are its connection's CPU limit, memory limit
and storage size, and connections are immutable. To resize, the owner adds a VM connection with
the new sizes and moves the computer to it, which uses the existing checkpoint, destroy, create
and restore flow; a sleeping VM is not woken for it. Resizing in place with `limactl edit` is a
possible later improvement and is not designed here.

### Crash recovery and orphans

- **Quit.** The host service and the installed app's local mode stop their running VMs when the
  app quits (graceful stop in parallel, forced after 60 seconds). A dev worker restart does not,
  so hot reload does not stop VMs. Rows keep their state; the next SSH-backed call or `prepare`
  starts the VM again.
- **A VM left running.** After a crash, the API reconciler (on host connect and every 10 minutes)
  sends every VM name it can derive from its computer rows, each marked active or not. That list
  is a snapshot: by the time it arrives, a queued run may already be waking one of those
  computers, or a new computer may have created its VM. So the host decides each VM under that
  VM's lock, taken without waiting: a VM whose lock another process holds (a `prepare` in the
  worker, for example) is skipped. Holding the lock, it reads the status again and stops the VM
  only if it is still running, is marked inactive, and its `used/<name>` stamp is more than 10
  minutes old. The lock and the stamp are shared by every process on the machine (see
  [Provider](#provider)), so in the dev stack and local mode the API's reconciler sees the
  worker's boots and calls, not only its own. After a crash nothing refreshes the stamps, so the
  reconciler stops a leftover VM at most 10 minutes after its last call; a VM skipped because it
  was just used is stopped by a later pass if it stays inactive.
- **Orphans.** An instance in Ardur's Lima home whose name starts with `ardur-` and whose
  `ArdurDeployment` label matches, but which no computer row names, is stopped and reported as
  unused, under the same lock and recent-use rule, so a VM created after the snapshot is never
  reported. Computers shows it, and the owner removes it with one confirmation. Automatic deletion
  of disks the API does not know about is deliberately not done; see the
  [open questions](#open-questions-for-the-owner). Instances without the prefix, or with another
  deployment's label (for example a dev stack beside the installed app), are never touched.
- **Interrupted destroy.** A tombstone written before `limactl delete` is retried on the next
  reconcile, so a crash mid-destroy does not leave an orphan.
- **Interrupted first boot.** The retry is still a first boot, because the `provisioned` record
  is written only after a readiness check passes, so it gets the first-boot budget (see
  [First boot and wake](#first-boot-and-wake)). Provisioning finishes any install that the
  interruption cut short before it uses apt again, and the retry connects with `accept-new`,
  because no pin exists yet (see [SSH keys and host keys](#ssh-keys-and-host-keys)).
- **Broken VMs.** `Broken` status fails the run with a sentence and a **Reset** action.

## UX

- **Where.** Settings → Computers → **Add computer** → connection type **Virtual machine**. The
  option is shown on macOS and Linux hosts and omitted on Windows. When Lima is installed,
  Computers also shows a discovered **Virtual machine** row with **Add**, like other discovered
  engines.
- **Fields.** Name, and the existing **Resources** section, collapsed as it is for Kubernetes, with
  only **CPU limit**, **Memory limit** and **Storage size**, filled in from `VM_RESOURCE_DEFAULTS`
  (2, 4Gi and 40Gi) and bounded by the host.
- **First connection.** While the image is not downloaded, one line under the fields gives its
  size. Pressing **Add** is the consent and starts the download. The new row shows progress and
  time left until the image is verified; the computer can be assigned meanwhile, and a run that
  needs it first says the download is not finished.
- **First use by a bot.** The conversation shows the existing "Preparing the bot computer…" while
  the VM is created and provisioned.
- **Unused VMs.** When the reconciler reports some, Computers shows one row with their count and
  **Remove**. Pressing it opens a confirmation whose title is the same count and whose one sentence
  says the disks will be deleted; confirming sends `remove` for each of them. The existing
  "Remove computer" dialog is not reused: its sentence is about a saved connection and its
  credentials, not a disk.
- **Test and discovery.** A VM connection that cannot work on this computer shows a translated
  reason under its row, as engines do today ("Start the engine and press Test.").
- **Mobile** shows VM rows and their capacity, without Add, download progress, reasons or removal,
  like other computers.

### Copy

| Where | Copy | Why it is needed | Why not remove it or reveal it later |
| --- | --- | --- | --- |
| Connection type | **Virtual machine** | Names the new kind. | The list is the only place to choose it. |
| Form fields | Existing: **Resources**, **CPU limit**, **Memory limit**, **Storage size** | The only decisions a VM needs, fixed at creation. | No new copy: the connection's existing resource fields, collapsed and filled in. |
| Under the fields, only before the first download | **Downloads Ubuntu once (about 600 MB).** | The owner agrees to a large download before it starts. | It appears only when a download will happen, and it is the consent itself. |
| Row, during the download | **Downloading {percent}% · {minutes, plural, one {about # minute left} other {about # minutes left}}** | The download can take minutes, and the computer is not usable until it ends. | Shown only while downloading. |
| Row, only when some exist | **{count, plural, one {# unused virtual machine} other {# unused virtual machines}}** with the existing **Remove** | Their disks take space and belong to no computer. | Shown only when there are some. |
| Confirmation after **Remove** on that row | Title: the row's count message. Sentence: **{count, plural, one {Its disk and everything on it will be deleted.} other {Their disks and everything on them will be deleted.}}** Buttons: the existing **Remove** and **Cancel**. | Deleting a disk cannot be undone, so the owner confirms it. | Shown only after pressing **Remove**; one sentence, because the title already names what goes. |
| Test and discovery reasons, only when they apply | "Install Lima 2.2 or later on this computer, then press Test." (`lima-missing`) · "Virtual machines need macOS 13 or later." (`macos-too-old`) · "Virtual machines need access to /dev/kvm on this computer." (`kvm-unavailable`) · "This computer's home folder path is too long for virtual machines." (`vm-path-too-long`) | The owner can fix each before adding or using the connection. | Shown only for a connection that fails that check. |
| Run and move failures only | "Network isolation is not available on virtual machine computers." · "Not enough memory for another virtual machine. Put another computer to sleep, or choose less memory." · "Not enough free disk space for this virtual machine. Free up space and try again." · "The Ubuntu download is not finished. Try again when Computers shows it is ready." · "The virtual machine could not finish setting up. Check the internet connection and try again." · "This virtual machine is damaged. Reset it in Settings, Computers." (and the four reasons above, when a run meets them) | Each says what happened and what to do. | Shown only after the failure. |

### Translations

- **Web.** The new strings (the connection type, the download line, the progress row, the unused
  row, its confirmation sentence and the four Test and discovery reasons) go through Lingui (`t`,
  `Trans` and `plural`) and are translated in all nine catalogs,
  `apps/web/src/locales/{en,de,es,hi,ko,pt-BR,ru,tr,zh-CN}/messages.po`, with
  `pnpm --filter @ardurbot/web intl:extract` and `intl:compile`. The unused count, its
  confirmation and the minutes left are plural messages, so they read "1 unused virtual machine"
  and "2 unused virtual machines", and each locale supplies its own plural forms.
  `apps/web/src/lib/i18n-catalog.test.ts` gains a case that requires every new message in every
  locale, next to the existing case for engine diagnostics.
- **Test and discovery reasons** are reason codes, not server text: the four VM reasons join
  `FleetReachabilityReasonSchema`, and the web app renders each through its catalog in
  `FleetSettings.tsx`, as it renders `engine-not-running` and "Start the engine and press Test."
  today. So they never appear in English beside translated Docker diagnostics.
- **The kind's name.** "Virtual machine" is a common noun, unlike the product names in
  `ENGINE_LABELS` (Docker, SSH, Kubernetes), so web and mobile render kind `vm` through their
  catalogs; the English contract label stays the fallback for names the API builds.
- **Mobile.** "Virtual machine" is added to `apps/mobile/lib/locales/{ru,zh}.ts` and to the key
  list in `apps/mobile/lib/i18n.test.ts`. Mobile shows no other new copy.
- **Run and move failures** come from the host and the API in English, like today's Fleet run
  failures (for example "Network isolation is not available on SSH computers."), which are not in
  the catalogs. Translating server sentences is a separate change across all of Fleet.

## Verification plan

### Offline tests

All tests are deterministic and offline. They never start a VM, a container or a network download.

A fake `limactl` lives at `packages/host-runtime/src/fleet/testdata/limactl`: a Node script that
keeps instance state in `$LIMA_HOME/.fake-state.json`, appends each argv to
`$LIMA_HOME/.fake-calls.jsonl`, supports `--version`, `create`, `start` (including `--timeout`),
`stop`, `delete` and `list --json`, can be told to fail, time out or report "degraded" for a
subcommand, and exits with an error for anything else. Tests put its directory first on `PATH`
through the `FleetProcess` factory, so the real `resolveHostBinary` and spawn path runs. SSH uses
the existing `fakeSshTransport`.

`lima-template.test.ts`

- The embedded template equals `infra/sandboxes/vm/lima-computer.yaml` byte for byte.
- The template keeps `plain: true`, `mounts: []`, the ignore rule, `networks: []`, containerd off,
  `propagateProxyEnv: false`, SSH forwarding off and `user.comment`, and has no `probes` and no
  `base:`. It declares the three params, and the script never mentions `LIMA_CIDATA`.
- Every image entry has a `sha256:` digest, both architectures are present, and they equal the
  registry's current entry.
- Provisioning pins every version, has no `curl … | sh`, uses `sha256sum --check --strict` and
  `sha512sum --check --strict`, holds the Docker packages and masks the root daemon.
- **Firewall.** For each VM type, the rules file the script would write (with the nameserver and
  gateway filled in) equals a golden ruleset exactly: loopback accept, IPv6 reject,
  `ct state established,related ct direction reply accept`, TCP and UDP 53 to 192.168.5.2 on `vz`
  or 192.168.5.3 on `qemu` and never both, UDP 67 to 192.168.5.2, then the full reject set,
  including 192.168.0.0/16 and 224.0.0.0/3, in that order. The nameserver `case` fails on any
  other `ArdurVmType`, and the script compares it with `/run/systemd/resolve/resolv.conf`. The
  rules are written through `write_file` with `nft -c -f`. The unit file has
  `DefaultDependencies=no`, `Before=` both `network-pre.target` and `systemd-networkd.service`,
  `RequiredBy=systemd-networkd.service`, an `ExecStartPost` that lists the table, an
  `ExecReload`, and no `ExecStop`. The script masks `nftables.service`, never enables it, never
  restarts `ardur-firewall.service` (only `reload-or-restart`), and never writes
  `/etc/nftables.conf`.
- **Root's writes.** Comments aside, the only output redirections into files (other than
  `/dev/null`) are `write_file`'s own temporary file, the outcome marker and files in the scratch
  directory `/var/lib/ardur/work`; every other file goes through `write_file`. No command line
  names `/home`, `/tmp` or `~/`, apart from `useradd` and the `HOME` given to commands that run as
  `bot`, and none names
  `/etc/environment`. `PATH` is set to system directories. The outcome is recorded by an `EXIT`
  trap, and there is no `ERR` trap.
- **Login.** `ssh_deletekeys: false` is written before the firewall; the bot's key file is under
  `/etc/ssh/ardur`; the drop-in has `Match User bot`, `AuthorizedKeysFile` and
  `SetEnv DOCKER_HOST=…`; the `sshd -T` check greps both.
- **Docker key.** The downloaded `.asc` file is never installed: the script imports it into the
  scratch keyring, exports `$DOCKER_KEY_FINGERPRINT` alone, checks the export and installs only
  `/etc/apt/keyrings/docker.gpg`, which is the `Signed-By` of `docker.sources`.
- **Behaviour, run with bash.** The test extracts the script's helpers and runs them in a
  temporary directory:
  - `fail` and the `EXIT` trap: a failing command, a failing pipeline, an explicit `fail` and
    success each leave the right marker.
  - `write_file`: a new file is created with its mode; the same content keeps the file and its
    inode and only sets the mode; new content replaces it; a failing check leaves the old file and records the
    reason; no temporary file is left in any case.
  - `apt_install`, with fake `ls`, `dpkg` and `apt-get` first on `PATH`: `dpkg --configure -a`
    runs first exactly when the journal is not empty, and `apt-get` always gets
    `DPkg::Lock::Timeout=300`. `apt_update` retries a failing `apt-get update` six times and then
    records the reason.
  - The Docker key steps, with fixture public keys and signatures in
    `testdata/docker-key/` (made once with throwaway keys; no private key is committed) and a
    scratch GnuPG home: from the pinned key alone, and from the pinned key plus a second key hidden
    in an armor block of another type, before or after it, the exported keyring holds exactly the
    pinned key, `gpgv` with it accepts the fixture signature by the pinned key and rejects the one
    by the other key; a file without the pinned key is refused. The same fixtures show that the
    first revision's check listed only the pinned key for the hidden-key files, the gap this
    closes. This part needs `gpg` and `gpgv` (on CI's Linux runners) and is skipped, with that
    reason, where they are missing.
- The `create` argv is exact: `vz` on macOS, `qemu` on Linux, refused on Windows; values are
  JSON-encoded; `ArdurVmType` always equals `vmType`. `vmLimits` converts `2`, `4Gi` and `40Gi`,
  and refuses millicores, sizes that are not whole GiB and out-of-range values before any process
  starts.

`lima.test.ts`

- Every call has `LIMA_HOME` set to Ardur's directory and `--tty=false`, and never a shell.
- `provision` derives `ardur-` and 16 hex characters from the computer and the connection, changes
  nothing, and refuses `networkEgress: false` with the network sentence. The same computer on two
  VM connections gets two names; the same computer and connection always gets the same name.
- `prepare`: missing → `create` then `start`; `Stopped` → `start`; `Running` → only the readiness
  check; `Broken` → the reset sentence; labels that do not match → refused; `cpus`, `memory`,
  `disk` or `vmType` that differ from the connection → the damaged sentence, with no `start`;
  image not downloaded → the download restarts and a typed error comes back before `create`.
- Time limits (fake timers): `create` is bounded at 3 minutes; `start --timeout` is the time left
  to the 12-minute mark when there is no `provisioned` record, including for an instance that
  already exists after an interrupted first boot, and 3 minutes when there is one; the record is
  written only after a passing readiness check and removed by destroy. A `create` or `start`
  error, a "degraded" start, a `start` that never returns, a refused login, a missing ready marker
  and a failing tool each end with the setup sentence; the steps stay within 13 minutes and the
  whole of `prepare`, cleanup included, within 14 minutes and a forced stop.
- Cleanup and rollback: when a `start` that `prepare` began fails or times out and leaves the fake
  VM running, `prepare` runs `limactl stop`, then `stop --force` when the graceful stop takes more
  than 60 seconds, before it throws the setup sentence. A following `stop` from the rollback finds
  the VM stopped and runs no SSH and no `start`. A readiness failure on a VM that was already
  running before `prepare` leaves it running.
- `stop`: on a `Stopped` VM it runs nothing; on a `Running` VM it runs the in-guest cleanup,
  bounded at 30 seconds, and then `limactl stop` even when the cleanup fails or hangs; on a
  `Broken` VM it runs `stop --force`. It never takes the wake path.
- Host keys: `accept-new` whenever no pin exists and the labels match, including on an instance
  that is not fresh after an interrupted first boot; `yes` once pinned; destroy removes the pin; a
  fresh create removes a stale pin; a changed key gives the damaged sentence.
- SSH uses `bot@127.0.0.1`, the port from `list --json`, the key path with `IdentitiesOnly` and
  `IdentityAgent=none`, and never puts the key path in the remote command.
- A command, a file call, an export or a terminal on a `Stopped` VM starts it first, and releases
  the lock before the SSH work.
- Last use: every call sets `used/<name>` when it starts and ends, and a call that runs longer
  than a minute refreshes it every minute.
- Destroy writes a tombstone, runs `delete --force`, clears the pin, the record, the stamp and the
  tombstone, and retries after a failure.
- `list --json` parsing reads one object per line, ignores unknown fields and refuses malformed
  lines.
- The memory ceiling and disk floor refuse with sentences before `create` or `start`. The path
  guard follows Lima's rule on the real path: the longest allowed instance directory passes and
  one more character is refused with the sentence, for 104 characters (macOS) and 108 (Linux),
  and a Lima home reached through a symbolic link is measured at its target.
- Reconcile, with two `FleetService` objects that share one lock implementation and one stamp
  directory, as the API and the worker do: it skips a VM whose lock the other holds (a `prepare`
  in flight) and one whose stamp is less than 10 minutes old, stops an inactive running VM
  otherwise, reports unused ones only when prefix and label match, never reports a VM created
  after the snapshot, and never touches other instances. `remove` refuses names that a computer
  still uses.
- `closeAll` stops running VMs within its bound.
- Files, checkpoints and the terminal round-trip through the fake transport.

`vm-locks.test.ts` (host runtime): the in-process lock serializes one key, lets different keys run
at once, and a try without waiting reports a held key as busy. `vm-locks.postgres.test.ts`
(adapters, run where the other `*.postgres.test.ts` suites run): with two pools standing for two
processes, the second cannot take a key the first holds; closing the holder's connection releases
it; two calls for one key in one process queue in memory instead of sharing Postgres's lock; an
image's shared lock blocks an exclusive try but not another shared one.

`vm-image.test.ts` uses a loopback HTTP server fixture: the digest is verified, a wrong digest
deletes the partial file, progress is reported, concurrent callers in one process join one job,
two writers with separate job maps (two processes) each use their own `.part` file and leave one
verified image, the disk floor refuses, and cancellation cleans up. For references: an image named
in another deployment's list is kept, an image no list names is deleted, an image whose lock a
create holds is not deleted, and a create that finds its image missing restarts the download.

Also: `ssh-sandbox.test.ts` (the new transport options, and unchanged defaults), `service.test.ts`
(routing and `vm:` references), `fleet.test.ts` and `computer-connections` tests in contracts
(`vm` requires `vmImage`; a VM connection that leaves out its resources gets
`VM_RESOURCE_DEFAULTS`, explicit values are kept, and other engines keep the container defaults;
VM bounds; the new reachability reasons; capabilities), `remote-sandbox.test.ts` (kind `vm`),
`sandbox-conformance.test.ts` (the Lima provider with the fake `limactl` and SSH),
`computer-lifecycle.test.ts` (updating or moving a suspended `vm` computer does not export and
restores from the revision recorded at sleep; with fake timers, a boot that runs longer than five
minutes keeps renewing its claim and a second caller gets busy, a boot whose renewals stopped is
reclaimable five minutes after the last one, and activation after renewals succeeds),
`computer-settings.test.ts` (moving a computer whose network is off to a `vm` connection is
refused and nothing is saved), `fleet-host-authorization.test.ts` (mismatched VM settings refused;
`computer.remote.vm` accepted only from the API) and `fleet-connections.test.ts` (a VM connection
requires image consent). Phase 2 adds `FleetSettings.test.tsx` (VM defaults in the form, the
translated reasons, the unused-VM confirmation), `fleet.spec.ts` for the CI screenshot,
`i18n-catalog.test.ts`, and mobile `fleet-status.test.ts` and `i18n.test.ts`.

### Manual acceptance on a Mac

Use a Mac with Lima 2.2 or later and nothing important running in Ardur. `limactl shell` below
means `LIMA_HOME=~/.ardurbot/vm/lima limactl shell <name>`, which logs in as Lima's admin user.

1. Settings → Computers → Add computer → **Virtual machine**. Name it, keep the **Resources**
   defaults (2, 4Gi, 40Gi), read the download line and press **Add**. Watch the progress row reach
   ready and note the time. Press **Test** and check the Lima version and capacity.
2. Put a private bot on it and start a run. From the provider's log, record how long `create`,
   `start` and the readiness check took; `create` must fit its 3-minute bound (set the bound from
   this measurement), and the whole "Preparing the bot computer…" must stay under 13 minutes.
3. From the bot: `docker run hello-world` succeeds. `kind create cluster` succeeds,
   `kubectl get nodes` shows the node `Ready`, and `kind delete cluster` cleans up.
4. No host files: in the guest, `ls /Users` fails, and `mount` lists no `virtiofs`, `9p` or
   `sshfs` filesystem.
5. No host port forwards: in the guest, run `python3 -m http.server 8765 --bind 0.0.0.0`; on the
   host, `curl -m 3 http://127.0.0.1:8765` fails. On the host,
   `LIMA_HOME=~/.ardurbot/vm/lima limactl list --json` shows `sshLocalPort` and `hostAgentPID`,
   and `lsof -a -p <hostAgentPID> -iTCP -sTCP:LISTEN` lists only that port.
6. DNS works, host services do not: from the bot, `getent hosts registry-1.docker.io` answers and
   `resolvectl dns` lists only 192.168.5.2. On the host, run
   `python3 -m http.server 8766 --bind 127.0.0.1`; from the bot,
   `curl -m 3 http://192.168.5.2:8766` and `curl -m 3 http://host.lima.internal:8766` fail, as does
   `curl -m 3` to the router's LAN address. Over IPv6, `curl -g -m 3 'http://[fec0::2]:8766'` and
   `curl -6 -m 3 -sI https://registry-1.docker.io/v2/` fail. `curl -4 -sI https://registry-1.docker.io/v2/`
   still answers.
7. No escalation: from the bot, `sudo -n true` fails, `id` shows neither `sudo` nor `docker`,
   `nft list ruleset` is refused, `stat -c '%U %a' /etc/ssh/ardur/bot_authorized_keys` shows
   `root 644`, and appending to that file is refused. `echo "$DOCKER_HOST"` in the bot's session
   shows `unix:///run/user/2000/docker.sock`, while `limactl shell` then
   `sudo env | grep DOCKER_HOST` prints nothing, and `/etc/environment` has no `DOCKER_HOST`.
8. No root through the bot's home: from the bot, run `rm -rf ~/.ssh && ln -s /etc/systemd/system ~/.ssh`,
   then sleep and wake the computer. `stat -c '%U %a' /etc/systemd/system` still shows `root 755`,
   and the next run connects as before.
9. Sleep and wake: create a file and pull an image, note the contents of
   `~/.ardurbot/vm/known_hosts/<name>` on the host, sleep the computer in Settings, check that
   `LIMA_HOME=~/.ardurbot/vm/lima limactl list` shows `Stopped`, start a new run, and confirm the
   file and the image are still there, the wake took under 3 minutes, the run connected without a
   host-key error, and the pinned key is unchanged.
10. The firewall stays: in `limactl shell`, `systemctl is-enabled nftables.service` says `masked`,
    `systemctl show -p ExecStop ardur-firewall.service` shows no command, and
    `systemctl list-dependencies --reverse ardur-firewall.service` lists `systemd-networkd.service`.
    Run `sudo systemctl restart ardur-firewall.service`, then `sudo apt-get install --reinstall nftables`:
    after each, `sudo nft list table inet ardur` still shows the rules and the bot's
    `curl -m 3 http://192.168.5.2:8766` still fails.
11. The firewall fails closed: in `limactl shell`, replace `/etc/ardur/firewall.nft` with one
    invalid line, then sleep and wake the computer. The wake fails with "The virtual machine could
    not finish setting up…", `limactl shell` cannot connect (the guest has no network), and
    **Reset** recovers the computer.
12. Interrupted first boot: add a second VM computer, start a run, and quit Ardur while
    "Preparing the bot computer…" shows, ideally while `limactl shell` then
    `sudo tail -f /var/log/cloud-init-output.log` shows apt installing Docker. Relaunch and start a
    run again: it succeeds without **Reset**, the log shows the first-boot budget, and, if the
    install had been cut short, `dpkg --configure -a` in the next boot's cloud-init output.
13. Failure is reported quickly: turn the Mac's network off after the image is downloaded, add a
    third VM computer and start a run. It fails with "The virtual machine could not finish setting
    up…" well within 13 minutes, and the VM is gone from `limactl list`.
14. Move while asleep: sleep the first computer, then move it to a second VM connection whose
    CPU limit is 3. The move succeeds without waking the old VM, the workspace file is back, and
    `limactl list` shows a VM with a new name and 3 CPUs, and not the old one.
15. Network off: turn a Docker computer's network access off in Capabilities, then try to move it
    to a VM connection. It is refused with "Network isolation is not available on virtual machine
    computers." and the computer is unchanged.
16. Delete: remove the computer. The instance is gone from that `limactl list` and its directory
    from `~/.ardurbot/vm/lima`.
17. Quit Ardur with a VM running; it stops. Force-quit Ardur (or its host service) with a VM
    running, relaunch, and check that the reconciler stops it within about 10 minutes if its
    computer is not active.
18. Remove a computer while the host service is disconnected, reconnect, and check that Computers
    shows "1 unused virtual machine", that **Remove** asks with "Its disk and everything on it will
    be deleted." and that confirming deletes it.
19. Lease renewal: leave a computer running for more than an hour (the vz network's lease is one
    hour). The network still works, and `limactl shell` then
    `sudo journalctl -u systemd-networkd -b` shows no lost DHCPv4 lease.
20. Updates: in `limactl shell`, `apt-config dump APT::Periodic::Unattended-Upgrade` shows `"1"`.

### Manual acceptance on a Linux host

Use a Linux machine with KVM and Lima 2.2 or later. Repeat steps 1 to 11 of the Mac list (in step
6, `resolvectl dns` lists only 192.168.5.3), then check the paths that QEMU's user network opens
there:

1. On the host, run `python3 -m http.server 8767 --bind ::1`.
2. From the bot, `ip -6 addr` may list an `fec0::` address, but
   `curl -g -m 3 'http://[fec0::2]:8767'` fails, and so does
   `curl -6 -m 3 -sI https://registry-1.docker.io/v2/`, while
   `curl -4 -m 3 -sI https://registry-1.docker.io/v2/` answers.
3. Broadcast: on the host, listen with
   `python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('127.0.0.1', 8769)); print(s.recvfrom(64))"`.
   From the bot, send with
   `python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1); s.sendto(b'x', ('255.255.255.255', 8769))"`.
   The host receives nothing.
4. The host's own public address, on a host that has a public IPv4 address on an interface (for
   example a VPS): run `python3 -m http.server 8768 --bind 0.0.0.0` on the host; from the bot,
   `curl -m 3 http://<that address>:8768` answers, as [What it cannot reach](#what-it-cannot-reach)
   says. Restart the server with `--bind 127.0.0.1`: the same `curl` fails. Record both results.
5. Compare the first-boot time with the Mac's, to check that apt and curl did not stall on IPv6
   before falling back to IPv4.

## Implementation phases

### Phase 1: provider, lifecycle and SSH reuse, headless

A VM connection can be created through the API and used by bots; the web form waits for phase 2.

- Contracts: `fleet.ts` (the VM reachability reasons), `computer-connections.ts`
  (`engine: "vm"`, `vmImage`, VM bounds, and `VM_RESOURCE_DEFAULTS` applied by an engine-aware
  preprocess), `ids.ts`, `fleet-bridge.ts` and the new
  `vm-images.ts`, pinned to a current dated Ubuntu release (digests from Ubuntu's signed
  `SHA256SUMS`), with the template's `images` updated to match.
- Host runtime: `lima-template.ts` (with `vmLimits`), `lima.ts` (readiness, first boot and wake,
  time limits, cleanup after a failed start, `stop` that never wakes, host-key trust, network
  refusal, the size check, the real-path guard, last-use stamps and waking before SSH),
  `vm-locks.ts` (the interface and the in-process lock), `vm-image.ts` (downloads, `.part` names
  and references), the fake `testdata/limactl`, the Docker key fixtures in
  `testdata/docker-key/`, and the changes to `ssh-sandbox.ts`, `process.ts`, `service.ts` and
  `discovery.ts`.
- Adapters: `computer-connections.ts`, `fleet/service.ts` and the new `fleet/vm-locks.ts` (the
  Postgres locks), `fleet/remote-sandbox.ts`, `fleet/catalog.ts`, `computer-lifecycle.ts` (the
  booting-claim renewal, the checkpoint skip for stopped or suspended `vm` computers, and the
  progress label).
- API and host: `apps/api/src/app.ts` and `apps/worker/src/index.ts` (the VM locks from each
  process's lock pool), `apps/api/src/computer-settings.ts` (the network-off refusal),
  `apps/api/src/fleet.ts`, `apps/api/src/host-bridge.ts`, the VM reconciler with `images`,
  `apps/host-service/src/index.ts` and `apps/desktop/src/local-mode.ts` for stop on Quit.
- Tests: `lima-template.test.ts`, `lima.test.ts`, `vm-locks.test.ts`, `vm-locks.postgres.test.ts`,
  `vm-image.test.ts`, and the additions to `ssh-sandbox.test.ts`, `service.test.ts`, contracts
  `fleet.test.ts`, `remote-sandbox.test.ts`, `sandbox-conformance.test.ts`,
  `computer-lifecycle.test.ts`, `computer-settings.test.ts`, `fleet-host-authorization.test.ts`
  and `fleet-connections.test.ts`.
- Docs: turn this page's status into "implemented for offline verification" and add a row to
  [Fleet](fleet.md)'s target table.

### Phase 2: UI and capacity

- `apps/web/src/pages/fleet/FleetSettings.tsx` and `target-name.ts`: the connection type, the
  **Resources** fields starting from `VM_RESOURCE_DEFAULTS`, the download line, the progress row,
  the unused-VM row and its confirmation, and the four VM reasons; `FleetSettings.test.tsx`.
- Translations: the new messages in all nine `apps/web/src/locales/*/messages.po` catalogs, with
  plural messages for the unused count, its confirmation and the minutes left, and
  `apps/web/src/lib/i18n-catalog.test.ts`; "Virtual machine" in
  `apps/mobile/lib/locales/{ru,zh}.ts` and `apps/mobile/lib/i18n.test.ts`.
- `apps/web/e2e/fleet.spec.ts`: a VM form screenshot for CI, linked from the PR.
- `apps/mobile/components/fleet-status.tsx` and `apps/mobile/lib/fleet-status.test.ts`: read-only
  VM rows.
- `site/data/product.json`: add the Virtual machine computer, then `pnpm site:facts`.
- Capacity: the host's capacity on VM rows, and the VM's own CPU, memory and disk (from Fleet's
  existing Linux capacity command over SSH) in the computer's details.
- Run the manual acceptance lists (Mac and Linux) and fill in the measured times and sizes on this
  page.

### Phase 3: optional graphical desktop

Run Ardur's existing computer image inside the VM's rootless Docker, and reach its token-protected
screen gateway through a dedicated OpenSSH local forward from a private Unix socket on the host
(no TCP listener), which the existing screen proxy then uses. The VM keeps no forwarded ports and
no mounts. This needs its own design review: the forward's lifetime and authorization, and the
screen capability flags for `vm`.

### Follow-up: cloud VMs

The same shape works for a VM on a cloud provider: a provider-neutral create, start, stop, delete
and list behind an adapter, the same Ubuntu image and provisioning script (as cloud-init user
data), and the same SSH transport with a pinned host key. Vendor SDKs and credentials stay in that
adapter, as AGENTS.md requires, and nothing in the core loop depends on a cloud account.

## Open questions for the owner

1. **Root in the VM.** This design makes the bot an ordinary user with rootless Docker, because a
   root bot could reach apps listening only on the owner's machine. Recommendation: keep it
   unprivileged until Lima can hide the host's localhost.
2. **Stop VMs when Ardur quits.** Recommendation: yes, so they do not use memory unseen.
3. **Default size.** 2 CPUs, 4 GB memory and a 40 GB disk. Recommendation: keep these;
   kind's 8 GB advice is for building Kubernetes, not for running a small cluster.
4. **Unused VMs.** Ask before deleting them (recommended), or delete them automatically.
5. **Installing Lima.** Ask the owner to install Lima (recommended: no new dependency in Ardur), or
   bundle it with the desktop app.

## What is not verified yet

No VM was created, started or stopped while writing this design, so everything inside the guest is
unexecuted:

- the provisioning script as a whole (checked only with `bash -n` and ShellCheck), including
  rootless Docker set up through `runuser`, rootless kind on Ubuntu 24.04, and the kubectl path
  inside the client tarball;
- the firewall in a guest: the rules themselves (`nft` is not available on macOS, so not even
  `nft -c` ran), `ardur-firewall.service` loading before systemd-networkd and keeping the network
  down when it fails, that the image's network is managed by systemd-networkd, the nameserver
  check against `/run/systemd/resolve/resolv.conf` at provisioning time, DNS on both VM types,
  and DHCP renewals through the new exception;
- the sshd drop-in and the `sshd -T` check in the guest, and whether `/run/sshd` is the privilege
  separation directory `sshd -T` wants there. The same drop-in, with `SetEnv`, was checked in test
  mode with the host's own OpenSSH 10.3 against a scratch configuration: the `Match` applied to
  `bot` only, gave it both settings and ended at the end of its file;
- that `ssh_deletekeys: false` keeps the host keys across Lima reboots (from cloud-init's source
  and Lima's issue #678, not a boot);
- Docker's key fingerprint: it comes from Docker's earlier Ubuntu instructions, and the current
  page no longer prints it. A mismatch stops provisioning rather than trusting another key. The
  export was run only with throwaway keys and the host's GnuPG, not the guest's 2.4 (see
  [the round-2 notes](#review-notes));
- the `EXIT` trap and `write_file` were run with the host's bash 3.2, not the guest's bash 5.2,
  and with a stand-in for `sync`, whose file argument the host's `sync` does not take;
- the apt helpers against a real interrupted install, and whether Ubuntu's daily apt jobs hold
  apt's locks during a first boot;
- Lima's `create`, `start`, requirement and timeout behaviour, the IPv6 and broadcast paths through
  QEMU's user network, gvisor-tap-vsock's DNS and DHCP services, and the `limactl list --json`
  fields were read from the source of Lima 2.2.0, libslirp and gvisor-tap-vsock 0.8.9, not
  observed; whether apt and curl fall back to IPv4 promptly on a Linux host;
- a local image path at `create` and `start` time;
- the pinned `release-20260705` image download: its directory now redirects to Ubuntu's archive
  host, which could not be reached while checking. The digests are Lima 2.2.0's own; phase 1 pins
  a current release before shipping;
- whether any vsock endpoint on the host is reachable from the guest in plain mode;
- download time, `create` time, first-boot time (against Lima's roughly ten-minute final
  requirement) and disk use;
- that unattended upgrades are active in the pinned image;
- the Postgres VM locks and the booting-claim renewal, which exist only as this design;
- a Linux host with QEMU and KVM.

### Review notes

Two review rounds shaped this page. The second one found, among others, that the first revision's
firewall blocked the only nameserver a `vz` guest has, and that its Docker key check could be
bypassed. Both were checked before being fixed: the nameserver layout in Lima 2.2.0's `cidata.go`
and gvisor-tap-vsock 0.8.9's `services.go`; the key bypass with throwaway keys in scratch GnuPG
homes, where a second key hidden in an armor block of another type was not listed by the old
`gpg` check, was kept by the `awk` program from apt 2.7.14's `apt-key.in`, and was then accepted
by `gpgv`. The new export gave a keyring with only the pinned key in every case, and `gpgv` with it
rejected the other key's signature.

## Sources

Lima (the installed 2.2.0 templates were compared with the `v2.2.0` tag and are identical):

- [Reference template `default.yaml`](https://github.com/lima-vm/lima/blob/v2.2.0/templates/default.yaml):
  every template field, defaults, the port-forward `ignore` rule, and the merge rules for
  `_config/default.yaml` and `override.yaml`.
- [`_images/ubuntu-24.04.yaml`](https://github.com/lima-vm/lima/blob/v2.2.0/templates/_images/ubuntu-24.04.yaml)
  and [`docker.yaml`](https://github.com/lima-vm/lima/blob/v2.2.0/templates/docker.yaml).
- [Plain mode](https://lima-vm.io/docs/config/plain/),
  [port forwarding](https://lima-vm.io/docs/config/port/),
  [user-mode network](https://lima-vm.io/docs/config/network/user/),
  [network modes](https://lima-vm.io/docs/config/network/),
  [VM types](https://lima-vm.io/docs/config/vmtype/), [vz](https://lima-vm.io/docs/config/vmtype/vz/),
  [WSL2](https://lima-vm.io/docs/config/vmtype/wsl2/),
  [installation](https://lima-vm.io/docs/installation/), [SSH](https://lima-vm.io/docs/usage/ssh/),
  [internals](https://lima-vm.io/docs/dev/internals/),
  [environment variables](https://lima-vm.io/docs/config/environment-variables/) and
  [deprecated features](https://lima-vm.io/docs/releases/deprecated/).
- `limactl` [create](https://lima-vm.io/docs/reference/limactl_create/),
  [start](https://lima-vm.io/docs/reference/limactl_start/),
  [stop](https://lima-vm.io/docs/reference/limactl_stop/),
  [delete](https://lima-vm.io/docs/reference/limactl_delete/),
  [list](https://lima-vm.io/docs/reference/limactl_list/),
  [validate](https://lima-vm.io/docs/reference/limactl_validate/) and
  [show-ssh](https://lima-vm.io/docs/reference/limactl_show-ssh/).
- Source at `v2.2.0`: [instance fields](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/lima_instance.go),
  [`hostagent.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/hostagent/hostagent.go) and
  [`requirements.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/hostagent/requirements.go)
  (requirement order and retries),
  [`start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/start.go) (`Prepare`,
  "degraded", the timeout and the background host agent),
  [`cmd/limactl/start.go`](https://github.com/lima-vm/lima/blob/v2.2.0/cmd/limactl/start.go)
  (`create` runs `Prepare`),
  [`downloader.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/downloader/downloader.go) and
  [`disk.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driverutil/disk.go) (the image copy
  and disk conversion),
  [`opts_others.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/executil/opts_others.go)
  (the host agent's process group),
  [`boot.sh`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.TEMPLATE.d/boot.sh),
  [`user-data`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.TEMPLATE.d/user-data)
  and [`cidata.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.go) (boot
  sequence, the per-boot instance id and the guest's nameserver on each VM type),
  [`network-config`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/cidata/cidata.TEMPLATE.d/network-config),
  [`vm_darwin.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/vz/vm_darwin.go) and
  [`gvproxy.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/networks/usernet/gvproxy.go)
  (the `vz` network), [`validate.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limayaml/validate.go)
  (the `LIMA_CIDATA` warning), [`go.mod`](https://github.com/lima-vm/lima/blob/v2.2.0/go.mod),
  [`create.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/instance/create.go),
  [`filenames.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/filenames/filenames.go),
  [`dirnames.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/limatype/dirnames/dirnames.go)
  and `pkg/osutil` (the socket path rule, on the real path),
  [`qemu.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/driver/qemu/qemu.go) (QEMU's user
  network) and [`sshutil.go`](https://github.com/lima-vm/lima/blob/v2.2.0/pkg/sshutil/sshutil.go)
  (Lima's SSH options).
- Issues [#209](https://github.com/lima-vm/lima/issues/209) and
  [#678](https://github.com/lima-vm/lima/issues/678).

Guest system:

- cloud-init's SSH module,
  [`cc_ssh.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/config/cc_ssh.py).
- OpenSSH [`sshd(8)`](https://man.openbsd.org/sshd.8),
  [`sshd_config(5)`](https://man.openbsd.org/sshd_config.5),
  [`ssh_config(5)`](https://man.openbsd.org/ssh_config.5) and
  [`servconf.c` at 9.6p1](https://github.com/openssh/openssh-portable/blob/V_9_6_P1/servconf.c);
  Ubuntu 24.04's [openssh-server](https://packages.ubuntu.com/noble/openssh-server) package.
- [nft(8)](https://www.netfilter.org/projects/nftables/manpage.html), the nftables wiki on
  [atomic rule replacement](https://wiki.nftables.org/wiki-nftables/index.php/Atomic_rule_replacement)
  and [`ct direction`](https://wiki.nftables.org/wiki-nftables/index.php/Matching_connection_tracking_stateful_metainformation);
  Ubuntu 24.04's nftables package,
  [`nftables.service`](https://git.launchpad.net/ubuntu/+source/nftables/tree/debian/nftables.service?h=applied/ubuntu/noble-updates)
  and [`debian/rules`](https://git.launchpad.net/ubuntu/+source/nftables/tree/debian/rules?h=applied/ubuntu/noble-updates);
  debhelper's
  [`postinst-systemd-restartnostart`](https://salsa.debian.org/debian/debhelper/-/blob/main/autoscripts/postinst-systemd-restartnostart).
- systemd [systemd.unit(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html),
  [systemctl(1)](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html),
  [systemd-resolved.service(8)](https://www.freedesktop.org/software/systemd/man/latest/systemd-resolved.service.html)
  and, at v255 (Ubuntu 24.04's),
  [`sd-dhcp-client.c`](https://github.com/systemd/systemd/blob/v255/src/libsystemd-network/sd-dhcp-client.c).
- QEMU's [`-netdev user` options](https://www.qemu.org/docs/master/system/invocation.html);
  libslirp's [`socket.c`](https://gitlab.freedesktop.org/slirp/libslirp/-/blob/master/src/socket.c)
  and [`udp.c`](https://gitlab.freedesktop.org/slirp/libslirp/-/blob/master/src/udp.c);
  gvisor-tap-vsock 0.8.9's
  [`services.go`](https://github.com/containers/gvisor-tap-vsock/blob/v0.8.9/pkg/virtualnetwork/services.go)
  and [`dhcp.go`](https://github.com/containers/gvisor-tap-vsock/blob/v0.8.9/pkg/services/dhcp/dhcp.go).
- GnuPG's colon listing format, [`doc/DETAILS`](https://github.com/gpg/gnupg/blob/master/doc/DETAILS);
  [sources.list](https://manpages.ubuntu.com/manpages/noble/man5/sources.list.5.html) and
  [apt-secure](https://manpages.ubuntu.com/manpages/noble/man8/apt-secure.8.html); apt 2.7.14's
  [`gpgv.cc`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/apt-pkg/contrib/gpgv.cc),
  [`apt-key.in`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/cmdline/apt-key.in),
  [`debsystem.cc`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/apt-pkg/deb/debsystem.cc)
  and [`acquire.cc`](https://salsa.debian.org/apt-team/apt/-/blob/2.7.14/apt-pkg/acquire.cc);
  [dpkg(1)](https://man7.org/linux/man-pages/man1/dpkg.1.html).
- Ubuntu's sudo [`/etc/pam.d/sudo`](https://git.launchpad.net/ubuntu/+source/sudo/tree/debian/etc/pam.d/sudo?h=applied/ubuntu/noble-updates),
  [pam_env(8)](https://man7.org/linux/man-pages/man8/pam_env.8.html) and
  [sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/); Ubuntu's bash
  [`config-top.h`](https://git.launchpad.net/ubuntu/+source/bash/tree/config-top.h?h=applied/ubuntu/noble-updates).
- [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html),
  [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html),
  [CVE-2024-1086](https://nvd.nist.gov/vuln/detail/CVE-2024-1086) and Ubuntu Server's
  [automatic updates](https://documentation.ubuntu.com/server/how-to/software/automatic-updates/).
- PostgreSQL [advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

Ubuntu, Docker, kind and Kubernetes:

- [Ubuntu 24.04 cloud images, release 20260705](https://cloud-images.ubuntu.com/releases/noble/release-20260705/).
- Docker [Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
  [rootless mode](https://docs.docker.com/engine/security/rootless/) and its
  [troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/); the package
  versions were read from Docker's `noble` pool for
  [arm64](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/) and
  [amd64](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/).
- kind [quick start](https://kind.sigs.k8s.io/docs/user/quick-start/),
  [known issues](https://kind.sigs.k8s.io/docs/user/known-issues/),
  [rootless](https://kind.sigs.k8s.io/docs/user/rootless/) and the
  [v0.33.0 release](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0); the binary
  checksums are the asset digests GitHub reports for that release.
- [Install kubectl on Linux](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/) and the
  [1.37 changelog](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.37.md).

Other:

- [QEMU accelerators](https://www.qemu.org/docs/master/system/introduction.html): without KVM,
  QEMU falls back to pure emulation.
- [Sysbox](https://github.com/nestybox/sysbox),
  [Podman inside a container](https://www.redhat.com/en/blog/podman-inside-container),
  [Docker in gVisor](https://gvisor.dev/docs/tutorials/docker-in-gvisor/),
  [Kata Containers](https://katacontainers.io/learn/) and
  [Firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md).
