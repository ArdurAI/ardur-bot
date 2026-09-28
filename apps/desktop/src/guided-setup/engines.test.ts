import type { FleetTarget } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { enginesGuidedStep } from "./engines.js";

const context = { runId: "test-run" };

describe("guided optional computers", () => {
  it("treats no optional computers as success and a timeout as a retryable failure", async () => {
    const processes = { start: vi.fn(), run: vi.fn() } as never;
    const discover = vi.fn(async () => ({ targets: [], timedOut: false, failed: false }));
    const engines = enginesGuidedStep({ now: () => 100, processes, discover });
    const signal = new AbortController().signal;
    expect(await engines.check(context, signal)).toMatchObject({ kind: "needed" });
    const receipt = await engines.run(context, signal);
    expect(await engines.verify(context, receipt, signal)).toMatchObject({
      kind: "satisfied",
      details: [{ code: "no-optional-computers", text: "No optional computers found" }],
    });
    discover.mockResolvedValueOnce({ targets: [], timedOut: true, failed: false });
    await expect(engines.run(context, signal)).rejects.toThrow("discovery-timeout");
  });

  it("retains distinct fleet states without saving endpoints or peer names", async () => {
    const targets = [
      {
        kind: "docker",
        state: "discovered",
        name: "private context",
        endpoint: "ssh://secret.invalid",
      },
      { kind: "podman", state: "connected", name: "private podman", endpoint: "unix:///secret" },
      { kind: "kubernetes", state: "unavailable", name: "private cluster", context: "private" },
    ] as FleetTarget[];
    const engines = enginesGuidedStep({
      now: () => 100,
      discover: async () => ({ targets, timedOut: false, failed: false }),
    });
    const signal = new AbortController().signal;
    const receipt = await engines.run(context, signal);
    const result = await engines.verify(context, receipt, signal);
    expect(result).toMatchObject({
      details: [
        { code: "target-discovered", text: "Docker 1" },
        { code: "target-connected", text: "Podman 1" },
        { code: "target-unavailable", text: "Kubernetes 1" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
