import { Button, Popover, PopoverContent, PopoverTrigger } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { ChevronDown, Gauge, LayoutGrid, LogOut, Settings } from "lucide-react";

export function DashboardAccountArea({
  name,
  menuOpen,
  onMenuOpenChange,
  onSettings,
  onIntegrations,
  onUsage,
  onSignOut,
}: {
  name: string;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onSettings: () => void;
  onIntegrations: () => void;
  onUsage: () => void;
  onSignOut: () => void;
}) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      data-testid="dashboard-account"
      className="mx-auto mb-4 flex max-w-6xl flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          className="flex min-w-0 items-center gap-3 rounded-lg p-1 text-start hover:bg-accent"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-xs text-foreground/75">
            {initials}
          </span>
          <span className="truncate text-sm font-medium" dir="auto">
            {name}
          </span>
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        {menuOpen ? (
          <PopoverContent
            side="bottom"
            align="start"
            className="w-64 max-w-[calc(100vw-2rem)] gap-0 p-1 data-closed:animate-none"
          >
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              onClick={() => {
                onMenuOpenChange(false);
                onSettings();
              }}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              onClick={() => {
                onMenuOpenChange(false);
                onUsage();
              }}
            >
              <Gauge className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Usage</Trans>
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              onClick={() => {
                onMenuOpenChange(false);
                onSignOut();
              }}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
          </PopoverContent>
        ) : null}
      </Popover>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-w-0 flex-1 sm:flex-none" onClick={onSettings}>
          <Settings size={16} />
          <Trans>Settings</Trans>
        </Button>
        <Button variant="outline" className="min-w-0 flex-1 sm:flex-none" onClick={onIntegrations}>
          <LayoutGrid size={16} />
          <Trans>Integrations</Trans>
        </Button>
      </div>
    </div>
  );
}
