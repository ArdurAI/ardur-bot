import type {
  IntegrationResourceChoice,
  IntegrationResourceKind,
  IntegrationResourceTool,
} from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../../lib/rpc";

export function ResourcePicker({
  connectionId,
  kind,
  onSelect,
}: {
  connectionId: string;
  kind: IntegrationResourceKind;
  onSelect: (choice: IntegrationResourceChoice) => void;
}) {
  const { t } = useLingui();
  const controlId = useId();
  const [tools, setTools] = useState<IntegrationResourceTool[]>([]);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<IntegrationResourceChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState("");
  async function load() {
    try {
      setTools(await rpc.integrations.resourceTools({ connectionId, kind }));
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    void load();
  }, [connectionId, kind]);
  const tool = tools.find((entry) => entry.id === selected) ?? tools[0];
  async function search() {
    if (!tool) return;
    setBusy(true);
    setError(false);
    try {
      setChoices(
        await rpc.integrations.searchResources({ connectionId, kind, toolId: tool.id, args }),
      );
      setSearched(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {error ? (
        <div role="alert">
          <p className="text-sm text-destructive">{t`Could not load destinations.`}</p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void (tool ? search() : load())}
          >{t`Try again`}</Button>
        </div>
      ) : null}
      {tool ? (
        <details>
          <summary className="cursor-pointer text-sm">{t`Find a destination`}</summary>
          <div className="space-y-2 pt-2">
            {tools.length > 1 ? (
              <div className="flex flex-wrap gap-2">
                {tools.map((entry) => (
                  <Button
                    key={entry.id}
                    variant="outline"
                    aria-pressed={tool.id === entry.id}
                    onClick={() => {
                      setSelected(entry.id);
                      setArgs({});
                      setChoices([]);
                      setSearched(false);
                    }}
                  >
                    {entry.id}
                  </Button>
                ))}
              </div>
            ) : null}
            {tool.fields.map((field) => (
              <label
                htmlFor={`${controlId}-${field.name}`}
                key={field.name}
                className="block text-sm"
              >
                {field.name}
                <Input
                  id={`${controlId}-${field.name}`}
                  aria-label={field.name}
                  required={field.required}
                  value={args[field.name] ?? ""}
                  onChange={(event) =>
                    setArgs((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              </label>
            ))}
            <Button
              variant="outline"
              disabled={
                busy || tool.fields.some((field) => field.required && !args[field.name]?.trim())
              }
              onClick={() => void search()}
            >{t`Search`}</Button>
            {choices.map((choice) => (
              <Button key={choice.id} variant="outline" onClick={() => onSelect(choice)}>
                {choice.label}
              </Button>
            ))}
            {searched && !choices.length ? (
              <p className="text-sm text-muted-foreground">{t`No destinations found.`}</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
