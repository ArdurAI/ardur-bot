import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor.js";

vi.mock("@ardurbot/db", () => ({
  settleChiefActivity: vi.fn(),
  wakeGoalCoordinatorForDelegation: vi.fn(),
  backfillAutomaticBotMessageWake: vi.fn(),
  dispatchBotMessageWake: vi.fn(),
}));

import { settleChiefActivity, wakeGoalCoordinatorForDelegation } from "@ardurbot/db";
import { wakeGoalAfterDelegation } from "./goal-wake.js";

beforeEach(() => vi.resetAllMocks());
describe("chief activity settlement during goal wake", () => {
  it("cannot suppress a coordinator wake when the observational projection fails", async () => {
    vi.mocked(settleChiefActivity).mockRejectedValue(new Error("projection unavailable"));
    vi.mocked(wakeGoalCoordinatorForDelegation).mockResolvedValue(null);
    const deps = { prisma: { chiefPlan: {} }, jobs: {} } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "jobs"
    >;
    await expect(wakeGoalAfterDelegation(deps, "assignment")).resolves.toBeUndefined();
    expect(wakeGoalCoordinatorForDelegation).toHaveBeenCalledWith(deps.prisma, "assignment");
  });
  it("notifies only the scoped room projection without adding a second wake", async () => {
    vi.mocked(settleChiefActivity).mockResolvedValue({ threadId: "room", seq: 3 } as never);
    vi.mocked(wakeGoalCoordinatorForDelegation).mockResolvedValue(null);
    const notify = vi.fn(async () => {});
    const deps = { prisma: { chiefPlan: {} }, jobs: {}, events: { notify } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "jobs"
    > & { events: { notify: typeof notify } };
    await wakeGoalAfterDelegation(deps, "assignment");
    expect(notify).toHaveBeenCalledWith("room", 3);
    expect(wakeGoalCoordinatorForDelegation).toHaveBeenCalledTimes(1);
  });
});
