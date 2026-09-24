import { homedir } from "node:os";
import { nativeHostOwner } from "@ardurbot/adapters";
import type { HostHealth, HostStatus } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import {
  getHostEnvironment,
  inspectHostEnvironment,
} from "@ardurbot/host-runtime/host-environment";
import { probeClaude } from "@ardurbot/host-runtime/runtimes/claude-code-runtime";
import { probeCodex } from "@ardurbot/host-runtime/runtimes/codex-app-server-runtime";

let health: Promise<HostHealth> | undefined;
let checkedAt = 0;

/** Source deployments already run host adapters locally; never inspect a packaged API container. */
export async function sourceHostStatus(
  prisma: PrismaClient,
  userId: string,
  sandboxKind: string,
): Promise<HostStatus | null> {
  if (process.env.ARDURBOT_HOST_BRIDGE === "api") return null;
  const deployment = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (
    (sandboxKind !== "desktop" &&
      !(sandboxKind === "docker" && deployment?.computerHost === "this-mac")) ||
    !(await nativeHostOwner(prisma, userId))
  )
    return null;
  if (!health || Date.now() - checkedAt >= 30_000) {
    checkedAt = Date.now();
    health = Promise.all([
      inspectHostEnvironment(getHostEnvironment(), false),
      probeClaude(),
      probeCodex(),
    ])
      .then(([environment, claude, codex]) => ({
        platform: process.platform as HostHealth["platform"],
        roots: [homedir()],
        load: 0,
        environment,
        claude,
        codex,
      }))
      .catch((error) => {
        health = undefined;
        throw error;
      });
  }
  const current = await health;
  // There is no paired registration to disconnect in source mode.
  return { configured: false, connected: true, roots: current.roots, health: current };
}
