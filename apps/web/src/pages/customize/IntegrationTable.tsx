import { Badge, Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyList } from "./CustomizeControls";
import type { ConnectorRow } from "./connector-rows";

export function IntegrationTable({
  rows,
  busy,
  onConnect,
  onManage,
  renderActions,
  renderType,
}: {
  rows: ConnectorRow[];
  busy?: string | null;
  onConnect(row: ConnectorRow): void;
  onManage?(row: ConnectorRow): void;
  renderActions?(row: ConnectorRow): ReactNode;
  renderType?(row: ConnectorRow): ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className="py-3 font-normal">{t`Integration`}</th>
            <th className="py-3 font-normal">{t`Type`}</th>
            <th className="py-3 font-normal">{t`Status`}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid={row.catalogId ? `integration-${row.catalogId}` : undefined}
            >
              <td className="py-4 pr-3">
                {onManage && row.status === "connected" && row.catalogId ? (
                  <Button variant="link" className="h-auto p-0" onClick={() => onManage(row)}>
                    {row.name}
                  </Button>
                ) : (
                  row.name
                )}
              </td>
              <td className="py-4 pr-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {renderType ? (
                    renderType(row)
                  ) : (
                    <span>{row.type === "web" ? t`Web` : t`Desktop`}</span>
                  )}
                  {row.badges.map((badge) => (
                    <Badge key={badge} variant="secondary">
                      {badge === "included"
                        ? t`Included`
                        : badge === "local-dev"
                          ? t`Local dev`
                          : t`Custom`}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="py-4">
                <div className="flex items-center gap-2">
                  {row.status === "connected" ? (
                    <>
                      <Check className="size-4 text-success" aria-hidden />
                      <span>{t`Connected`}</span>
                    </>
                  ) : row.status === "reconnect" ? (
                    <>
                      <TriangleAlert
                        className="size-4 text-warning"
                        aria-label={t`Needs reconnection`}
                      />
                      {renderActions ? (
                        <span>{t`Needs reconnection`}</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === row.id}
                          onClick={() => onConnect(row)}
                        >{t`Reconnect`}</Button>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">{t`Disconnected`}</span>
                      {!renderActions ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!row.available || busy === row.id}
                          onClick={() => onConnect(row)}
                        >{t`Connect`}</Button>
                      ) : null}
                    </>
                  )}
                </div>
                {renderActions?.(row)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <EmptyList /> : null}
    </div>
  );
}
