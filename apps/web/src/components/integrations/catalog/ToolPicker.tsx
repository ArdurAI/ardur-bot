import type { IntegrationDescriptor, IntegrationManifest } from "@ardurbot/contracts";
import { approvalFor, integrationToolKind } from "@ardurbot/core";
import { Checkbox } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useId } from "react";

export function ToolPicker({
  manifest,
  descriptor,
  selected,
  onChange,
  disabled = false,
}: {
  manifest: IntegrationManifest;
  descriptor?: IntegrationDescriptor;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const controlId = useId();
  return (
    <div className="space-y-5">
      {(["read", "write"] as const).map((kind) => {
        const tools = manifest.tools.filter(
          (tool) => integrationToolKind(tool.id, tool.description) === kind,
        );
        if (!tools.length) return null;
        return (
          <fieldset key={kind} disabled={disabled} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              {kind === "read" ? t`Read` : t`Write`}
            </legend>
            {tools.map((tool) => {
              const approval = descriptor
                ? approvalFor(descriptor, tool.id, {}, tool.description)
                : undefined;
              return (
                <label
                  key={tool.id}
                  htmlFor={`${controlId}-${tool.id}`}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
                >
                  <Checkbox
                    id={`${controlId}-${tool.id}`}
                    aria-label={tool.id}
                    checked={selected.includes(tool.id)}
                    disabled={disabled || approval === "disabled"}
                    onCheckedChange={(checked) =>
                      onChange(
                        checked ? [...selected, tool.id] : selected.filter((id) => id !== tool.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 break-words" title={tool.description}>
                    {tool.id}
                  </span>
                  {approval === "ask-first" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{t`asks first`}</span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
