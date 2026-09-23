import { Trans } from "@lingui/react/macro";
import { Settings } from "lucide-react";

export function SidebarSettings({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-3 mb-1 flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-sidebar-accent"
    >
      <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent text-foreground/80">
        <Settings size={15} strokeWidth={1.8} />
      </span>
      <span className="text-[14px] font-medium text-foreground/90">
        <Trans>Settings</Trans>
      </span>
    </button>
  );
}
