import type { AccountSession, LocalDevice } from "@ardurbot/contracts";
import { accountDate, accountPage, devicePlatform } from "@ardurbot/core";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";

const cell = "py-3 pe-4 text-start text-sm";

export function LocalDevicesTable({
  devices,
  currentRegistrationId,
  canManage,
  busy,
  onApprove,
  onDisconnect,
}: {
  devices: LocalDevice[];
  currentRegistrationId?: string;
  canManage: boolean;
  busy: boolean;
  onApprove: (id: string) => void;
  onDisconnect: (device: LocalDevice) => void;
}) {
  const { t, i18n } = useLingui();
  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label={t`Local devices`}>
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className={cell}>{t`Name`}</th>
            <th className={cell}>{t`Platform`}</th>
            <th className={cell}>{t`Added`}</th>
            <th className={cell}>{t`Last seen`}</th>
            {canManage ? (
              <th>
                <span className="sr-only">{t`Device actions`}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr
              key={`${device.kind}:${device.id}`}
              className="border-b border-border last:border-0"
            >
              <td className={cell}>
                <span>{device.name}</span>
                {device.kind === "host" &&
                currentRegistrationId &&
                device.registrationId === currentRegistrationId ? (
                  <Badge variant="secondary" className="ms-2">{t`This computer`}</Badge>
                ) : null}
                {!device.approved ? (
                  <Badge variant="outline" className="ms-2">{t`Needs approval`}</Badge>
                ) : null}
              </td>
              <td className={cell}>{devicePlatform(device.platform)}</td>
              <td className={cell}>{accountDate(device.createdAt, i18n.locale)}</td>
              <td className={cell}>{accountDate(device.lastSeenAt, i18n.locale)}</td>
              {canManage ? (
                <td className="py-3 text-end">
                  <div className="flex justify-end gap-2">
                    {!device.approved ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => onApprove(device.id)}
                      >{t`Approve`}</Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onDisconnect(device)}
                    >{t`Disconnect`}</Button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {!devices.length ? (
        <p className="py-3 text-sm text-muted-foreground">{t`No local devices`}</p>
      ) : null}
    </div>
  );
}

export function ActiveSessionsTable({
  sessions,
  busy,
  onRevoke,
}: {
  sessions: AccountSession[];
  busy: boolean;
  onRevoke: (session: AccountSession) => void;
}) {
  const { t, i18n } = useLingui();
  const [requestedPage, setPage] = useState(0);
  const { rows, page, start, end, total } = accountPage(sessions, requestedPage);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full" aria-label={t`Active sessions`}>
          <thead className="border-b border-border text-muted-foreground">
            <tr>
              <th className={cell}>{t`Device`}</th>
              <th className={cell}>{t`Created`}</th>
              <th className={cell}>{t`Updated`}</th>
              <th>
                <span className="sr-only">{t`Session actions`}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((session) => (
              <tr key={session.id} className="border-b border-border last:border-0">
                <td className={cell}>
                  {session.device === "Unknown device"
                    ? t`Unknown device`
                    : session.device === "Desktop app"
                      ? t`Desktop app`
                      : session.device}
                  {session.current ? (
                    <Badge variant="secondary" className="ms-2">{t`Current`}</Badge>
                  ) : null}
                </td>
                <td className={cell}>{accountDate(session.createdAt, i18n.locale)}</td>
                <td className={cell}>{accountDate(session.updatedAt, i18n.locale)}</td>
                <td className="text-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t`Session actions`}
                          disabled={busy}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onRevoke(session)}
                      >{t`Sign out`}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span aria-live="polite">{t`Showing ${start}–${end} of ${total}`}</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || page === 0}
            onClick={() => setPage(page - 1)}
          >{t`Previous`}</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || end >= total}
            onClick={() => setPage(page + 1)}
          >{t`Next`}</Button>
        </div>
      </div>
    </div>
  );
}
