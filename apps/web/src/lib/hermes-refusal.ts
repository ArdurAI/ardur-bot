import type { HermesConnectionRefusal } from "@ardurbot/core";
import { t } from "@lingui/core/macro";

const HERMES_REFUSAL_MESSAGES: Record<HermesConnectionRefusal, () => string> = {
  "claude-subscription": () =>
    t`Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes.`,
  "chatgpt-sign-in": () =>
    t`ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.`,
  "sign-in": () => t`Add an API key connection to use this provider with Hermes.`,
};

/** The owner-facing reason a connection cannot back Hermes; one plain sentence with an action. */
export function hermesRefusalMessage(refusal: HermesConnectionRefusal): string {
  return HERMES_REFUSAL_MESSAGES[refusal]();
}
