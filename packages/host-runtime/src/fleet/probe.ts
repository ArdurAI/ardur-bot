import type { FleetReachabilityReason, FleetTarget } from "@ardurbot/contracts/fleet";
import type { FleetProcess } from "./process.js";

/** Only stable connection failures become user-facing results; never return raw CLI stderr. */
export function engineFailureReason(error: unknown): FleetReachabilityReason | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied|eacces|eperm|access is denied/i.test(message)) return "permission-denied";
  if (/timed? out|timeout|aborted|operation stopped/i.test(message)) return "timed-out";
  if (/enoent|no such file|does not exist/i.test(message)) return "socket-missing";
  if (
    /computer command could not start|install (docker|podman)|certificates are unavailable|choose client tls certificates/i.test(
      message,
    )
  )
    return "not-reachable";
  if (
    /engine-not-running|engine not running|refused|cannot connect|connection failed|unavailable|unreachable|no route|dial unix|error during connect/i.test(
      message,
    )
  )
    return "engine-not-running";
  return null;
}

export async function probeEngineEndpoint(
  target: Pick<FleetTarget, "kind" | "endpoint" | "context">,
  processes: FleetProcess,
): Promise<NonNullable<FleetTarget["reachability"]>> {
  const checkedAt = new Date().toISOString();
  const remote = target.endpoint?.startsWith("ssh://") || target.endpoint?.startsWith("tcp://");
  const name = target.kind === "podman" ? "podman" : "docker";
  const argv = [
    ...(target.context && name === "docker"
      ? ["--context", target.context]
      : target.endpoint
        ? [name === "podman" ? "--url" : "--host", target.endpoint]
        : []),
    "info",
    "--format",
    "{{json .}}",
  ];
  try {
    const result = await processes.run(
      name,
      argv,
      AbortSignal.timeout(3000),
      undefined,
      512 * 1024,
    );
    if (result.code === 0) return { status: "running", checkedAt };
    const reason =
      engineFailureReason(result.stderr.toString()) ??
      (remote ? "not-reachable" : "engine-not-running");
    return { status: remote ? "not-reachable" : "installed-not-running", reason, checkedAt };
  } catch (error) {
    const reason = engineFailureReason(error) ?? (remote ? "not-reachable" : "engine-not-running");
    return { status: remote ? "not-reachable" : "installed-not-running", reason, checkedAt };
  }
}
