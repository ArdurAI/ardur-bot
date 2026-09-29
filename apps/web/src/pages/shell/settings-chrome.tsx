import type { Bot } from "@ardurbot/contracts";
import { BotAvatar, Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Settings } from "lucide-react";

export type SettingsPanel = "settings" | "group-settings";

/** Bot and group settings open wide; create forms and routines stay narrow. */
export function isSettingsPanel(panel: string | null): panel is SettingsPanel {
  return panel === "settings" || panel === "group-settings";
}

/** The conversation header's entry to the settings of the bot or group in view. */
export function ThreadSettingsButton({
  group,
  panel,
  onPanel,
}: {
  group: boolean;
  panel: string | null;
  onPanel: (panel: SettingsPanel | null) => void;
}) {
  const { t } = useLingui();
  const target: SettingsPanel = group ? "group-settings" : "settings";
  const open = panel === target;
  const label = group ? t`Group settings` : t`Bot settings`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={label}
      data-active={open ? "" : undefined}
      onClick={() => onPanel(open ? null : target)}
      className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
    >
      <Settings size={18} strokeWidth={1.6} aria-hidden="true" className="text-foreground/75" />
    </button>
  );
}

/** Heads a bot's settings panel with its seal and name. */
export function BotSettingsTitle({ bot }: { bot: Pick<Bot, "id" | "name" | "color"> }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BotAvatar color={bot.color} identity={bot.id} label={bot.name} size={28} />
      <span dir="auto" className="truncate text-[14px] font-medium text-foreground">
        {bot.name}
      </span>
    </span>
  );
}

/** Switches the panel between settings and the computer; ink marks settings as open. */
export function SettingsPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useLingui();
  return (
    <Button
      variant={open ? "default" : "ghost"}
      size="icon-sm"
      aria-label={open ? t`Show computer` : t`Show settings`}
      onClick={onToggle}
      className={open ? undefined : "text-muted-foreground"}
    >
      <Settings size={16} strokeWidth={1.7} />
    </Button>
  );
}
