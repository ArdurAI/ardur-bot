import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { parseProviderError } from "../../lib/provider-error";

export function ProviderErrorMessage({
  text,
  onChangeModel,
}: {
  text: string;
  onChangeModel?: () => void;
}) {
  const error = parseProviderError(text);
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
