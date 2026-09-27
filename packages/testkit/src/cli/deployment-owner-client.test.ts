import type { Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { claimDeploymentOwner } from "../../../../apps/web/e2e/helpers.js";
import { DEPLOYMENT_OWNER_RENEW_MS } from "./deployment-owner.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("renews from the holder session and stops renewing before release", async () => {
  vi.useFakeTimers();
  vi.stubEnv("API_URL", "http://127.0.0.1:9999");
  const response = { ok: () => true, status: () => 200 };
  let finishRenewal: ((value: typeof response) => void) | undefined;
  const post = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockImplementationOnce(
      () => new Promise<typeof response>((resolve) => (finishRenewal = resolve)),
    );
  const remove = vi.fn().mockResolvedValue(response);
  const page = { request: { post, delete: remove } } as unknown as Page;

  const release = await claimDeploymentOwner(page);
  await vi.advanceTimersByTimeAsync(DEPLOYMENT_OWNER_RENEW_MS);
  expect(post).toHaveBeenCalledTimes(2);
  const releasing = release();
  expect(remove).not.toHaveBeenCalled();
  finishRenewal?.(response);
  await releasing;
  expect(remove).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(DEPLOYMENT_OWNER_RENEW_MS * 2);
  expect(post).toHaveBeenCalledTimes(2);
});
