// @vitest-environment jsdom
import type { ArdurBotSetup } from "@ardurbot/contracts";
import type { SetupSnapshot, SetupStepId } from "@ardurbot/contracts/desktop-setup";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SetupDocument } from "./renderer.js";

const ids: SetupStepId[] = [
  "prerequisites",
  "database",
  "migrations",
  "command",
  "services",
  "engines",
  "model",
  "first-bot",
  "finish",
];

function snapshot(status: "pending" | "running" | "succeeded" | "failed"): SetupSnapshot {
  return {
    schemaVersion: 1,
    planVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    mode: "local",
    currentStep: status === "running" ? "database" : null,
    machineReady: false,
    accountReady: false,
    complete: false,
    interrupted: false,
    blocked: false,
    steps: ids.map((id, index) => ({
      id,
      available: index < 4,
      revision: index < 4 ? 1 : 0,
      attempt: index < 4 && status !== "pending" ? 1 : 0,
      status: index < 4 ? status : "pending",
      activeElapsedMs: 0,
      waitingElapsedMs: 0,
      verifiedAt: index < 4 && status === "succeeded" ? 100 : null,
      reasonCode: null,
      details: [],
    })),
  };
}

function fakeBridge(initial: SetupSnapshot, platform = "test", initiallyEnabled = false) {
  const started = Promise.withResolvers<SetupSnapshot>();
  let nativeStartup = initiallyEnabled;
  let publish: (value: SetupSnapshot) => void = () => undefined;
  const guided = {
    snapshot: vi.fn(async () => initial),
    start: vi.fn(() => started.promise),
    retry: vi.fn(() => started.promise),
    skip: vi.fn(async () => initial),
    cancel: vi.fn(async () => {
      nativeStartup = initiallyEnabled;
      return { ...initial, sequence: 2 };
    }),
    getStartup: vi.fn(async () => ({ supported: true, enabled: nativeStartup })),
    setStartup: vi.fn(async (enabled: boolean) => {
      nativeStartup = enabled;
      return { ok: true, enabled };
    }),
    resume: vi.fn(() => started.promise),
    onChange: vi.fn((listener: (value: SetupSnapshot) => void) => {
      publish = listener;
      return vi.fn();
    }),
  };
  const bridge = {
    platform,
    guidedSetup: guided,
    quit: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: false })),
    save: vi.fn(async () => ({ ok: true })),
    stack: { start: vi.fn(async () => ({ phase: "idle" })) },
  } as unknown as ArdurBotSetup;
  return {
    bridge,
    guided,
    started,
    restoreStartup: () => {
      nativeStartup = initiallyEnabled;
    },
    publish: (value: SetupSnapshot) => publish(value),
  };
}

async function mount(bridge: ArdurBotSetup) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SetupDocument, { setupBridge: bridge })));
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("guided setup document", () => {
  it("initializes the startup choice from the enabled native preference", async () => {
    const initial = snapshot("succeeded");
    initial.currentStep = "services";
    initial.steps[4]!.available = true;
    initial.steps[4]!.status = "waiting-input";
    const fake = fakeBridge(initial, "darwin", true);
    const view = await mount(fake.bridge);
    try {
      expect(fake.guided.getStartup).toHaveBeenCalledOnce();
      expect(view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
        true,
      );
    } finally {
      await view.cleanup();
    }
  });

  it("refreshes the restored startup preference after Cancel and Start", async () => {
    const initial = snapshot("succeeded");
    initial.currentStep = "services";
    initial.steps[4]!.available = true;
    initial.steps[4]!.status = "waiting-input";
    const stopped = structuredClone(initial);
    stopped.sequence = 2;
    stopped.currentStep = null;
    stopped.steps[4]!.status = "cancelled";
    const restarted = structuredClone(initial);
    restarted.sequence = 3;
    const fake = fakeBridge(initial, "darwin");
    fake.guided.cancel.mockImplementation(async () => {
      fake.restoreStartup();
      return stopped;
    });
    fake.guided.start.mockResolvedValue(restarted);
    const view = await mount(fake.bridge);
    try {
      const choice = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      await act(async () => choice.click());
      expect(choice.checked).toBe(true);
      const cancel = [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      );
      await act(async () => cancel?.click());
      const start = [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Start setup",
      );
      await act(async () => start?.click());
      expect(fake.guided.getStartup).toHaveBeenCalledTimes(2);
      expect(view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
        false,
      );
    } finally {
      await view.cleanup();
    }
  });
  it("rechecks a saved ready journal before handoff", async () => {
    const initial = snapshot("succeeded");
    for (const row of initial.steps.slice(0, 6)) {
      row.available = true;
      row.status = "succeeded";
    }
    const fake = fakeBridge(initial);
    fake.guided.start.mockResolvedValue(initial);
    const view = await mount(fake.bridge);
    try {
      const continueButton = [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Continue setup",
      );
      expect(continueButton).toBeDefined();
      await act(async () => continueButton?.click());
      expect(fake.guided.start).toHaveBeenCalledOnce();
      expect(fake.bridge.stack.start).toHaveBeenCalledOnce();
    } finally {
      await view.cleanup();
    }
  });

  it("shows a concrete failed recheck without attempting handoff", async () => {
    const initial = snapshot("succeeded");
    for (const row of initial.steps.slice(0, 6)) {
      row.available = true;
      row.status = "succeeded";
    }
    const failed = structuredClone(initial);
    failed.sequence = 2;
    failed.currentStep = "engines";
    failed.steps[5]!.status = "failed";
    failed.steps[5]!.reasonCode = "discovery-timeout";
    const fake = fakeBridge(initial);
    fake.guided.start.mockResolvedValue(failed);
    const view = await mount(fake.bridge);
    try {
      const continueButton = [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Continue setup",
      );
      await act(async () => continueButton?.click());
      expect(fake.guided.start).toHaveBeenCalledOnce();
      expect(fake.bridge.stack.start).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain("Optional computer discovery timed out. Retry.");
    } finally {
      await view.cleanup();
    }
  });
  it.each(["Start setup", "Retry", "Resume"])(
    "sends Cancel while %s is still pending",
    async (label) => {
      const initial = snapshot(label === "Retry" ? "failed" : "pending");
      if (label === "Resume") initial.interrupted = true;
      const fake = fakeBridge(initial);
      const view = await mount(fake.bridge);
      try {
        const start = [...view.host.querySelectorAll("button")].find(
          (button) => button.textContent === label,
        );
        expect(start).toBeDefined();
        await act(async () => start?.click());
        expect(
          label === "Retry"
            ? fake.guided.retry
            : label === "Resume"
              ? fake.guided.resume
              : fake.guided.start,
        ).toHaveBeenCalledOnce();
        // An event from the main process exposes Cancel while the start promise is pending.
        await act(async () => fake.publish(snapshot("running")));
        const cancel = [...view.host.querySelectorAll("button")].find(
          (button) => button.textContent === "Cancel",
        );
        expect(cancel).toBeDefined();
        await act(async () => cancel?.click());
        expect(fake.guided.cancel).toHaveBeenCalledOnce();
      } finally {
        fake.started.resolve(snapshot("succeeded"));
        await view.cleanup();
      }
    },
  );

  it.each(["completed", "cancelled"])(
    "unlocks the server choice for a %s reopened journal",
    async (state) => {
      const initial = snapshot("succeeded");
      if (state === "cancelled") initial.steps[3]!.status = "cancelled";
      const fake = fakeBridge(initial);
      const view = await mount(fake.bridge);
      try {
        const server = view.host.querySelectorAll<HTMLInputElement>('input[name="mode"]')[1];
        expect(view.host.querySelector("fieldset")?.disabled).toBe(false);
        await act(async () => server?.click());
        expect(server?.checked).toBe(true);
        expect(view.host.textContent).toContain("Server address");
      } finally {
        await view.cleanup();
      }
    },
  );
});
