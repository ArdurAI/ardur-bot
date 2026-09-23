import type { ProviderErrorKind } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { parseProviderError } from "../../lib/provider-error";

export function ProviderErrorMessage({
  text,
  providerErrorKind,
  onChangeModel,
}: {
  text: string;
  providerErrorKind?: ProviderErrorKind;
  onChangeModel?: () => void;
}) {
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
