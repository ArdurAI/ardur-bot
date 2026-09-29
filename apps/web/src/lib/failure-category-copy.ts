import type { FailureCategoryId } from "@ardurbot/contracts";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * The web's translatable message for every entry of the failure-category table
 * (packages/contracts/src/failure-categories.ts). The catalog test pins each descriptor's
 * source message to the table's sentence, so a category added to the table fails the test
 * until its web message exists here.
 */
export const failureCategoryMessages: Record<FailureCategoryId, MessageDescriptor> = {
  "usage-limit": msg`{runtime}'s usage limit is reached. Try again after it resets.`,
  "signed-out": msg`Sign in to {runtime} on this computer, then try again.`,
  "max-turns": msg`{runtime} reached this run's turn limit. Narrow the task and try again.`,
  "model-unavailable": msg`{runtime}'s pinned model is unavailable. Change the pin and try again.`,
  "configuration-invalid": msg`{runtime}'s configuration is invalid. Check this bot's settings.`,
  "connection-missing": msg`{runtime}'s model connection is missing. Connect it or change the pin.`,
  stopped: msg`{runtime} stopped before finishing this run.`,
  other: msg`{runtime} could not finish this run. Check the runtime or change the pin.`,
};

/** Handoff-context sentences for the entries the table gives a member line. */
export const failureCategoryMemberMessages: Partial<
  Record<FailureCategoryId, MessageDescriptor>
> = {
  stopped: msg`{member} stopped.`,
  other: msg`{member} failed.`,
};
