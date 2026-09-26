import { t } from "@lingui/core/macro";

const NEEDS_SIGN_IN = /^Needs sign-in(?: \(([a-z_]+)\))?\.$/;

/**
 * What a stored "Needs sign-in (<code>)." diagnostic means, or null for any other text.
 * `credential` is true when the fix is a new token or header in MCP settings, and false
 * when it is a browser sign-in. The code itself is never shown.
 */
export function mcpSignIn(
  recorded: string | null | undefined,
): { sentence: string; credential: boolean } | null {
  const match = recorded?.trim().match(NEEDS_SIGN_IN);
  if (!match) return null;
  const credential = match[1] === "credential_rejected" || match[1] === "oauth_unavailable";
  switch (match[1]) {
    case "credential_rejected":
      return { sentence: t`That token was not accepted. Check it and try again.`, credential };
    case "oauth_unavailable":
      return {
        sentence: t`This server did not offer browser sign-in. Enter a token instead.`,
        credential,
      };
    case "invalid_token":
      return { sentence: t`The saved sign-in is no longer accepted. Sign in again.`, credential };
    case "refresh_unavailable":
      return { sentence: t`The saved sign-in expired. Sign in again.`, credential };
    default:
      return { sentence: t`Sign-in is needed. Connect again.`, credential };
  }
}

/** A recorded failure as a person reads it: the sign-in sentence, or the stored sentence. */
export function mcpFailureSentence(recorded: string | null | undefined): string | null {
  return mcpSignIn(recorded)?.sentence ?? (recorded?.trim() || null);
}

/**
 * The one sentence every surface shows for a sign-in that did not connect. `recorded` is
 * the server's lastError, read after the attempt ended.
 */
export function mcpOutcomeSentence(
  outcome: string,
  cancelledByPerson: boolean,
  recorded?: string | null,
): string {
  switch (outcome) {
    case "cancelled":
      return cancelledByPerson ? t`Sign-in was cancelled.` : t`Sign-in was declined.`;
    case "needs-sign-in":
      return t`Sign-in did not finish. Try again.`;
    case "replaced":
      return t`This sign-in window was replaced by a newer one. Finish signing in there, or start again.`;
    case "oauth-unavailable":
    case "needs-credential":
      return t`This server did not offer browser sign-in. Enter a token instead.`;
    case "credential-rejected":
      return t`That token was not accepted. Check it and try again.`;
    default:
      return mcpFailureSentence(recorded) ?? t`Could not load this account’s tools.`;
  }
}
