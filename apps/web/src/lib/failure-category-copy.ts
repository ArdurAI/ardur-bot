import type { FailureCategoryId } from "@ardurbot/contracts";
import { msg } from "@lingui/core/macro";

/**
 * The web's translatable message for every entry of the failure-category table
 * (packages/contracts/src/failure-categories.ts). The catalog test pins each descriptor's
 * source message to the table's sentence, so a category added to the table fails the test
 * until its web message exists here.
 */
export const failureCategoryMessages: Record<FailureCategoryId, ReturnType<typeof msg>> = {
  "usage-limit": msg`{runtime}'s usage limit is reached. Try again after it resets.`,
  "signed-out": msg`Sign in to {runtime} on this computer, then try again.`,
  "max-turns": msg`{runtime} reached this run's turn limit. Narrow the task and try again.`,
  "model-unavailable": msg`{runtime}'s pinned model is unavailable. Change the pin and try again.`,
  "configuration-invalid": msg`{runtime}'s configuration is invalid. Check this bot's settings.`,
  "connection-missing": msg`{runtime}'s model connection is missing. Connect it or change the pin.`,
  "experimental-off": msg`{runtime} is experimental. Turn on Experimental for {bot} to use it.`,
  "computer-unsupported": msg`{runtime} runs on the host computer, not in a sandbox. Change {bot}'s computer to use it.`,
  "destinations-bot": msg`{bot}'s allowed model destinations block this model. Change them in {bot}'s settings.`,
  "destinations-space": msg`This space's model policy blocks this model. Change it in Settings, under Models.`,
  stopped: msg`{runtime} stopped before finishing this run.`,
  "model-context-too-small": msg`{runtime} needs a model with at least 64K context; change the model and try again.`,
  "session-start-failed": msg`{runtime} could not start a session. Check the runtime and try again.`,
  "runtime-tool-catalog-mismatch": msg`{runtime}'s tool list changed during startup. Check the connected tools and try again.`,
  "runtime-profile-unacknowledged": msg`{runtime}'s settings were not confirmed. Check this bot's settings and try again.`,
  "provider-request-too-large": msg`{runtime}'s model request was too large. Narrow the task and try again.`,
  "provider-response-too-large": msg`{runtime}'s model response was too large. Narrow the task and try again.`,
  "provider-grant-refused": msg`{runtime}'s model request was outside this run's allowance. Narrow the task and try again.`,
  "provider-auth-failed": msg`{runtime}'s model provider rejected the connection key. Check it in Settings, under Models.`,
  "provider-request-failed": msg`{runtime}'s model request failed. Check the connection in Settings, under Models, and try again.`,
  other: msg`{runtime} could not finish this run. Check the runtime or change the pin.`,
};

/** Stands in a sentence for a runtime whose name is not known. */
export const unknownRuntimeName = msg`This runtime`;

/** Handoff-context sentences for the entries the table gives a member line. */
export const failureCategoryMemberMessages: Partial<
  Record<FailureCategoryId, ReturnType<typeof msg>>
> = {
  stopped: msg`{member} stopped.`,
  other: msg`{member} failed.`,
};
