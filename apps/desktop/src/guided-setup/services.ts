import type { LocalModeController } from "../local-mode.js";
import type { SetupStep, StepVerification } from "./engine.js";
import { SetupStepFailure } from "./engine.js";

export interface ServiceStepDependencies {
  localMode: Pick<LocalModeController, "servicesReady" | "startServices" | "stop">;
  dataFolderFingerprint: string;
  now(): number;
  stopTimeoutMs?: number;
}

/** A ready receipt names only the folder fingerprint; no local path crosses IPC or disk. */
export function serviceGuidedStep(deps: ServiceStepDependencies): SetupStep {
  let startedHere = false;
  let startedRunId: string | null = null;
  const check = async (signal: AbortSignal): Promise<StepVerification> =>
    (await deps.localMode.servicesReady(signal))
      ? {
          kind: "satisfied",
          checkedAt: deps.now(),
          evidence: `services:${deps.dataFolderFingerprint}`,
        }
      : { kind: "needed", reasonCode: "services-not-ready" };
  return {
    id: "services",
    revision: 1,
    requires: ["migrations"],
    canSkip: false,
    waitForInput: true,
    check: (context, signal) => {
      if (startedRunId !== context.runId) startedHere = false;
      return check(signal);
    },
    run: async (context, signal) => {
      startedHere = true;
      startedRunId = context.runId;
      const state = await deps.localMode.startServices(signal);
      if (state.phase !== "ready") throw new SetupStepFailure("services-not-ready");
      return { kind: "owned", proof: `services:${deps.dataFolderFingerprint}` };
    },
    verify: async (_, _receipt, signal) => {
      const result = await check(signal);
      return result.kind === "satisfied"
        ? result
        : { kind: "blocked", reasonCode: "services-not-ready" };
    },
    cancel: async () => {
      if (!startedHere) return;
      const timeout = deps.stopTimeoutMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.localMode.stop(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("stop-timeout")), timeout);
          }),
        ]);
        startedHere = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
