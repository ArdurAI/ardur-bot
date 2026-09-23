import { waitForModelOAuthCompletion } from "@ardurbot/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@ardurbot/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@ardurbot/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
