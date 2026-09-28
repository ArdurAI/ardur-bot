import type { ComputerStatus } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { screenIframeSandbox } from "../../lib/computer-screen";

export function WorkspaceScreen({
  computer,
  open,
  url,
  error,
  status,
  onOpen,
  visible = true,
}: {
  computer: ComputerStatus | null;
  open: boolean;
  url: string | null;
  error: ReactNode;
  status?: ReactNode;
  onOpen(): void;
  visible?: boolean;
}) {
  const { t } = useLingui();
  return (
    <div className="p-3">
      <div
        data-testid="computer-preview"
        className="group relative aspect-[16/10] overflow-hidden rounded-xl bg-muted"
      >
        {error ? (
          <div className="grid h-full place-items-center p-4 text-sm">{error}</div>
        ) : open ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            {t`Open in full window`}
          </div>
        ) : computer?.state === "running" && url && visible ? (
          <iframe
            title={t`Bot screen preview`}
            src={url}
            sandbox={screenIframeSandbox(url)}
            className="h-full w-full border-0 bg-black"
            style={{ pointerEvents: "none" }}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            {status || t`Open screen to view this computer.`}
          </div>
        )}
        {!error ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            className="absolute inset-0 flex items-center justify-center bg-overlay/40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t`Open screen`}
            onClick={onOpen}
          >
            <span className="rounded-full bg-overlay px-3 py-2 text-sm text-foreground">
              {t`Open screen`}
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
