import type { ModelCredential } from "@ardurbot/contracts";

/** Why a connection cannot back Hermes; each maps to one owner-facing sentence. */
export type HermesConnectionRefusal = "claude-subscription" | "chatgpt-sign-in" | "sign-in";

const HERMES_PASSTHROUGH_PROVIDERS = new Set(["openai-compatible", "ollama"]);
const CHATGPT_SIGN_IN_PROVIDER = "openai-codex";

/**
 * Client-side mirror of the worker's Hermes sign-in rules, so a picker can
 * disable an incompatible connection with the same reason the save would give.
 * Custom endpoints and every key-based catalog connection are served (the
 * worker translates them through Ardur's provider layer); only subscription
 * sign-ins are refused. The worker's hermesCompatibility stays the authority.
 */
export function hermesConnectionRefusal(
  provider: string | null | undefined,
  credential?: Pick<ModelCredential, "oauth" | "connectionIssue"> | null,
): HermesConnectionRefusal | undefined {
  if (!provider || HERMES_PASSTHROUGH_PROVIDERS.has(provider)) return undefined;
  if (provider === CHATGPT_SIGN_IN_PROVIDER) return "chatgpt-sign-in";
  if (provider === "anthropic" && credential?.connectionIssue === "api-key-required")
    return "claude-subscription";
  if (credential?.oauth) return provider === "anthropic" ? "claude-subscription" : "sign-in";
  return undefined;
}
