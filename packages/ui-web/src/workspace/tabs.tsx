import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";

export type WorkspaceTab = { id: string; label: string; content: ReactNode };

export function WorkspaceTabs({
  tabs,
  value,
  onChange,
  onClose,
  closeLabel,
  label = "Workspace",
}: {
  tabs: readonly WorkspaceTab[];
  value: string;
  onChange(value: string): void;
  onClose?(value: string): void;
  closeLabel?(name: string): string;
  label?: string;
}) {
  const [seen, setSeen] = useState(() => new Set([value]));
  useEffect(() => setSeen((current) => new Set(current).add(value)), [value]);
  return (
    <Tabs value={value} onValueChange={onChange} className="min-h-0 flex-1 gap-0">
      <TabsList
        data-workspace-chrome
        variant="line"
        aria-label={label}
        className="w-full shrink-0 justify-start overflow-x-auto rounded-none border-b border-border px-2"
      >
        {tabs.map((tab) => (
          <div key={tab.id} className="flex shrink-0 items-center">
            <TabsTrigger value={tab.id} className="h-9 min-w-fit px-3">
              {tab.label}
            </TabsTrigger>
            {onClose && closeLabel ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={closeLabel(tab.label)}
                onClick={() => onClose(tab.id)}
              >
                <X size={12} aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="min-h-0 overflow-auto" keepMounted>
          {seen.has(tab.id) || value === tab.id ? tab.content : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
