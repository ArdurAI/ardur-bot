import { Trans } from "@lingui/react/macro";

export function SettingsSupportLinks() {
  return (
    <div className="flex flex-wrap gap-4 text-[13px] text-muted-foreground">
      <a
        href="https://github.com/ArdurAI/ardur-bot/issues/new/choose"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        <Trans>Report an issue</Trans>
      </a>
      <a
        href="https://github.com/ArdurAI/ardur-bot/discussions"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        <Trans>Discussions</Trans>
      </a>
    </div>
  );
}
