export const SETUP_ERROR_ACCOUNT = "Could not load setup.";
export const SETUP_ERROR_MODELS = "Could not load models.";

export type SetupError = typeof SETUP_ERROR_ACCOUNT | typeof SETUP_ERROR_MODELS;

/** What the setup screen is showing. Opening chat is never a ready screen. */
export type SetupObservation = {
  url: string;
  composerVisible: boolean;
  composerEnabled: boolean;
  composerFocused: boolean;
  composerBot?: string | null;
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

export function isUsableChat(observation: SetupObservation, expectedBot = "Chief"): boolean {
  // Navigation can commit /app before the shell mounts the composer. A visible
  // but disabled or unfocused composer, a composer for another bot, or the
  // transient "Opening chat…" line, is not ready.
  return (
    CHAT_PATH.test(observation.url) &&
    observation.composerVisible &&
    observation.composerEnabled &&
    observation.composerFocused &&
    (observation.composerBot == null || observation.composerBot === expectedBot)
  );
}

export function nextSetupAction(
  observation: SetupObservation,
  progress: SetupProgress,
  expectedBot = "Chief",
): SetupAction {
  if (isUsableChat(observation, expectedBot)) return { type: "ready" };
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

export function describeSetupScreen(observation: SetupObservation, expectedBot = "Chief"): string {
  if (observation.setupError) return observation.setupError;
  if (observation.existingAccount || observation.signInHeading) return "an existing account";
  if (observation.modelHeading) return "Connect a model";
  if (observation.integrationsHeading) return "Server integrations";
  if (observation.openingChat) return "Opening chat…";
  if (observation.composerVisible && !observation.composerEnabled)
    return "a disabled chat composer";
  if (observation.composerVisible && !observation.composerFocused)
    return "an unfocused chat composer";
  if (
    observation.composerVisible &&
    observation.composerBot &&
    observation.composerBot !== expectedBot
  ) {
    return `chat with ${observation.composerBot}`;
  }
  return "an unfinished setup screen";
}

export function setupDeadlineMessage(
  deadlineMs: number,
  last: SetupObservation | undefined,
  expectedBot = "<bot>",
): string {
  const seen = last ? describeSetupScreen(last, expectedBot) : "no setup screen";
  return `Setup did not become usable within ${deadlineMs}ms. Waited for the chat composer (combobox Message ${expectedBot}) to be visible and enabled. Last screen: ${seen}.`;
}

async function runWithBudget<T>(
  action: (budget: number) => Promise<T>,
  remaining: () => number,
  onTimeout: () => Error,
): Promise<T> {
  const budget = remaining();
  if (budget <= 0) throw onTimeout();
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), Math.max(0, budget));
  });
  try {
    return await Promise.race([action(budget), timeoutPromise]);
  } catch (error) {
    if (remaining() <= 0) throw onTimeout();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function finishSetup(deps: {
  now: () => number;
  deadlineAt: number;
  deadlineMs: number;
  expectedBot?: string;
  observe: (timeoutMs: number) => Promise<SetupObservation>;
  skipIntegrations: (timeoutMs: number) => Promise<void>;
  retrySetup: (timeoutMs: number) => Promise<void>;
  signInExisting: (timeoutMs: number) => Promise<void>;
  waitForChange: (remainingMs: number, observation: SetupObservation) => Promise<void>;
}): Promise<void> {
  const expectedBot = deps.expectedBot ?? "Chief";
  const progress: SetupProgress = { skipped: false, retried: false, signedIn: false };
  let last: SetupObservation | undefined;
  const remaining = () => deps.deadlineAt - deps.now();
  const deadlineError = () =>
    new Error(setupDeadlineMessage(deps.deadlineMs, last, deps.expectedBot));

  for (;;) {
    last = await runWithBudget((b) => deps.observe(b), remaining, deadlineError);
    if (remaining() <= 0) throw deadlineError();
    const action = nextSetupAction(last, progress, expectedBot);
    if (action.type === "ready") return;
    if (action.type === "blocked") throw new Error(action.message);
    if (action.type === "skip-integrations") {
      await runWithBudget((b) => deps.skipIntegrations(b), remaining, deadlineError);
      if (remaining() <= 0) throw deadlineError();
      progress.skipped = true;
      continue;
    }
    if (action.type === "retry-setup") {
      await runWithBudget((b) => deps.retrySetup(b), remaining, deadlineError);
      if (remaining() <= 0) throw deadlineError();
      progress.retried = true;
      continue;
    }
    if (action.type === "sign-in") {
      await runWithBudget((b) => deps.signInExisting(b), remaining, deadlineError);
      if (remaining() <= 0) throw deadlineError();
      progress.signedIn = true;
      continue;
    }
    await runWithBudget((b) => deps.waitForChange(b, last!), remaining, deadlineError);
    if (remaining() <= 0) throw deadlineError();
  }
}
