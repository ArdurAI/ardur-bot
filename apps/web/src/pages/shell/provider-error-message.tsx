import type {
  FailureCategoryId,
  ModelCatalogEntry,
  ProviderErrorKind,
  RuntimeProblem,
} from "@ardurbot/contracts";
import {
  FailureCategoryIdSchema,
  failureCategory,
  failureCategoryFromText,
  RUN_STALLED_MESSAGE,
  runtimeNames,
} from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { failureCategoryMessages } from "../../lib/failure-category-copy";
import { parseProviderError } from "../../lib/provider-error";

/**
 * The refusal categories whose fix the banner can offer directly: each names the setting
 * that blocked the run, and its actions come from the failure-category table.
 */
const RUNTIME_REFUSAL_IDS: ReadonlySet<FailureCategoryId> = new Set([
  "experimental-off",
  "computer-unsupported",
  "destinations-bot",
  "destinations-space",
]);

export function ProviderErrorMessage({
  text,
  providerErrorKind,
  onChangeModel,
  onRetry,
  runtimeProblem,
  catalog,
  onConnect,
  botName,
  onEnableExperimental,
  onOpenBotDestinations,
  onOpenBotComputer,
  onOpenSpaceModels,
}: {
  text: string;
  providerErrorKind?: ProviderErrorKind;
  onChangeModel?: () => void;
  onRetry?: () => void;
  runtimeProblem?: RuntimeProblem;
  catalog?: ModelCatalogEntry[];
  onConnect?: () => void;
  /** The refusing bot's name; the recorded sentence stands in when it is not known. */
  botName?: string;
  onEnableExperimental?: () => void;
  onOpenBotDestinations?: () => void;
  onOpenBotComputer?: () => void;
  onOpenSpaceModels?: () => void;
}) {
  const { t, i18n } = useLingui();
  if (text === RUN_STALLED_MESSAGE) {
    return (
      <>
        <span className="min-w-0 flex-1">
          <Trans>The bot stopped responding. Retry the run.</Trans>
        </span>
        {onRetry ? (
          <Button variant="link" size="xs" onClick={onRetry}>
            <Trans>Retry</Trans>
          </Button>
        ) : null}
      </>
    );
  }
  if (runtimeProblem) {
    // A classified runtime refusal shows its category's sentence — the setting that said
    // no, with this bot's and the runtime's names — plus one button per table action.
    const refusalId = FailureCategoryIdSchema.safeParse(runtimeProblem.reasonId);
    if (refusalId.success && RUNTIME_REFUSAL_IDS.has(refusalId.data)) {
      const entry = failureCategory(refusalId.data);
      const runtime = runtimeNames[runtimeProblem.pin.runtimeKind];
      const actions = [entry.action, ...(entry.more ?? [])];
      return (
        <>
          <span className="min-w-0 flex-1">
            {botName
              ? i18n._({
                  ...failureCategoryMessages[refusalId.data],
                  values: { runtime, bot: botName },
                })
              : runtimeProblem.reason}
          </span>
          {actions.map((action) => {
            if (action.kind === "enable-experimental")
              return onEnableExperimental ? (
                <Button
                  key="enable-experimental"
                  variant="link"
                  size="xs"
                  onClick={onEnableExperimental}
                >
                  <Trans>Turn on Experimental</Trans>
                </Button>
              ) : null;
            if (action.kind !== "open-settings") return null;
            if (action.target === "model-pin")
              return (
                <Button key="model-pin" variant="link" size="xs" onClick={onChangeModel}>
                  <Trans>Change pin</Trans>
                </Button>
              );
            if (action.target === "bot-destinations")
              return onOpenBotDestinations ? (
                <Button
                  key="bot-destinations"
                  variant="link"
                  size="xs"
                  onClick={onOpenBotDestinations}
                >
                  <Trans>Open bot settings</Trans>
                </Button>
              ) : null;
            if (action.target === "bot-computer")
              return onOpenBotComputer ? (
                <Button key="bot-computer" variant="link" size="xs" onClick={onOpenBotComputer}>
                  <Trans>Open bot settings</Trans>
                </Button>
              ) : null;
            return onOpenSpaceModels ? (
              <Button key="space-models" variant="link" size="xs" onClick={onOpenSpaceModels}>
                <Trans>Open Settings</Trans>
              </Button>
            ) : null;
          })}
        </>
      );
    }
    if (runtimeProblem.code === "locality-denied")
      return (
        <>
          <span className="min-w-0 flex-1">
            <Trans>This bot may only run locally — change the pin or the space policy</Trans>
          </span>
          <Button variant="link" size="xs" onClick={onChangeModel}>
            <Trans>Change pin</Trans>
          </Button>
        </>
      );
    const { pin } = runtimeProblem;
    const entry = catalog?.find(
      (item) => item.provider === pin.provider && item.id === pin.modelId,
    );
    const provider =
      entry?.providerName ??
      catalog?.find((item) => item.provider === pin.provider)?.providerName ??
      pin.provider ??
      "an unset provider";
    const model = entry?.label ?? pin.modelId ?? "an unset model";
    const effort = pin.effort ?? "an unset effort";
    const antigravityReason = (() => {
      if (pin.runtimeKind !== "antigravity") return null;
      switch (
        runtimeProblem.reasonId ??
        (runtimeProblem.code === "pin-model-unknown" ? "model-unrecognised" : undefined)
      ) {
        case "timeout":
          return t`Antigravity did not finish in time. Try again.`;
        case "catalogue-unavailable":
          return t`Antigravity's live model list could not be checked. Check again.`;
        case "version-too-old":
          return t`Update Antigravity to version 1.2.12 or later.`;
        case "model-unrecognised":
          return t`Antigravity did not recognise the model ${pin.modelId ?? ""}. Pick a model from its list.`;
        case "native-tool-attempted":
          return t`Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped.`;
        case "sign-in-unknown":
          return t`Sign-in unknown until the first run`;
        case "signed-out":
          return t`Sign in to Antigravity on this computer, then check again.`;
        case "image-unsupported":
          return t`Antigravity cannot use images yet. Remove the image and try again.`;
        case "comparison-unsupported":
          return t`Antigravity cannot run comparison turns yet. Choose another runtime.`;
        case "input-too-large":
          return t`Antigravity input is too large. Shorten the message or conversation and try again.`;
        case "not-installed":
          return t`Antigravity is not installed on this computer. Install it and sign in there, then check again.`;
        case "unavailable":
        case "version-unchecked":
        case "probe-failed":
        case "invalid-pin":
        case "effort-unsupported":
        case "tools-unsupported":
        case "resume-unsupported":
        case "host-directory-required":
        case "input-write-failed":
        case "stopped-early":
        case "runtime-error":
        case "invalid-response":
        case "text-too-large":
        case "empty-response":
          return t`Antigravity could not run this turn. Check the runtime and try again.`;
        default:
          return runtimeProblem.reason;
      }
    })();
    // Native runtime failures carry a classified reason id; older records hold the
    // category sentence, mapped back to its id. Either way the sentence comes from the
    // failure-category table, translated here. Anything unclassified keeps the recorded
    // reason — a missed variant degrades to the old behavior, never to a wrong category.
    const nativeReason = (() => {
      if (pin.runtimeKind === "antigravity" || pin.runtimeKind === "pi") return null;
      const runtime = runtimeNames[pin.runtimeKind];
      const byId = FailureCategoryIdSchema.safeParse(runtimeProblem.reasonId);
      if (byId.success)
        return i18n._({ ...failureCategoryMessages[byId.data], values: { runtime } });
      const legacy = failureCategoryFromText(runtimeProblem.reason, {
        runtimes: Object.values(runtimeNames),
      });
      if (legacy)
        return i18n._({
          ...failureCategoryMessages[legacy.id],
          values: { runtime: legacy.params.runtime ?? runtime },
        });
      return null;
    })();
    return (
      <>
        <span className="min-w-0 flex-1">
          {pin.runtimeKind !== "pi" || runtimeProblem.code !== "pin-credential-missing" ? (
            (antigravityReason ?? nativeReason ?? runtimeProblem.reason)
          ) : (
            <Trans>
              This bot is pinned to {provider} · {model} · {effort}; connect it or change the pin.
            </Trans>
          )}
        </span>
        {pin.runtimeKind === "pi" && runtimeProblem.code === "pin-credential-missing" ? (
          <Button variant="link" size="xs" className="text-destructive" onClick={onConnect}>
            <Trans>Connect</Trans>
          </Button>
        ) : null}
        <Button variant="link" size="xs" className="text-destructive" onClick={onChangeModel}>
          <Trans>Change pin</Trans>
        </Button>
      </>
    );
  }
  const error = parseProviderError(text, providerErrorKind);
  return (
    <>
      <span className="min-w-0 flex-1">{error.message}</span>
      {error.kind === "model-unavailable" && onChangeModel ? (
        <Button variant="link" size="xs" className="text-destructive" onClick={onChangeModel}>
          <Trans>Change model</Trans>
        </Button>
      ) : null}
    </>
  );
}
