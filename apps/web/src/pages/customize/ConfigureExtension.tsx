import type { ExtensionConfigField, ExtensionConfigValue } from "@ardurbot/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Textarea,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

export type { ExtensionConfigField, ExtensionConfigValue } from "@ardurbot/contracts";

function SensitiveValues({
  field,
  id,
  busy,
  value,
  onChange,
}: {
  field: ExtensionConfigField;
  id: string;
  busy: boolean;
  value: ExtensionConfigValue | undefined;
  onChange(value: string[]): void;
}) {
  const { t } = useLingui();
  const nextId = useRef(1);
  const [items, setItems] = useState([{ id: 0, value: "" }]);
  useEffect(() => {
    if (!Array.isArray(value)) return;
    setItems((current) =>
      JSON.stringify(current.map((item) => item.value).filter(Boolean)) === JSON.stringify(value)
        ? current
        : value.map((text) => ({ id: nextId.current++, value: text })),
    );
  }, [value]);
  function update(next: typeof items) {
    setItems(next);
    onChange(next.map((item) => item.value).filter(Boolean));
  }
  return (
    <div className="w-full space-y-2">
      {items.map((item, index) => (
        <div key={item.id} className="flex items-center gap-2">
          <Input
            id={index === 0 ? id : `${id}-${item.id}`}
            type="password"
            aria-label={field.title}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            required={field.required && !field.configured && index === 0}
            placeholder={field.configured ? t`Saved` : undefined}
            value={item.value}
            onChange={(event) =>
              update(
                items.map((row) =>
                  row.id === item.id ? { ...row, value: event.target.value } : row,
                ),
              )
            }
          />
          {items.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => update(items.filter((row) => row.id !== item.id))}
            >{t`Remove`}</Button>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setItems([...items, { id: nextId.current++, value: "" }])}
      >{t`Add value`}</Button>
    </div>
  );
}
export function ConfigureExtension({
  name,
  fields,
  onSave,
  onClose,
  pickPath,
  installing = false,
}: {
  name: string;
  fields: ExtensionConfigField[];
  onSave(values: Record<string, ExtensionConfigValue>): Promise<void>;
  onClose(): void;
  pickPath?(field: ExtensionConfigField): Promise<string[] | null>;
  installing?: boolean;
}) {
  const { t } = useLingui();
  const [values, setValues] = useState<Record<string, ExtensionConfigValue>>(() =>
    Object.fromEntries(
      fields.flatMap((field) =>
        field.value === undefined
          ? field.type === "boolean" && !(field.sensitive && field.configured)
            ? [[field.key, false]]
            : []
          : [[field.key, field.value]],
      ),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const put = (key: string, value: ExtensionConfigValue) =>
    setValues((current) => ({ ...current, [key]: value }));
  async function save() {
    setBusy(true);
    setFailed(false);
    try {
      await onSave(values);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="top-0 right-0 left-auto h-dvh max-h-dvh max-w-full translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:max-w-lg"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{installing ? t`Install ${name}` : t`Configure ${name}`}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-4"
        >
          {fields.map((field) => {
            const value = values[field.key];
            const id = `extension-config-${field.key}`;
            return (
              <Field key={field.key}>
                <FieldLabel htmlFor={id}>{field.title}</FieldLabel>
                {field.type === "boolean" ? (
                  <Checkbox
                    id={id}
                    checked={value === true}
                    disabled={busy}
                    onCheckedChange={(checked) => put(field.key, checked === true)}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    {field.multiple && field.sensitive ? (
                      <SensitiveValues
                        field={field}
                        id={id}
                        busy={busy}
                        value={value}
                        onChange={(value) => {
                          if (!value.length && field.configured)
                            setValues((current) => {
                              const copy = { ...current };
                              delete copy[field.key];
                              return copy;
                            });
                          else put(field.key, value);
                        }}
                      />
                    ) : field.multiple ? (
                      <Textarea
                        id={id}
                        disabled={busy}
                        required={field.required}
                        value={Array.isArray(value) ? value.join("\n") : ""}
                        onChange={(event) =>
                          put(field.key, event.target.value.split("\n").filter(Boolean))
                        }
                      />
                    ) : (
                      <Input
                        id={id}
                        type={
                          field.sensitive ? "password" : field.type === "number" ? "number" : "text"
                        }
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        min={field.min}
                        max={field.max}
                        step={field.type === "number" ? "any" : undefined}
                        required={field.required && !field.configured}
                        placeholder={field.sensitive && field.configured ? t`Saved` : undefined}
                        value={
                          Array.isArray(value)
                            ? value.join("\n")
                            : typeof value === "boolean" || value === undefined
                              ? ""
                              : value
                        }
                        onChange={(event) => {
                          const next = event.target.value;
                          if (field.sensitive && !next && field.configured)
                            setValues((current) => {
                              const copy = { ...current };
                              delete copy[field.key];
                              return copy;
                            });
                          else
                            put(
                              field.key,
                              field.multiple
                                ? next.split("\n").filter(Boolean)
                                : field.type === "number" && next
                                  ? Number(next)
                                  : next,
                            );
                        }}
                      />
                    )}
                    {pickPath && (field.type === "file" || field.type === "directory") ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void pickPath(field)
                            .then((paths) => {
                              if (paths) put(field.key, field.multiple ? paths : (paths[0] ?? ""));
                            })
                            .catch(() => setFailed(true))
                        }
                      >{t`Choose`}</Button>
                    ) : null}
                  </div>
                )}
              </Field>
            );
          })}
          {failed ? (
            <p
              role="alert"
              className="text-sm text-destructive"
            >{t`Could not save configuration. Check the fields and try again.`}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onClose}
            >{t`Cancel`}</Button>
            <Button type="submit" disabled={busy}>
              {installing ? t`Install` : t`Save`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
