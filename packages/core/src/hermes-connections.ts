import type { ModelCredential } from "@ardurbot/contracts";

/** Why a connection cannot back Hermes; each maps to one owner-facing sentence. */
export type HermesConnectionRefusal = "claude-subscription" | "chatgpt-sign-in" | "sign-in";

/** Generic reason a connection is refused, independent of vendor or Hermes wording. */
export type ConnectionRefusalKind =
  /** A sign-in the vendor only allows inside its own apps or tools. */
  | "vendor-app-only"
  /** The provider needs an API key connection here. */
  | "api-key-required";

type HermesCredentialHint = Pick<ModelCredential, "oauth" | "connectionIssue">;

/** Which credential state a sign-in refusal rule matches. */
type HermesSignInCredential = "any" | "oauth" | "api-key-required";

type HermesSignInRefusalRule = {
  /** Refusal id returned when the rule matches; the first matching row wins. */
  refusal: HermesConnectionRefusal;
  /** Restricts the rule to one provider; omitted matches every provider. */
  provider?: string;
  /** Credential state the rule needs; "any" fires without a credential. */
  credential: HermesSignInCredential;
  /** Generic reason kind carried by the refusal when this rule matches. */
  kind: ConnectionRefusalKind;
};

/**
 * The whole Hermes connection policy in one table: adding a pass-through
 * provider, a sign-in refusal rule, or a refusal id means adding ONE row here.
 * The client mirror below and the worker's hermesCompatibility both read it.
 */
export const HERMES_CONNECTION_POLICY: {
  /** Providers Hermes calls directly: Chat Completions against their baseUrl. */
  passThroughProviders: readonly string[];
  /** Sign-in (OAuth/subscription) conditions that can never back Hermes. */
  signInRefusals: readonly HermesSignInRefusalRule[];
  /** The English source sentence for each refusal id. */
  refusalSentences: Record<HermesConnectionRefusal, string>;
} = {
  passThroughProviders: ["openai-compatible", "ollama"],
  signInRefusals: [
    // ChatGPT sign-ins have no API-key form, so the provider alone decides.
    {
      refusal: "chatgpt-sign-in",
      provider: "openai-codex",
      credential: "any",
      kind: "vendor-app-only",
    },
    // Anthropic legacy OAuth secrets surface through the connection-issue marker.
    {
      refusal: "claude-subscription",
      provider: "anthropic",
      credential: "api-key-required",
      kind: "vendor-app-only",
    },
    {
      refusal: "claude-subscription",
      provider: "anthropic",
      credential: "oauth",
      kind: "vendor-app-only",
    },
    { refusal: "sign-in", credential: "oauth", kind: "api-key-required" },
  ],
  refusalSentences: {
    "claude-subscription":
      "Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes.",
    "chatgpt-sign-in":
      "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
    "sign-in": "Add an API key connection to use this provider with Hermes.",
  },
};

/** True when Hermes talks to the provider's own endpoint without translation. */
export function isHermesPassThroughProvider(provider: string): boolean {
  return HERMES_CONNECTION_POLICY.passThroughProviders.includes(provider);
}

function hermesSignInCredentialMatches(
  condition: HermesSignInCredential,
  credential: HermesCredentialHint | null | undefined,
): boolean {
  if (condition === "any") return true;
  if (condition === "oauth") return credential?.oauth === true;
  return credential?.connectionIssue === "api-key-required";
}

function matchingRefusalRule(
  provider: string | null | undefined,
  credential?: HermesCredentialHint | null,
): HermesSignInRefusalRule | undefined {
  if (!provider || isHermesPassThroughProvider(provider)) return undefined;
  for (const rule of HERMES_CONNECTION_POLICY.signInRefusals) {
    if (rule.provider && rule.provider !== provider) continue;
    if (hermesSignInCredentialMatches(rule.credential, credential)) return rule;
  }
  return undefined;
}

/**
 * The single Hermes connection decision, driven by HERMES_CONNECTION_POLICY.
 * Pickers mirror it to disable an incompatible connection with the same reason
 * the save would give; the worker's hermesCompatibility calls it too and stays
 * the authority. Custom endpoints and every key-based catalog connection are
 * served (the worker translates them through Ardur's provider layer); only
 * subscription sign-ins are refused.
 */
export function hermesConnectionRefusal(
  provider: string | null | undefined,
  credential?: HermesCredentialHint | null,
): HermesConnectionRefusal | undefined {
  return matchingRefusalRule(provider, credential)?.refusal;
}

/**
 * The generic reason kind behind hermesConnectionRefusal, from the same single
 * walk; undefined whenever the connection is not refused.
 */
export function hermesConnectionRefusalKind(
  provider: string | null | undefined,
  credential?: HermesCredentialHint | null,
): ConnectionRefusalKind | undefined {
  return matchingRefusalRule(provider, credential)?.kind;
}
