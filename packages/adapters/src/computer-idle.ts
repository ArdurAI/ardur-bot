import {
  type AdapterContext,
  type AgentHomeStore,
  type ComputerRef,
  computerSleepJob,
  type JobPublisher,
  runContinueJob,
  type SandboxProvider,
} from "@ardurbot/adapter-kit";
import { computerSleepWorkspacePolicy } from "@ardurbot/contracts";
import { ACTIVE_RUN_STATUSES } from "@ardurbot/core";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { MissingComputerProviderError } from "./computer-connections.js";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { toComputerRef } from "./computer-lifecycle.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { owningSandbox } from "./host-aware-sandbox.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;
const BACKGROUND_WORK_IDLE_SENTINEL = "ardurbot-background-idle";
// The launcher, cancel, and idle probe must share one directory. TMPDIR is not that
// directory: a shell can see a different TMPDIR than the probe.
const backgroundMarkerDirectory = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'marker_dir="${ARDURBOT_BACKGROUND_DIR:-/tmp}"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'marker_dir="${marker_dir%/}"',
];

const backgroundWorkMarker = [
  ...backgroundMarkerDirectory,
  'marker="$marker_dir/ardurbot-background-$1-$2-$3"',
  "set -o noclobber",
  'exec 9>"$marker" || exit 1',
  "set +o noclobber",
];
export const BACKGROUND_WORK_LAUNCH = [...backgroundWorkMarker, 'exec bash -lc "$4"'].join("\n");
// Host PATH is captured once. Loading Bash's profile here would override it and can fail.
export const HOST_BACKGROUND_WORK_LAUNCH = [...backgroundWorkMarker, 'exec bash -c "$4"'].join(
  "\n",
);

/** The argv the executor uses to wrap one admitted shell command. */
export function backgroundShellArgv(
  computerId: string,
  runId: string,
  launchId: string,
  command: string,
  host = false,
): string[] {
  return [
    "bash",
    "-c",
    host ? HOST_BACKGROUND_WORK_LAUNCH : BACKGROUND_WORK_LAUNCH,
    "ardurbot-background-launch",
    computerId,
    runId,
    launchId,
    command,
  ];
}

/** Terminate background shell wrappers for one cancelled run. Browser teardown stays screen-scoped. */
export const CANCEL_COMPUTER_RUN_WORK = [
  'computerId="$1"',
  'runId="$2"',
  '[ -n "$computerId" ] && [ -n "$runId" ] || exit 0',
  ...backgroundMarkerDirectory,
  'prefix="$marker_dir/ardurbot-background-$computerId-$runId-"',
  // Match the timeout wrapper cmdline (still contains the launch tag after exec into the user command).
  `pkill -TERM -f "ardurbot-background-launch $computerId $runId " 2>/dev/null || true`,
  "if [ -d /proc ]; then",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)" || continue',
  '    case "$target" in',
  '      "$prefix"*)',
  '        pid="${fd#/proc/}"; pid="${pid%%/*}"',
  '        if [ -n "$pid" ] && [ "$pid" -eq "$pid" ] 2>/dev/null; then',
  // Never kill -PID (process group): sandbox work often shares the caller's PGID.
  '          kill -TERM "$pid" 2>/dev/null || true',
  "        fi",
  "        ;;",
  "    esac",
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -TERM "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  "sleep 0.2",
  `pkill -KILL -f "ardurbot-background-launch $computerId $runId " 2>/dev/null || true`,
  "if [ -d /proc ]; then",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)" || continue',
  '    case "$target" in',
  '      "$prefix"*)',
  '        pid="${fd#/proc/}"; pid="${pid%%/*}"',
  '        if [ -n "$pid" ] && [ "$pid" -eq "$pid" ] 2>/dev/null; then',
  '          kill -KILL "$pid" 2>/dev/null || true',
  "        fi",
  "        ;;",
  "    esac",
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -KILL "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  'rm -f -- "$prefix"* 2>/dev/null || true',
].join("\n");

/**
 * Kill the primary browser session without matching chromium-screen-* profiles.
 * Covers Docker (--user-data-dir=.../chromium) and portable launches that only
 * use the symlinked primary profile (E2B desktop.launch / Daytona nohup).
 */
export const CANCEL_PRIMARY_BROWSER_WORK = [
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  // Portable primary browsers often omit --user-data-dir; match argv0 only so
  // unrelated processes (e.g. node --engine=chromium) are not killed.
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  '      kill -TERM "${pid#/proc/}" 2>/dev/null || true',
  "      ;;",
  "  esac",
  "done; fi",
  "sleep 0.2",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  '      kill -KILL "${pid#/proc/}" 2>/dev/null || true',
  "      ;;",
  "  esac",
  "done; fi",
  'rm -f "$HOME/.browser-profiles/chromium/SingletonLock" "$HOME/.browser-profiles/chromium/SingletonCookie" "$HOME/.browser-profiles/chromium/SingletonSocket" 2>/dev/null || true',
].join("; ");

export function cancelComputerRunWorkArgv(computerId: string, runId: string): string[] {
  return ["bash", "-c", CANCEL_COMPUTER_RUN_WORK, "ardurbot-cancel-run-work", computerId, runId];
}

export async function cancelComputerRunWork(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<void> {
  if (!computerId || !runId) return;
  try {
    for await (const _event of sandbox.execute(
      computer,
      { argv: cancelComputerRunWorkArgv(computerId, runId), timeoutMs: 15_000 },
      context,
    )) {
      // Drain so providers can finish the exec session.
    }
  } catch {
    // Best effort after the run is already cancelled.
  }
}

export const BACKGROUND_WORK_PROBE = [
  ...backgroundMarkerDirectory,
  'prefix="$marker_dir/ardurbot-background-$1-"',
  `idle() { printf '${BACKGROUND_WORK_IDLE_SENTINEL}\\n'; exit 1; }`,
  'markers=("$prefix"*)',
  "if [ -d /proc ]; then",
  "  command -v readlink >/dev/null 2>&1 || exit 2",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)"',
  '    case "$target" in "$prefix"*) exit 0 ;; esac',
  "  done",
  `  for marker in "\${markers[@]}"; do [ -e "$marker" ] && rm -f -- "$marker"; done`,
  "  idle",
  "fi",
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
  "  command -v lsof >/dev/null 2>&1 || exit 2",
  `  for marker in "\${markers[@]}"; do`,
  '    [ -e "$marker" ] || continue',
  '    lsof -t -- "$marker" >/dev/null 2>&1 && exit 0',
  '    rm -f -- "$marker"',
  "  done",
  "  idle",
  "fi",
  "exit 2",
].join("\n");

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export async function scheduleComputerSleep(
  deps: { jobs: JobPublisher; prisma: PrismaClient },
  computerId: string,
): Promise<void> {
  if (!computerId) return;
  const computer = await deps.prisma.computer.findUnique({
    where: { id: computerId },
    select: { sleepFailureReason: true },
  });
  if (!computer || computer.sleepFailureReason) return;
  await deps.jobs.enqueue(computerSleepJob(computerId, new Date(Date.now() + sandboxIdleMs())));
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher; prisma: PrismaClient },
  computer: Parameters<typeof toComputerRef>[0] & {
    id: string;
    spaceId: string;
    userId: string;
    connectionId: string | null;
  },
): Promise<void> {
  await scheduleComputerSleep(deps, computer.id);
  await keepComputerAlive(deps.sandbox, toComputerRef(computer), {
    operationId: "computer.heartbeat",
    traceId: "computer.heartbeat",
    spaceId: computer.spaceId,
    userId: computer.userId,
    signal: new AbortController().signal,
  });
}

async function keepComputerAlive(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  await (await owningSandbox(sandbox, computer, context)).keepAlive?.(computer);
}

export async function sleepComputerIfIdle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
): Promise<void> {
  const computer = await loadComputer(deps.prisma, computerId);
  if (!computer?.providerRef || computer.state !== "running" || computer.sleepFailureReason) return;
  try {
    await owningSandbox(deps.sandbox, toComputerRef(computer), {
      operationId: "computer.sleep",
      traceId: "computer.sleep",
      spaceId: computer.spaceId,
      userId: computer.userId,
      signal: new AbortController().signal,
    });
    await performIdleSleep(deps, computerId, computer);
  } catch (error) {
    if (!(error instanceof MissingComputerProviderError)) throw error;
    // A settings change during the attempt must not inherit an old engine's failure.
    await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        kind: computer.kind,
        connectionId: computer.connectionId,
        providerRef: computer.providerRef,
        updatedAt: computer.updatedAt,
      },
      data: { sleepFailureReason: error.message },
    });
  }
}

async function performIdleSleep(
  deps: Parameters<typeof sleepComputerIfIdle>[0],
  computerId: string,
  initial: NonNullable<Awaited<ReturnType<typeof loadComputer>>>,
): Promise<void> {
  let computer = initial;
  if (!computer?.providerRef || computer.state !== "running") return;

  if (computer.controlBotId && computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    await expireComputerControl(deps, computer.id, computer.controlLeaseId);
    const reloaded = await loadComputer(deps.prisma, computerId);
    if (!reloaded?.providerRef || reloaded.state !== "running") return;
    computer = reloaded;
  }

  const activeStatuses = hasActiveComputerControl(computer)
    ? [...ACTIVE_RUN_STATUSES]
    : ACTIVE_RUN_STATUSES.filter((status) => status !== "waiting_takeover");
  if (await findActiveRun(deps.prisma, computerId, activeStatuses)) {
    await scheduleComputerSleep(deps, computerId);
    return;
  }

  const ref = toComputerRef(computer);
  const abort = new AbortController();
  const ctx: AdapterContext = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.controlBotId ?? undefined,
    signal: abort.signal,
  };
  if (await hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId)) {
    await keepComputerAlive(deps.sandbox, ref, ctx);
    await scheduleComputerSleep(deps, computerId);
    return;
  }

  let checkpointedAt = new Date();
  const recorded = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      maintenanceId: null,
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      executionLeases: { none: { expiresAt: { gt: checkpointedAt } } },
    },
    data: { state: "suspending", updatedAt: checkpointedAt },
  });
  if (recorded.count !== 1) {
    await scheduleComputerSleep(deps, computerId);
    return;
  }
  const suspensionClaim = {
    id: computerId,
    state: "suspending",
    providerRef: computer.providerRef,
    updatedAt: checkpointedAt,
  };

  try {
    if (computerSleepWorkspacePolicy(computer) === "checkpoint") {
      try {
        // Long saves must not look abandoned to a new run after the lifecycle TTL.
        // Renew only our stamp, then settle renewal before writing the revision.
        let renewal = Promise.resolve();
        let renewalError: unknown;
        const heartbeat = setInterval(() => {
          renewal = renewal.then(async () => {
            if (abort.signal.aborted) return;
            const nextStamp = new Date(Math.max(Date.now(), checkpointedAt.getTime() + 1));
            try {
              const renewed = await deps.prisma.computer.updateMany({
                where: { ...suspensionClaim },
                data: { updatedAt: nextStamp },
              });
              if (renewed.count !== 1) {
                const lost = new Error("Idle save lost its lifecycle claim");
                abort.abort(lost);
                throw lost;
              }
              checkpointedAt = nextStamp;
              suspensionClaim.updatedAt = nextStamp;
              renewalError = undefined;
            } catch (error) {
              renewalError = error;
              // Retry transient renewal failures, but cancel well before our stamp
              // can become reclaimable if the database remains unavailable.
              if (Date.now() - checkpointedAt.getTime() >= 120_000) abort.abort(error);
            }
          });
        }, 30_000);
        heartbeat.unref?.();
        let revision: string;
        try {
          revision = await checkpointComputerWorkspace(
            deps.home,
            deps.sandbox,
            computer.homeKey,
            ref,
            ctx,
          );
        } finally {
          clearInterval(heartbeat);
          await renewal;
        }
        if (renewalError) throw renewalError;
        const saved = await deps.prisma.computer.updateMany({
          where: suspensionClaim,
          data: { homeRevision: revision, updatedAt: checkpointedAt },
        });
        if (saved.count !== 1) {
          await deps.prisma.computer.updateMany({
            where: suspensionClaim,
            data: { state: "running" },
          });
          await scheduleComputerSleep(deps, computerId);
          return;
        }
      } catch (error) {
        if (error instanceof MissingComputerProviderError) throw error;
        await deps.prisma.computer.updateMany({
          where: suspensionClaim,
          data: { state: "running" },
        });
        await scheduleComputerSleep(deps, computerId);
        throw error;
      }
    }

    const [current, activeAfterCheckpoint, backgroundAfterCheckpoint] = await Promise.all([
      deps.prisma.computer.findUnique({
        where: { id: computerId },
        select: { state: true, providerRef: true, updatedAt: true },
      }),
      findActiveRun(deps.prisma, computerId, activeStatuses),
      hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId),
    ]);
    if (activeAfterCheckpoint || backgroundAfterCheckpoint) {
      const resumed = await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      if (resumed.count === 1 && activeAfterCheckpoint) {
        // Replace delayed busy-run continuations after releasing the save fence.
        await continueQueuedComputerRuns(deps, computerId);
      }
      if (backgroundAfterCheckpoint) await keepComputerAlive(deps.sandbox, ref, ctx);
      await scheduleComputerSleep(deps, computerId);
      return;
    }
    if (
      current?.state !== "suspending" ||
      current.providerRef !== computer.providerRef ||
      current.updatedAt.getTime() !== checkpointedAt.getTime()
    ) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      await scheduleComputerSleep(deps, computerId);
      return;
    }

    try {
      await deps.sandbox.stop(ref, ctx);
    } catch (error) {
      if (error instanceof MissingComputerProviderError) throw error;
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      throw error;
    }
    await deps.prisma.computer.update({
      where: suspensionClaim,
      data: {
        state: "suspended",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    const bots = await deps.prisma.bot.findMany({
      where: { computerId },
      select: { id: true, thread: { select: { id: true } } },
    });
    for (const bot of bots) {
      if (!bot.thread) continue;
      await deps.events.append({
        spaceId: computer.spaceId,
        threadId: bot.thread.id,
        botId: bot.id,
        type: "computer.status",
        payload: { status: "suspended" },
      });
    }
    // A message can arrive after the last activity check but before stop finishes.
    // Its continuation now wakes the suspended computer without a retry delay.
    await continueQueuedComputerRuns(deps, computerId);
  } catch (error) {
    if (error instanceof MissingComputerProviderError) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running", sleepFailureReason: error.message },
      });
      return;
    }
    throw error;
  }
}

async function continueQueuedComputerRuns(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  computerId: string,
) {
  const queued = await deps.prisma.run.findMany({
    where: { bot: { computerId }, status: "queued", cancelRequestedAt: null },
    select: { id: true },
  });
  for (const run of queued) await deps.jobs.enqueue(runContinueJob(run.id));
}

function loadComputer(prisma: PrismaClient, computerId: string) {
  return prisma.computer.findUnique({
    where: { id: computerId },
    select: {
      id: true,
      homeKey: true,
      providerRef: true,
      kind: true,
      connectionId: true,
      imageProfile: true,
      networkEgress: true,
      state: true,
      spaceId: true,
      userId: true,
      controlHolder: true,
      controlLeaseId: true,
      controlLeaseExpiresAt: true,
      controlBotId: true,
      updatedAt: true,
      sleepFailureReason: true,
    },
  });
}

function findActiveRun(prisma: PrismaClient, computerId: string, statuses: readonly string[]) {
  return prisma.run.findFirst({
    where: {
      bot: { computerId },
      status: { in: statuses as (typeof ACTIVE_RUN_STATUSES)[number][] },
    },
    select: { id: true },
  });
}

async function hasActiveBackgroundWork(
  sandbox: SandboxProvider,
  computer: ReturnType<typeof toComputerRef>,
  context: AdapterContext,
  computerId: string,
): Promise<boolean> {
  if (sandbox.inspectBackgroundWork) {
    try {
      return (await sandbox.inspectBackgroundWork(computer, computerId, context)) !== "idle";
    } catch (error) {
      if (error instanceof MissingComputerProviderError) throw error;
      return true;
    }
  }
  let exitCode: number | undefined;
  let stdout = "";
  try {
    for await (const event of sandbox.execute(
      computer,
      {
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "ardurbot-background-probe", computerId],
        timeoutMs: 10_000,
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") exitCode = event.code;
    }
  } catch (error) {
    if (error instanceof MissingComputerProviderError) throw error;
    return true;
  }
  // Only the probe's explicit idle result permits suspension; unsupported or failed probes retry.
  return exitCode !== 1 || stdout.trim() !== BACKGROUND_WORK_IDLE_SENTINEL;
}
