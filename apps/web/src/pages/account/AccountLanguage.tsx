import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { getActiveUiLocale, setUiLocale } from "../../lib/i18n";
import type { UiLocale } from "../../lib/ui-locale";
import { UI_LOCALE_LABELS, UI_LOCALES } from "../../lib/ui-locale";

export function AccountLanguage() {
  const { t } = useLingui();
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const request = useRef(0);
  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const id = ++request.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (id === request.current) setLocale(activated);
    });
  }
  return (
    <SettingsRow label={t`Language`}>
      <UiLocalePicker value={locale} onChange={chooseLocale} />
    </SettingsRow>
  );
}

function UiLocalePicker({
  value,
  onChange,
}: {
  value: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="relative">
      <Select value={value} onValueChange={(v) => onChange(v as UiLocale)}>
        <SelectTrigger data-testid="ui-locale-select" aria-label={t`Language`} className="w-full">
          <SelectValue>{UI_LOCALE_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {UI_LOCALES.map((code) => (
            <SelectItem key={code} value={code}>
              {UI_LOCALE_LABELS[code]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
