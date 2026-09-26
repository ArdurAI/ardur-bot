import { homedir } from "node:os";
import { nativeHostOwner } from "@ardurbot/adapters";
import type { HostHealth, HostStatus } from "@ardurbot/contracts/host-bridge";
import { sandboxKindForBot } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { readRegisteredFolders } from "@ardurbot/host-runtime/desktop-sandbox";
import { hostCapacity } from "@ardurbot/host-runtime/fleet/capacity";
import {
  getHostEnvironment,
  inspectHostEnvironment,
} from "@ardurbot/host-runtime/host-environment";
import { inspectHostIntegrations } from "@ardurbot/host-runtime/host-integrations";
import { probeClaude } from "@ardurbot/host-runtime/runtimes/claude-code-runtime";
import { probeCodex } from "@ardurbot/host-runtime/runtimes/codex-app-server-runtime";

let health: Promise<HostHealth> | undefined;
let checkedAt = 0;

/**
 * Source deployments already run host adapters locally; never inspect a packaged API container.
 * The roots are the folders the command sandbox allows beyond a computer's own workspace. Local
 * mode's list is read fresh so an added folder applies at once; there are none until someone
 * adds one. A source checkout without that list keeps the home folder.
 */
export async function sourceHostStatus(
  prisma: PrismaClient,
  userId: string,
  sandboxKind: string,
): Promise<HostStatus | null> {
  if (process.env.ARDURBOT_HOST_BRIDGE === "api") return null;
  const deployment = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (
    sandboxKindForBot(sandboxKind, deployment?.computerHost) !== "desktop" ||
    !(await nativeHostOwner(prisma, userId))
  )
    return null;
  if (!health || Date.now() - checkedAt >= 30_000) {
    checkedAt = Date.now();
    health = Promise.all([
      inspectHostEnvironment(getHostEnvironment(), false),
      probeClaude(),
      probeCodex(),
      inspectHostIntegrations(),
    ])
      .then(([environment, claude, codex, integrations]) => ({
        platform: process.platform as HostHealth["platform"],
        roots: [],
        load: 0,
        environment,
        integrations,
        claude,
        codex,
      }))
      .catch((error) => {
        health = undefined;
        throw error;
      });
  }
  const file = process.env.ARDURBOT_HOST_ROOTS_FILE;
  const [current, roots, capacity] = await Promise.all([
    health,
    file ? readRegisteredFolders(file) : [homedir()],
    hostCapacity(),
  ]);
  // There is no paired registration to disconnect in source mode.
  return { configured: false, connected: true, roots, health: { ...current, roots, capacity } };
}
