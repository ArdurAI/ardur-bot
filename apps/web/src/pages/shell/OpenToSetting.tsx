import { Field, FieldLabel, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useOpenTo, writeOpenTo } from "./open-to";

export function OpenToSetting() {
  const { t } = useLingui();
  const value = useOpenTo();
  return (
    <Field className="rounded-xl border border-border px-4 py-4">
      <FieldLabel htmlFor="open-to">
        <Trans>Open to</Trans>
      </FieldLabel>
      <NativeSelect
        id="open-to"
        aria-label={t`Open to`}
        value={value}
        onChange={(event) => writeOpenTo(event.target.value === "bots" ? "bots" : "dashboard")}
      >
        <NativeSelectOption value="dashboard">
          <Trans>Dashboard</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="bots">
          <Trans>Bots</Trans>
        </NativeSelectOption>
      </NativeSelect>
    </Field>
  );
}
