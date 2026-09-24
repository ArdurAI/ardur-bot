import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import { IntegrationCatalogListSchema } from "@ardurbot/contracts";

export async function loadIntegrationCatalog(request: (procedure: string) => Promise<unknown>) {
  return IntegrationCatalogListSchema.parse(await request("integrations/list"));
}

export function integrationCardMessage(
  descriptor: IntegrationDescriptor,
  connection?: IntegrationConnection,
): string {
  if (!descriptor.available) return "Coming soon";
  if (
    descriptor.id === "github" &&
    (!connection || ["not-connected", "needs-client-registration"].includes(connection.state))
  )
    return "Sign-in needs a pre-registered app; use a fine-grained token instead.";
  switch (connection?.state) {
    case "connected":
      return connection.needsReview
        ? "Review tools before your bots can use this account."
        : "Your account is connected.";
    case "awaiting-consent":
      return "Finish signing in in your browser.";
    case "discovery-failed":
      return "Could not load this account’s tools.";
    case "cancelled":
      return "The connection was cancelled.";
    case "needs-client-registration":
      return "This service needs client registration before you can connect.";
    default:
      return "Connect your account.";
  }
}
