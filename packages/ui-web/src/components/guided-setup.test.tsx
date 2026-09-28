// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupSnapshot, SetupStepId } from "../../../contracts/src/desktop-setup.js";
import { formatSetupDuration, GuidedSetupView } from "./guided-setup.js";

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
function fixture(
  status: "pending" | "failed" | "running" | "waiting-input" = "pending",
): SetupSnapshot {
  return {
    schemaVersion: 1,
    planVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    mode: "local",
    currentStep: status === "pending" ? null : "database",
    machineReady: false,
    accountReady: false,
    complete: false,
    interrupted: false,
    blocked: false,
    steps: ids.map((id, index) => ({
      id,
      available: index < 4,
      revision: index < 4 ? 1 : 0,
      attempt: index === 1 && status !== "pending" ? 2 : 0,
      status: index === 1 ? status : "pending",
      activeElapsedMs: index === 1 ? 19_800 : 0,
      waitingElapsedMs: 0,
      verifiedAt: null,
      reasonCode: index === 1 && status === "failed" ? "setup-step-failed" : null,
      details:
        index === 1 && status !== "pending" ? [{ code: "safe", text: "Safe diagnostic" }] : [],
    })),
  };
}

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const actions = {
    onStart: vi.fn(),
    onRetry: vi.fn(),
    onSkip: vi.fn(),
    onCancel: vi.fn(),
    onResume: vi.fn(),
    onCopyDetails: vi.fn(async () => true),
  };
  return {
    host,
    root,
    actions,
    render: async (value: SetupSnapshot, labels?: Partial<Record<SetupStepId, string>>) => {
      await act(async () =>
        root.render(<GuidedSetupView snapshot={value} labels={labels} {...actions} />),
      );
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("GuidedSetupView", () => {
  it("omits the startup choice on unsupported platforms", async () => {
    const view = mount();
    try {
      const snapshot = fixture("waiting-input");
      snapshot.currentStep = "services";
      snapshot.steps[1]!.status = "succeeded";
      snapshot.steps[4]!.available = true;
      snapshot.steps[4]!.status = "waiting-input";
      await act(async () =>
        view.root.render(
          <GuidedSetupView snapshot={snapshot} startupSupported={false} {...view.actions} />,
        ),
      );
      expect(view.host.querySelector('input[type="checkbox"]')).toBeNull();
      await act(async () =>
        view.root.render(
          <GuidedSetupView snapshot={snapshot} startupSupported {...view.actions} />,
        ),
      );
      expect(view.host.querySelector('input[type="checkbox"]')).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });
  it("shows nine ordered rows and keeps future work unavailable", async () => {
    const view = mount();
    try {
      await view.render(fixture());
      expect(view.host.querySelectorAll("ol > li")).toHaveLength(9);
      expect(view.host.textContent).toContain("Start Ardur servicesUnavailable");
      expect(view.host.querySelector("button")?.textContent).toBe("Start setup");
      await act(async () => view.host.querySelector("button")?.click());
      expect(view.actions.onStart).toHaveBeenCalledOnce();
    } finally {
      await view.cleanup();
    }
  });

  it("focuses the failed action once and announces only a state transition", async () => {
    const view = mount();
    try {
      await view.render(fixture("failed"));
      expect(view.host.querySelector('[aria-current="step"]')).not.toBeNull();
      expect(document.activeElement?.textContent).toBe("Retry");
      expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toBe(
        "Prepare local storage, Failed",
      );
      await act(async () => (document.activeElement as HTMLButtonElement).click());
      expect(view.actions.onRetry).toHaveBeenCalledWith("database");
      const announcement = view.host.querySelector('[aria-live="polite"]')?.textContent;
      await view.render({ ...fixture("failed"), sequence: 2 });
      expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toBe(announcement);
    } finally {
      await view.cleanup();
    }
  });

  it("discloses selectable details and reports copy results", async () => {
    const view = mount();
    try {
      await view.render(fixture("waiting-input"));
      const button = [...view.host.querySelectorAll("button")].find(
        (item) => item.textContent === "Show details",
      )!;
      await act(async () => button.click());
      expect(view.host.querySelector("textarea")?.value).toContain("Attempt 2");
      await act(async () =>
        [...view.host.querySelectorAll("button")]
          .find((item) => item.textContent === "Copy details")
          ?.click(),
      );
      expect(view.actions.onCopyDetails).toHaveBeenCalledWith("Attempt 2\nSafe diagnostic");
      expect(view.host.textContent).toContain("Details copied");
    } finally {
      await view.cleanup();
    }
  });

  it("keeps completed rows collapsed with a keyboard-reachable disclosure", async () => {
    const view = mount();
    try {
      const snapshot = fixture("running");
      snapshot.currentStep = null;
      snapshot.steps[1]!.status = "succeeded";
      await view.render(snapshot);
      expect(view.host.querySelector("textarea")).toBeNull();
      const disclosure = [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Show details",
      )!;
      disclosure.focus();
      expect(document.activeElement).toBe(disclosure);
      await act(async () => disclosure.click());
      expect(view.host.querySelector("textarea")?.value).toContain("Safe diagnostic");
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await view.cleanup();
    }
  });

  it("explains a newer journal without offering a retry the engine refuses", async () => {
    const view = mount();
    try {
      const snapshot = fixture();
      snapshot.blocked = true;
      snapshot.steps[0]!.status = "failed";
      snapshot.steps[0]!.reasonCode = "newer-journal";
      await view.render(snapshot);
      expect(view.host.textContent).toContain("Setup was saved by a newer version of Ardur.");
      expect(
        [...view.host.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
      ).toBe(false);
      expect(view.host.textContent).toContain("Close");
    } finally {
      await view.cleanup();
    }
  });

  it("offers Start after cancellation so saved progress can be checked again", async () => {
    const view = mount();
    try {
      const snapshot = fixture("waiting-input");
      snapshot.currentStep = null;
      snapshot.steps[1]!.status = "cancelled";
      await view.render(snapshot);
      const start = [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Start setup",
      );
      expect(start).toBeDefined();
      await act(async () => start?.click());
      expect(view.actions.onStart).toHaveBeenCalledOnce();
    } finally {
      await view.cleanup();
    }
  });

  it.each(["command-collision", "setup-step-failed"])(
    "lets a failed optional command (%s) be skipped without promising a location control",
    async (reasonCode) => {
      const view = mount();
      try {
        const snapshot = fixture("failed");
        snapshot.currentStep = "command";
        snapshot.steps[1]!.status = "succeeded";
        snapshot.steps[3]!.status = "failed";
        snapshot.steps[3]!.attempt = 1;
        snapshot.steps[3]!.reasonCode = reasonCode;
        if (reasonCode === "command-collision") {
          snapshot.steps[3]!.details = [
            {
              code: "command-collision",
              text: "Another app owns the ardur command. Skip this step, or remove or rename that command and retry.",
            },
          ];
        }
        await view.render(snapshot);
        expect(view.host.textContent).not.toContain("Choose another location.");
        if (reasonCode === "command-collision") {
          const commandRow = [...view.host.querySelectorAll("ol > li")].find((row) =>
            row.textContent?.includes("Add the terminal command"),
          );
          const disclosure = [...(commandRow?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Show details",
          );
          expect(disclosure).toBeDefined();
          await act(async () => disclosure?.click());
          expect(
            view.host.querySelector<HTMLTextAreaElement>("#guided-details-command textarea")?.value,
          ).toBe(
            "Another app owns the ardur command. Skip this step, or remove or rename that command and retry.",
          );
        }
        const skip = [...view.host.querySelectorAll("button")].find(
          (button) => button.textContent === "Skip",
        );
        expect(skip).toBeDefined();
        await act(async () => skip?.click());
        expect(view.actions.onSkip).toHaveBeenCalledWith("command");
      } finally {
        await view.cleanup();
      }
    },
  );

  it("offers Retry stop before Resume when reopened cleanup is incomplete", async () => {
    const view = mount();
    try {
      const snapshot = fixture("failed");
      snapshot.interrupted = true;
      snapshot.blocked = true;
      snapshot.steps[1]!.reasonCode = "cleanup-incomplete";
      await view.render(snapshot);
      const actions = [...view.host.querySelectorAll<HTMLButtonElement>(".guided-actions button")];
      expect(actions.map((button) => button.textContent)).toEqual(["Retry stop"]);
      await act(async () => actions[0]?.click());
      expect(view.actions.onCancel).toHaveBeenCalledOnce();
      expect(view.actions.onResume).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it("renders measured durations without announcing timer ticks", async () => {
    vi.useFakeTimers();
    const view = mount();
    try {
      await view.render(fixture("running"));
      const announcement = view.host.querySelector('[aria-live="polite"]')?.textContent;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(view.host.textContent).toContain("20.8 s");
      expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toBe(announcement);
      expect(formatSetupDuration(26)).toBe("26 ms");
      expect(formatSetupDuration(64_000)).toBe("1 min 4 s");
    } finally {
      await view.cleanup();
    }
  });

  it("keeps long labels within a semantic row", async () => {
    const view = mount();
    try {
      const long = "Storage ".repeat(40);
      await view.render(fixture(), { prerequisites: long });
      const label = view.host.querySelector(".guided-step-name")!;
      expect(label.closest("li")).not.toBeNull();
      expect(label.textContent).toBe(long);
      expect(view.host.querySelectorAll("[aria-current]")).toHaveLength(0);
    } finally {
      await view.cleanup();
    }
  });
});
