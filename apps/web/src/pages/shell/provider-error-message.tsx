import type { ModelCatalogEntry, ProviderErrorKind, RuntimeProblem } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { parseProviderError } from "../../lib/provider-error";

export function ProviderErrorMessage({
  text,
  providerErrorKind,
  onChangeModel,
  runtimeProblem,
  catalog,
  onConnect,
}: {
  text: string;
  providerErrorKind?: ProviderErrorKind;
  onChangeModel?: () => void;
  runtimeProblem?: RuntimeProblem;
  catalog?: ModelCatalogEntry[];
  onConnect?: () => void;
}) {
  if (runtimeProblem) {
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
    return (
      <>
        <span className="min-w-0 flex-1">
          <Trans>
            This bot is pinned to {provider} · {model} · {effort}; connect it or change the pin.
          </Trans>
        </span>
        <Button variant="link" size="xs" className="text-destructive" onClick={onConnect}>
          <Trans>Connect</Trans>
        </Button>
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
