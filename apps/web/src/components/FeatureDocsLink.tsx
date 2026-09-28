import { featureDocsLink } from "@ardurbot/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleHelp } from "lucide-react";

/** A normal external anchor preserves the mounted editor and Electron delegates it to its link viewer. */
export function FeatureDocsLink({
  featureId,
  title,
  step,
  error,
  iconOnly = false,
}: {
  featureId: string;
  title: string;
  step?: string;
  error?: string;
  iconOnly?: boolean;
}) {
  const { t } = useLingui();
  const href = featureDocsLink(featureId, { step, error });
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t`Learn more about ${title}`}
      className="shrink-0 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2"
    >
      {iconOnly ? <CircleHelp aria-hidden="true" className="size-4" /> : <Trans>Learn more</Trans>}
    </a>
  );
}
