export const SETUP_ERROR_ACCOUNT = "Could not load setup.";
export const SETUP_ERROR_MODELS = "Could not load models.";

export type SetupError = typeof SETUP_ERROR_ACCOUNT | typeof SETUP_ERROR_MODELS;

/** What the setup screen is showing. Opening chat is never a ready screen. */
export type SetupObservation = {
  url: string;
  composerVisible: boolean;
  composerEnabled: boolean;
  modelHeading: boolean;
  integrationsHeading: boolean;
  setupError: SetupError | null;
  existingAccount: boolean;
  signInHeading: boolean;
  openingChat: boolean;
};

export type SetupProgress = {
  skipped: boolean;
  retried: boolean;
  signedIn: boolean;
};

export type SetupAction =
  | { type: "ready" }
  | { type: "blocked"; message: string }
  | { type: "skip-integrations" }
  | { type: "retry-setup" }
  | { type: "sign-in" }
  | { type: "wait" };

const CHAT_PATH = /\/app\/[^/?#]+/;

export function isUsableChat(observation: SetupObservation): boolean {
  // Navigation can commit /app before the shell mounts the composer. A visible
  // but disabled composer, or the transient "Opening chat…" line, is not ready.
  return (
    CHAT_PATH.test(observation.url) && observation.composerVisible && observation.composerEnabled
  );
}

export function nextSetupAction(
  observation: SetupObservation,
  progress: SetupProgress,
): SetupAction {
  if (isUsableChat(observation)) return { type: "ready" };
  if (observation.setupError && !progress.retried) return { type: "retry-setup" };
  if ((observation.existingAccount || observation.signInHeading) && !progress.signedIn) {
    return { type: "sign-in" };
  }
  if (observation.integrationsHeading && !progress.skipped) return { type: "skip-integrations" };
  if (observation.modelHeading) {
    return {
      type: "blocked",
      message: "Setup is on Connect a model. The chat composer is not usable.",
    };
  }
  return { type: "wait" };
}

export function describeSetupScreen(observation: SetupObservation): string {
  if (observation.setupError) return observation.setupError;
  if (observation.existingAccount || observation.signInHeading) return "an existing account";
  if (observation.modelHeading) return "Connect a model";
  if (observation.integrationsHeading) return "Server integrations";
  if (observation.openingChat) return "Opening chat…";
  if (observation.composerVisible && !observation.composerEnabled)
    return "a disabled chat composer";
  return "an unfinished setup screen";
}

export function setupDeadlineMessage(
  deadlineMs: number,
  last: SetupObservation | undefined,
): string {
  const seen = last ? describeSetupScreen(last) : "no setup screen";
  return `Setup did not become usable within ${deadlineMs}ms. Waited for the chat composer (combobox Message <bot>) to be visible and enabled. Last screen: ${seen}.`;
}

export async function finishSetup(deps: {
  now: () => number;
  deadlineAt: number;
  deadlineMs: number;
  observe: () => Promise<SetupObservation>;
  skipIntegrations: () => Promise<void>;
  retrySetup: () => Promise<void>;
  signInExisting: () => Promise<void>;
  waitForChange: (remainingMs: number, observation: SetupObservation) => Promise<void>;
}): Promise<void> {
  const progress: SetupProgress = { skipped: false, retried: false, signedIn: false };
  let last: SetupObservation | undefined;
  for (;;) {
    if (deps.now() >= deps.deadlineAt) {
      throw new Error(setupDeadlineMessage(deps.deadlineMs, last));
    }
    last = await deps.observe();
    const action = nextSetupAction(last, progress);
    if (action.type === "ready") return;
    if (action.type === "blocked") throw new Error(action.message);
    if (action.type === "skip-integrations") {
      await deps.skipIntegrations();
      progress.skipped = true;
      continue;
    }
    if (action.type === "retry-setup") {
      await deps.retrySetup();
      progress.retried = true;
      continue;
    }
    if (action.type === "sign-in") {
      await deps.signInExisting();
      progress.signedIn = true;
      continue;
    }
    const remaining = deps.deadlineAt - deps.now();
    if (remaining <= 0) throw new Error(setupDeadlineMessage(deps.deadlineMs, last));
    await deps.waitForChange(remaining, last);
  }
}
