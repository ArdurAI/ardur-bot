import type {
  IntegrationDescriptor,
  IntegrationManifest,
  SpaceToolPolicies,
} from "@ardurbot/contracts";
import { integrationToolKind } from "@ardurbot/core";
import { NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";

export function ToolPermissions({
  manifest,
  descriptor,
  selected,
  onChange,
  disabled,
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
  return (
    <div className="space-y-2">
      {manifest.tools.map((tool) => {
        const read = integrationToolKind(tool.id, tool.description) === "read";
        const blocked = descriptor?.toolPolicies[tool.id]?.approval === "disabled";
        const permission = !selected.includes(tool.id)
          ? "block"
          : read && spaceToolPolicies[tool.id] === "allow"
            ? "allow"
            : "ask";
        return (
          <div
            key={tool.id}
            className="flex items-center gap-3 rounded-lg border border-border p-3"
          >
            <details className="min-w-0 flex-1 text-sm">
              <summary className="cursor-pointer break-words">{tool.id}</summary>
              <p className="mt-2 text-muted-foreground">{tool.description}</p>
            </details>
            <NativeSelect
              aria-label={t`Permission for ${tool.id}`}
              value={permission}
              disabled={disabled || blocked}
              onChange={(event) => {
                const value = event.target.value;
                onChange(
                  value === "block"
                    ? selected.filter((id) => id !== tool.id)
                    : [...new Set([...selected, tool.id])],
                );
                if (onPolicyChange)
                  onPolicyChange({
                    ...spaceToolPolicies,
                    [tool.id]: value === "allow" ? "allow" : "ask-first",
                  });
              }}
            >
              {read ? <NativeSelectOption value="allow">{t`Allow`}</NativeSelectOption> : null}
              <NativeSelectOption value="ask">{t`Ask`}</NativeSelectOption>
              <NativeSelectOption value="block">{t`Block`}</NativeSelectOption>
            </NativeSelect>
          </div>
        );
      })}
    </div>
  );
}
