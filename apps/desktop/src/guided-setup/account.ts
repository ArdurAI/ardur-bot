import type { SetupStep, StepVerification } from "./engine.js";
import type { GuidedAccountStatus } from "./readback.js";
import type { StepReceipt } from "./store.js";

export interface GuidedAccountBoundary {
  read(): Promise<GuidedAccountStatus | null>;
  target(): string | null;
  machineReady(signal: AbortSignal): Promise<boolean>;
  appMounted(): Promise<boolean>;
  now(): number;
}

function proof(target: string | null, scope: string | null) {
  return `${target ?? "no-target"}:${scope ?? "no-account"}`;
}

export function accountGuidedSteps(deps: GuidedAccountBoundary): SetupStep[] {
  const read = async () => {
    const account = await deps.read();
    return { account, proof: proof(deps.target(), account?.scope ?? null) };
  };
  const defer = async (): Promise<StepReceipt> => {
    const state = await read();
    return { kind: "owned", proof: `deferred:${state.proof}` };
  };
  const modelCheck = async (receipt?: StepReceipt | null): Promise<StepVerification> => {
    if (!deps.target()) return { kind: "needed", reasonCode: "account-handoff-needed" };
    const state = await read();
    if (receipt && receipt.proof !== state.proof && receipt.proof !== `deferred:${state.proof}`)
      return { kind: "needed", reasonCode: "account-scope-changed" };
    if (!state.account || state.account.model === "missing")
      return { kind: "needed", reasonCode: "model-not-saved" };
    return {
      kind: "satisfied",
      checkedAt: deps.now(),
      evidence: state.proof,
      details: [
        {
          code: state.account.model === "checked" ? "connection-checked" : "connection-saved",
          text: state.account.model === "checked" ? "Connection checked" : "Connection saved",
        },
      ],
    };
  };
  const botCheck = async (receipt?: StepReceipt | null): Promise<StepVerification> => {
    const state = await read();
    if (receipt && receipt.proof !== state.proof && receipt.proof !== `deferred:${state.proof}`)
      return { kind: "needed", reasonCode: "account-scope-changed" };
    if (state.account?.model === "missing" || !state.account)
      return { kind: "needed", reasonCode: "model-not-saved" };
    return state.account.firstBot
      ? { kind: "satisfied", checkedAt: deps.now(), evidence: state.proof }
      : { kind: "needed", reasonCode: "first-bot-not-created" };
  };
  const verifyFinish = async (signal: AbortSignal): Promise<StepVerification> => {
    if (!deps.target()) return { kind: "blocked", reasonCode: "target-not-saved" };
    if (!(await deps.machineReady(signal)))
      return { kind: "blocked", reasonCode: "services-not-ready" };
    if (!(await deps.appMounted())) return { kind: "blocked", reasonCode: "app-not-mounted" };
    return { kind: "satisfied", checkedAt: deps.now(), evidence: deps.target()! };
  };
  return [
    {
      id: "model",
      revision: 1,
      requires: ["engines"],
      canSkip: true,
      waitForInput: true,
      check: () => modelCheck(),
      recheck: (_context, _signal, receipt) => modelCheck(receipt),
      defer,
      run: async () => ({ kind: "verified", proof: (await read()).proof }),
      verify: () => modelCheck(),
      cancel: async () => undefined,
    },
    {
      id: "first-bot",
      revision: 1,
      requires: ["engines"],
      canSkip: true,
      waitForInput: true,
      check: () => botCheck(),
      recheck: (_context, _signal, receipt) => botCheck(receipt),
      defer,
      run: async () => ({ kind: "verified", proof: (await read()).proof }),
      verify: () => botCheck(),
      cancel: async () => undefined,
    },
    {
      id: "finish",
      revision: 1,
      requires: ["services", "engines"],
      canSkip: false,
      check: (_context, signal) => verifyFinish(signal),
      recheck: (_context, signal) => verifyFinish(signal),
      run: async () => ({ kind: "verified", proof: deps.target() ?? "no-target" }),
      verify: (_context, _receipt, signal) => verifyFinish(signal),
      cancel: async () => undefined,
    },
  ];
}
