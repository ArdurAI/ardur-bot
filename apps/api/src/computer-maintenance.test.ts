import type { Actor } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { releaseMaintenanceControl } from "./computer-maintenance.js";

function fixture() {
  const computer = {
    id: "computer",
    spaceId: "space",
    controlLeaseId: "lease",
    controlBotId: "bot",
    controlRunId: null as string | null,
    controlHolder: "user",
    providerRef: "provider",
    maintenanceId: null,
  };
  const owner = vi.fn(async () => ({ id: "bot" }) as { id: string } | null);
  const update = vi.fn(async () => ({ count: 1 }));
  const revoke = vi.fn(async () => {});
  const finalize = vi.fn(async () => ({ runId: null }));
  const cancel = vi.fn(async () => {});
  const deps = {
    prisma: {
      computer: { findUniqueOrThrow: async () => computer, updateMany: update },
      bot: { findFirst: owner },
    },
    sandbox: { setScreenControl: revoke },
    events: { finalizeComputerControlRelease: finalize },
    jobs: { cancel },
  } as unknown as Parameters<typeof releaseMaintenanceControl>[0];
  const actor = { userId: "user", spaceId: "space" } as Actor;
  return { deps, actor, computer, owner, update, revoke, finalize, cancel };
}
it("releases the caller's idle lease before confirmed maintenance with fenced provider revocation", async () => {
  const f = fixture();
  await releaseMaintenanceControl(f.deps, f.actor, "computer");
  expect(f.owner).toHaveBeenCalledWith({
    where: { id: "bot", computerId: "computer", spaceId: "space", userId: "user" },
    select: { id: true },
  });
  expect(f.revoke).toHaveBeenCalledWith(
    expect.anything(),
    false,
    expect.objectContaining({ userId: "user" }),
    "lease",
  );
  expect(f.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ leaseId: "lease", holder: "none", runId: null }),
  );
  expect(f.revoke.mock.invocationCallOrder[0]).toBeLessThan(
    f.finalize.mock.invocationCallOrder[0]!,
  );
});
it.each(["other-user", "active-run", "changed-lease", "provider-failure"])(
  "keeps maintenance blocked for %s",
  async (reason) => {
    const f = fixture();
    if (reason === "other-user") f.owner.mockResolvedValue(null);
    if (reason === "active-run") f.computer.controlRunId = "run";
    if (reason === "changed-lease") f.update.mockResolvedValue({ count: 0 });
    if (reason === "provider-failure") f.revoke.mockRejectedValue(new Error("unavailable"));
    await expect(releaseMaintenanceControl(f.deps, f.actor, "computer")).rejects.toThrow();
    expect(f.finalize).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  },
);
