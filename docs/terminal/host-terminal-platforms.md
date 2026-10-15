# Host terminal backends (admission disabled)

This work prepares Windows and Linux terminals for builders and local-first users.
It does not expose a terminal button, change product claims, or enable a connection.
The desktop computer still declares `interactiveTerminal: false` on every OS.
The host-service exports factories for conformance tests and later explicit injection;
it does not inject any factory into the running host agent.

## Process ownership and cleanup

All backends preserve the shared terminal provider's owner, generation, lease,
fence, environment and starting-folder checks. Input and resize stop when closing
begins. Cleanup must finish before releasing a session. A failure retains the
closing session for another cleanup attempt. Native cleanup uses a 9.5-second
budget inside the provider's 10-second deadline.

### Windows

The pinned node-pty backend uses ConPTY on supported 64-bit Windows systems. The
adapter refuses older systems rather than falling back to WinPTY. The default
shell is the absolute system `cmd.exe`, with `/d /q`: AutoRun is disabled and no
user input is delivered until job assignment succeeds. Other shells are refused
at this stage.

The existing Koffi native loader supplies Win32 calls. Each terminal gets a
private, non-inheritable Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
no breakaway flags. The shell is assigned immediately after spawn. Descendants,
including detached children, inherit job membership. Cleanup terminates the job,
queries its active-process count until it reaches zero, then closes the job
handle. It never reopens a numeric PID during cleanup. The bundled ConPTY DLL
uses its released pseudoconsole lifetime. A narrow compatibility seam for the
pinned node-pty layout closes the owned pipes and awaits its output worker; it
does not call the public console-list kill path. An unexpected layout or a stuck
worker keeps cleanup failed rather than silently leaking resources. Host-process death closes
the job handle and invokes the same kernel kill-on-close protection. A failed
query or termination is not proof of an empty job.

node-pty 1.1.0 does not expose suspended creation, the shell process handle, or a
job-list creation attribute. Assignment through Koffi therefore happens after
creation, not atomically with creation. Disabling cmd AutoRun and withholding
input avoids running profile/user commands before assignment; this is not a
promise of atomic assignment for arbitrary shells. Job-assignment failures
refuse opening and terminate the pinned shell handle when available. Installed
acceptance must check nested-job restrictions, crash/restart behavior and cleanup
under the desktop supervisor's actual Windows token.

### Linux

node-pty creates a new session before executing the shell. The adapter checks
that the shell is its session and process-group leader. The captured absolute
POSIX login shell is used, with `/bin/sh` as the existing fallback.

Linux reuses the macOS descendant tracker and its shared, non-overlapping
500-millisecond poller. `/proc/<pid>/stat` supplies parent, group, session, state
and exact start ticks, without reading command arguments or environments.
Snapshots read at most 32 stat files concurrently. Failed or malformed lookups
cannot establish that a tree is gone. A reused PID cannot acquire ownership or
receive a signal on the strength of an older identity.

Cleanup first sends TERM to the proven process group, then to tracked members
that left it. It escalates to KILL after 1.5 seconds. Reparented members of the
original session can be discovered while that session has a known live anchor;
previously observed descendants remain tracked after setsid or shell exit.
Every retry requires a fresh snapshot.

**Polling is not complete process containment.** A child that calls setsid and
reparents entirely between observations can escape discovery, on both POSIX
backends. The detached-child conformance test deliberately keeps its parent
alive until cleanup can observe the lineage. Passing that test does not prove
arbitrary double-fork containment. Stronger kernel ownership, such as an owned
cgroup with appropriate delegation, needs a separate design before claiming
that guarantee. PID identity checks also have the usual snapshot-to-signal race;
they are not pidfds.

## Protected paths and environment

| Boundary | macOS | Windows | Linux |
| --- | --- | --- | --- |
| File-tool reads and writes | Deny the configured protected paths | Same deny list; native relative handles contain allowed writes | Same deny list |
| Terminal starting folder | Canonical approved root; protected folders refused | Same provider checks | Same provider checks |
| Shell file access | Seatbelt denies the configured paths in descendants | No OS process guard here | No OS process guard here |
| Shell loopback/socket access | Seatbelt denies the configured ports and sockets | No OS process guard here | No OS process guard here |
| Terminal environment | Shared allowlist filter | Same filter, case-insensitive input keys | Same filter |

A starting folder is not confinement. File-tool path checks do not prevent a
terminal command from writing another path. Windows directory-handle protection
belongs to the in-process file writer; a Job Object controls process lifetime,
not file or network access. The factories retain the guard-aware provider
contract but the Windows/Linux shell wrappers do not enforce process-level
path, port or socket denies. Do not enable them on the strength of file-tool
refusal tests.

Offline tests attempt writes to fake protected files through the existing file
tool on all three platform configurations, and verify protected terminal cwd
refusal and filtered environments for Windows and Linux. Those tests demonstrate
these specific boundaries, not shell confinement.

## Native packaging and CI evidence

No dependency version changes are required. All staged modules retain upstream
MIT notices. Runtime staging includes loaders and licenses but excludes build
sources, install scripts, debug symbols and compilers.

- Windows x64 and arm64: stage the installed 1.1.0 prebuilds, ConPTY libraries,
  output worker, shared worker module and console-list agent. Keep upstream's
  relative layout. The desktop's existing `extraResources` rule copies this
  architecture's directory next to the host-service bundle, outside asar.
- Linux x64 and arm64: each release uses a matching native architecture runner.
  Before the desktop build, `rebuild-linux-pty.mjs` invokes the already installed
  node-gyp against the Electron version pinned by the desktop manifest and its
  headers. It builds the installed node-pty source in the disposable CI checkout;
  staging then copies `build/Release/pty.node` and the Unix JavaScript loader.
  Native compilation never runs at app startup. The release build needs the
  Electron header download, Python, make and a C++ compiler.
- Both release targets run native terminal tests and load the staged module
  with `ELECTRON_RUN_AS_NODE=1` using the pinned Electron executable. This verifies
  the actual embedded runtime, rather than inferring compatibility from the
  build shell's Node version. Pull-request CI also runs Windows and Ubuntu jobs.
- Native tests open the default shell in a disposable work folder, test resize
  and interrupt, then await cleanup of their shell and detached descendants.
  Tests skip on other operating systems. Loaded Windows runtime DLLs remain in
  the runner temp directory until the test worker exits; work folders are
  removed after their owned processes terminate.

CI can prove those runtime-specific tests only after the branch is published.
Installed-machine acceptance, fullscreen programs, desktop supervision on
crash/restart, and a process-level path protection decision remain prerequisites
for the later capability-enablement step. No native runner result is claimed
from an offline macOS sandbox.
