import { COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { t } from "@lingui/core/macro";

export function ComputerScreenError({
  message,
  code,
  onRetryProvision,
  onRetryScreen,
}: {
  message: string;
  code?: string;
  onRetryProvision: () => void;
  onRetryScreen: () => void;
}) {
  const downloadFailed = code === COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
      <p className="text-destructive">{message}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={downloadFailed ? onRetryProvision : onRetryScreen}
      >
        {downloadFailed ? t`Try again` : t`Retry screen`}
      </Button>
    </div>
  );
}
