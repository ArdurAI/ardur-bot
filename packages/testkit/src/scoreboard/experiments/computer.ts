import type { AdapterContext, SandboxProvider } from "@ardurbot/adapter-kit";

/** The same lifecycle probe accepts an existing provider on its authorized isolated runner. */
export async function runComputerLifecycle(
  provider: SandboxProvider,
  request: Parameters<SandboxProvider["provision"]>[0],
  context: AdapterContext,
) {
  const marker = new TextEncoder().encode("Synthetic durable workspace marker");
  const cold = await provider.provision(request, context);
  try {
    const warm = await provider.provision(request, context);
    await provider.writeFile(warm, { path: "matrix-marker.txt", content: marker }, context);
    await provider.stop(warm, context);
    const resumed = await provider.provision(request, context);
    const retained = await provider.readFile(resumed, "matrix-marker.txt", context);
    const snapshot = provider.describe().capabilities.snapshots
      ? await provider.snapshot(resumed, context)
      : null;
    return {
      checks: {
        freshWorkspace: cold.fresh === true,
        sameWarmWorkspace: warm.id === cold.id && warm.fresh === false,
        stoppedWorkspaceReused: resumed.id === cold.id,
        retainedWorkspace: Buffer.from(retained ?? new Uint8Array()).equals(Buffer.from(marker)),
      },
      measurements: {
        provider: provider.describe().id,
        workspaceBytes: retained?.byteLength ?? null,
        snapshotReceipt: Boolean(snapshot?.id),
        snapshotRestoreVerified: false,
        imageAbsent: "requires-image-capable-provider-runner",
        diskGrowth: null,
        idleCost: null,
      },
    };
  } finally {
    await provider.destroy(cold, context);
  }
}

export const COMPUTER_RUNNERS = [
  { mode: "fake", runner: "local fixture", status: "executable" },
  { mode: "desktop", runner: "temporary local workspace; no host commands", status: "executable" },
  { mode: "docker", runner: "isolated cached-image engine", status: "requires-runner" },
  { mode: "podman", runner: "isolated cached-image engine", status: "requires-runner" },
  { mode: "ssh", runner: "disposable remote host", status: "requires-runner" },
  {
    mode: "kubernetes",
    runner: "disposable namespace and cached image",
    status: "requires-runner",
  },
] as const;
