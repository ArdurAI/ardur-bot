import type {
  IntegrationDescriptor,
  IntegrationManifest,
  SpaceToolPolicies,
} from "@ardurbot/contracts";
import { approvalFor, integrationToolKind } from "@ardurbot/core";
import { Checkbox, Toggle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useId } from "react";

export function ToolPicker({
  manifest,
  descriptor,
  selected,
  onChange,
  disabled = false,
  spaceToolPolicies = {},
  onPolicyChange,
}: {
  manifest: IntegrationManifest;
  descriptor?: IntegrationDescriptor;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  spaceToolPolicies?: SpaceToolPolicies;
  onPolicyChange?: (policies: SpaceToolPolicies) => void;
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
            {kind === "read" && descriptor && onPolicyChange ? (
              <p className="text-xs text-muted-foreground">{t`Reads can run without asking once you allow them. Writes always ask.`}</p>
            ) : null}
            {tools.map((tool) => {
              const approval = descriptor
                ? approvalFor(descriptor, tool.id, {}, tool.description, spaceToolPolicies)
                : undefined;
              const reviewedRead = descriptor
                ? approvalFor(descriptor, tool.id, {}, tool.description) === "allow"
                : false;
              return (
                <div
                  key={tool.id}
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
                  <label
                    htmlFor={`${controlId}-${tool.id}`}
                    className="min-w-0 flex-1 break-words"
                    title={tool.description}
                  >
                    {tool.id}
                  </label>
                  {kind === "read" && descriptor && onPolicyChange ? (
                    <Toggle
                      size="sm"
                      variant="outline"
                      aria-label={t`Approval for ${tool.id}`}
                      pressed={approval === "allow"}
                      disabled={
                        disabled ||
                        !selected.includes(tool.id) ||
                        approval === "disabled" ||
                        reviewedRead
                      }
                      onPressedChange={(allow) =>
                        onPolicyChange({
                          ...spaceToolPolicies,
                          [tool.id]: allow ? "allow" : "ask-first",
                        })
                      }
                    >
                      {approval === "allow" ? t`Allow` : t`Ask first`}
                    </Toggle>
                  ) : approval === "ask-first" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{t`asks first`}</span>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
