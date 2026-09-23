import { Trans } from "@lingui/react/macro";

export function ShowAllModels({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <Trans>Show all models</Trans>
    </label>
  );
}
