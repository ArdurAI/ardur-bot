import { describe, expect, it, vi } from "vitest";
import { integrationFailure, retryIntegrationRead } from "./integration-lifecycle.js";

describe("integration read recovery", () => {
  it("backs off transient reads then returns the successful result", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce({ code: 503 })
      .mockResolvedValue("tools");
    const wait = vi.fn(async () => undefined);
    await expect(retryIntegrationRead(read, undefined, wait)).resolves.toBe("tools");
    expect(wait.mock.calls).toEqual([[250], [500]]);
  });
  it("does not retry authentication or nontransient errors", async () => {
    const read = vi.fn().mockRejectedValue({ code: 401 });
    await expect(retryIntegrationRead(read)).rejects.toMatchObject({ code: 401 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("stops after three attempts and never persists provider prose", async () => {
    const read = vi.fn().mockRejectedValue(new TypeError("fake-secret"));
    await expect(retryIntegrationRead(read, undefined, async () => undefined)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(3);
    expect(integrationFailure(new Error("access_token=fake-secret"))).not.toContain("fake-secret");
  });
  it("respects cancellation before attempting a request", async () => {
    const read = vi.fn();
    await expect(retryIntegrationRead(read, AbortSignal.abort())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});
