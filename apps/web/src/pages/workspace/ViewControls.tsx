import type { WorkspaceLayout, WorkspaceViewId } from "@ardurbot/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { MoreVertical } from "lucide-react";
import type { ViewCapabilities } from "./view-registry";
import { availableWorkspaceViews } from "./view-registry";

export function ViewControls({
  capabilities,
  layout,
  visible,
  onOpen,
  onPosition,
}: {
  capabilities: ViewCapabilities;
  layout: WorkspaceLayout;
  visible: boolean;
  onOpen(view: WorkspaceViewId): void;
  onPosition(position: WorkspaceLayout["position"]): void;
}) {
  const { t } = useLingui();
  const views = availableWorkspaceViews(capabilities);
  return (
    <>
      {views
        .filter((view) => view.primary)
        .map((view) => {
          const Icon = view.icon;
          return (
            <Button
              key={view.id}
              variant="ghost"
              size="icon-sm"
              aria-label={view.label(t)}
              aria-pressed={visible && layout.active === view.id}
              title={view.label(t)}
              className="app-no-drag aria-pressed:bg-accent"
              onClick={() => onOpen(view.id)}
            >
              <Icon size={18} aria-hidden="true" />
            </Button>
          );
        })}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={t`Views`} className="app-no-drag" />
          }
        >
          <MoreVertical size={18} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {views.map((view) => {
            const Icon = view.icon;
            return (
              <DropdownMenuItem key={view.id} onClick={() => onOpen(view.id)}>
                <Icon size={16} aria-hidden="true" />
                {view.label(t)}
              </DropdownMenuItem>
            );
          })}
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
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
