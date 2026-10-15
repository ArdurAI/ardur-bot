import { msg } from "@lingui/core/macro";

/**
 * Phone-only signing-key dialog text. The phone reads these from the shared
 * catalogs, so static definitions keep them in every web catalog extract.
 */
export const replaceKeyTitle = msg`Replace key?`;
export const replaceKeyBody = msg`Runs already admitted keep their key; new runs sign with the new key.`;
