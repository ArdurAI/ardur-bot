import type { HermesConnectionRefusal } from "@ardurbot/core";

/**
 * The owner-facing reason a connection cannot back Hermes; one plain sentence
 * with an action. Shared by the bot settings and group member model pickers.
 */
export function hermesRefusalMessage(
  refusal: HermesConnectionRefusal,
  t: (message: string) => string,
): string {
  const messages: Record<HermesConnectionRefusal, string> = {
    "claude-subscription": t(
      "Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes.",
    ),
    "chatgpt-sign-in": t(
      "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
    ),
    "sign-in": t("Add an API key connection to use this provider with Hermes."),
  };
  return messages[refusal];
}
