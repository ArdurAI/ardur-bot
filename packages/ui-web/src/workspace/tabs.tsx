import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";

export type WorkspaceTab = { id: string; label: string; content: ReactNode };

export function WorkspaceTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly WorkspaceTab[];
  value: string;
  onChange(value: string): void;
}) {
  const [seen, setSeen] = useState(() => new Set([value]));
  useEffect(() => setSeen((current) => new Set(current).add(value)), [value]);
  return (
    <Tabs value={value} onValueChange={onChange} className="min-h-0 flex-1 gap-0">
      <TabsList
        variant="line"
        aria-label="Workspace"
        className="w-full shrink-0 justify-start overflow-x-auto rounded-none border-b border-border px-2"
      >
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="h-9 min-w-fit px-3">
            {tab.label}
          </TabsTrigger>
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
