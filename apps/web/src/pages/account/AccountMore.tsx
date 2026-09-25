import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApprovalRulesSettings } from "../../components/ApprovalRulesSettings";
import { SettingsRow } from "../../components/SettingsRow";
import type { SettingsPageProps } from "../settings-types";

export function AccountMore({
  messagingEnabled,
  onOpenMessaging,
  isDeploymentOwner,
}: Pick<SettingsPageProps, "messagingEnabled" | "onOpenMessaging" | "isDeploymentOwner">) {
  const { t } = useLingui();
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      {messagingEnabled && onOpenMessaging ? (
        <SettingsRow label={t`Messaging`}>
          <Button
            variant="outline"
            onClick={onOpenMessaging}
          >{t`Manage messaging settings`}</Button>
        </SettingsRow>
      ) : null}
      {isDeploymentOwner ? (
        <SettingsRow label={t`Server integrations`}>
          <Button
            nativeButton={false}
            role="link"
            variant="outline"
            render={<Link to="/integrations/setup" />}
          >{t`Manage`}</Button>
        </SettingsRow>
      ) : null}
      <SettingsRow
        label={t`Advanced`}
        content={
          <details
            data-testid="advanced-settings"
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary className="cursor-pointer py-3 text-sm">{t`Action confirmations`}</summary>
            {advanced ? <ApprovalRulesSettings /> : null}
          </details>
        }
      >
        {null}
      </SettingsRow>
    </>
  );
}
