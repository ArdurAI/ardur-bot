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
import { availableWorkspaceViews } from "./view-registry";

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
  const views = capabilities ? availableWorkspaceViews(capabilities) : [];
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
        {views.map((view) => {
          const Icon = view.icon;
          return (
            <DropdownMenuCheckboxItem
              key={view.id}
              checked={visible && layout.active === view.id}
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
