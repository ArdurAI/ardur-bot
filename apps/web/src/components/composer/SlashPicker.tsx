import type { ComposerCommand } from "@ardurbot/core";
import { truncateSlashDescription } from "@ardurbot/core";
import { Command, CommandItem, CommandList, CommandShortcut } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useLayoutEffect, useRef, useState } from "react";
import { commandDescription } from "./command-description";

export default function SlashPicker({
  open,
  onAria,
  rows,
  activeId,
  onActive,
  onSelect,
}: {
  open: boolean;
  onAria: (value: { listId?: string; optionId?: string }) => void;
  rows: readonly ComposerCommand[];
  activeId?: string;
  onActive: (id: string) => void;
  onSelect: (command: ComposerCommand) => void;
}) {
  const { t } = useLingui();
  const list = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  const [retained, setRetained] = useState(rows);
  useLayoutEffect(() => {
    // Command owns these IDs; the external textarea must reference its actual DOM nodes.
    onAria(
      open
        ? {
            listId: list.current?.id,
            optionId: activeId ? items.current.get(activeId)?.id : undefined,
          }
        : {},
    );
  }, [activeId, onAria, open, rows]);
  if (open && retained !== rows) setRetained(rows);
  return (
    <div
      data-testid={open ? "slash-picker" : undefined}
      data-open={open ? "" : undefined}
      data-closed={!open ? "" : undefined}
      aria-hidden={!open}
      inert={!open}
      className="composer-popup composer-slash-popup absolute bottom-full inset-x-0 z-30 mb-2 rounded-xl border border-border shadow-md"
    >
      <Command
        label={t`Slash commands`}
        shouldFilter={false}
        value={activeId ?? ""}
        onValueChange={onActive}
      >
        <CommandList ref={list} label={t`Slash commands`}>
          {(open ? rows : retained).map((row) => (
            <CommandItem
              key={row.id}
              ref={(element) => {
                if (element) items.current.set(row.id, element);
                else items.current.delete(row.id);
              }}
              value={row.id}
              onSelect={() => onSelect(row)}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{row.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {truncateSlashDescription(commandDescription(row))}
                </span>
              </span>
              <CommandShortcut>↵</CommandShortcut>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}
