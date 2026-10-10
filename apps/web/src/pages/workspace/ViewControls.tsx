import type { WorkspaceLayout, WorkspaceViewId } from "@ardurbot/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { MoreVertical } from "lucide-react";
import type { ReactNode } from "react";
import type { ViewCapabilities } from "./view-registry";
import { workspaceViews } from "./view-registry";

export function ViewControls({
  capabilities,
  layout,
  visible,
  onOpen,
  onPosition,
  children,
}: {
  capabilities: ViewCapabilities | null;
  layout: WorkspaceLayout;
  visible: boolean;
  onOpen(view: WorkspaceViewId): void;
  onPosition(position: WorkspaceLayout["position"]): void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  // Terminal stays visible as a disabled item with a reason when this bot's
  // computer cannot run one, instead of vanishing from the menu.
  const terminalUnavailable =
    capabilities?.computer && !workspaceViews.terminal.available(capabilities)
      ? workspaceViews.terminal
      : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Views`}
            data-workspace-trigger
            className="app-no-drag shrink-0"
          />
        }
      >
        <MoreVertical size={18} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-max">
        {(capabilities ? Object.values(workspaceViews) : []).map((view) => {
          if (!view.available(capabilities!)) {
            if (view.id !== "terminal" || !terminalUnavailable) return null;
            const Icon = view.icon;
            return (
              <DropdownMenuItem key={view.id} disabled>
                <Icon size={16} aria-hidden="true" />
                <span className="flex flex-col">
                  {view.label(t)}
                  <span className="text-xs text-muted-foreground">
                    {terminalUnavailable.unavailable(t)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          }
          const Icon = view.icon;
          const checked = visible && layout.active === view.id;
          return (
            <DropdownMenuCheckboxItem
              key={view.id}
              checked={checked}
              aria-checked={checked}
              closeOnClick
              onClick={() => onOpen(view.id)}
            >
              <Icon size={16} aria-hidden="true" />
              {view.label(t)}
            </DropdownMenuCheckboxItem>
          );
        })}
        {children}
        {capabilities ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onPosition("left")}
            >{t`Move split view left`}</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onPosition("right")}
            >{t`Move split view right`}</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onPosition("bottom")}
            >{t`Move split view down`}</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
