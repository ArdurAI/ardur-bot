import { NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { SettingsRow } from "../../components/SettingsRow";
import { useOpenTo, writeOpenTo } from "./open-to";

export function OpenToSetting() {
  const { t } = useLingui();
  const value = useOpenTo();
  return (
    <SettingsRow label={t`Open to`}>
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
    </SettingsRow>
  );
}
