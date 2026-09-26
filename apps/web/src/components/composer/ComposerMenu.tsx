import type {
  IntegrationCatalogList,
  IntegrationConnection,
  IntegrationDescriptor,
  McpServer,
} from "@ardurbot/contracts";
import type { ComposerMention, ComposerSkill } from "@ardurbot/core";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import {
  refreshIntegrationCatalog,
  subscribeIntegrationCatalog,
} from "../../lib/integration-catalog-query";
import { MCP_OAUTH_CHANNEL } from "../../lib/mcp-oauth-channel";
import { rpc } from "../../lib/rpc";

export type ComposerMenuProps = {
  open: boolean;
  onCloseFocus: () => boolean | HTMLElement | null;
  shortcut: string;
  canAddFolder: boolean;
  skills: readonly ComposerSkill[];
  onFiles: () => void;
  onFolder: () => void;
  onSlash: () => void;
  onSkill: (skill: ComposerSkill) => void;
  onMention: (mention: ComposerMention) => void;
  onManage: (connectionId?: string) => void;
  onError: (message: string) => void;
};

export default function ComposerMenu(props: ComposerMenuProps) {
  const { t } = useLingui();
  const [integrations, setIntegrations] = useState<IntegrationCatalogList>({
    catalog: [],
    connections: [],
  });
  const [servers, setServers] = useState<McpServer[]>([]);
  const [reconnectCount, setReconnectCount] = useState(0);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeIntegrationCatalog((value) => {
      if (active) setIntegrations(value);
    });
    const refresh = () =>
      void refreshIntegrationCatalog().catch(() => {
        if (active) props.onError(t`Could not load integrations`);
      });
    refresh();
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = refresh;
    return () => {
      active = false;
      unsubscribe();
      channel.close();
    };
  }, [props.onError, t]);
  useEffect(() => {
    if (!props.open) return;
    let active = true;
    void rpc.mcp.servers
      .list()
      .then((value) => {
        if (active) setServers(value);
      })
      .catch(() => {
        if (active) props.onError(t`Could not load plugins`);
      });
    return () => {
      active = false;
    };
  }, [props.open, props.onError, t]);
  useEffect(() => {
    if (!props.open) return;
    let active = true;
    void rpc.connectors
      .summary()
      .then((summary) => {
        if (active) setReconnectCount(summary.needingReconnection);
      })
      .catch(() => {
        if (active) props.onError(t`Could not load integrations`);
      });
    return () => {
      active = false;
    };
  }, [props.open, integrations.connections, props.onError, t]);
  function selectConnector(descriptor: IntegrationDescriptor, connection: IntegrationConnection) {
    if (connection.state === "connected") {
      props.onMention({ kind: "mcp", id: connection.id, name: descriptor.name });
      return;
    }
    props.onManage(connection.id);
  }
  return (
    <DropdownMenuContent
      finalFocus={props.onCloseFocus}
      side="top"
      align="start"
      className="composer-popup w-72"
      aria-label={t`Add files or photos`}
    >
      <DropdownMenuItem onClick={props.onFiles}>
        {t`Add files or photos`}
        <DropdownMenuShortcut>{props.shortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {props.canAddFolder ? (
        <DropdownMenuItem onClick={props.onFolder}>{t`Add folder`}</DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={props.onSlash}>{t`Slash commands`}</DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {t`Integrations`}
          {reconnectCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              ({t`${reconnectCount} need reconnection`})
            </span>
          ) : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="composer-popup min-w-48">
          {integrations.connections.map((connection) => {
            const descriptor = integrations.catalog.find(
              (item) => item.id === connection.catalogId,
            );
            if (!descriptor) return null;
            const connected = connection.state === "connected";
            return (
              <DropdownMenuItem
                key={connection.id}
                onClick={() => void selectConnector(descriptor, connection)}
              >
                <span
                  role="img"
                  aria-label={connected ? t`Connected` : t`Needs reconnection`}
                  className={`size-1.5 shrink-0 rounded-full ${connected ? "bg-success" : "bg-warning"}`}
                />
                {descriptor.name}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem onClick={() => props.onManage()}>{t`Manage…`}</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{t`Plugins`}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="composer-popup min-w-48 max-h-72">
          {servers
            .filter(
              (server) =>
                !integrations.connections.some((connection) => connection.id === server.id),
            )
            .map((server) => (
              <DropdownMenuItem
                key={server.id}
                onClick={() => props.onMention({ kind: "mcp", id: server.id, name: server.name })}
              >
                {server.name}
              </DropdownMenuItem>
            ))}
          {props.skills.map((skill) => (
            <DropdownMenuItem key={skill.id} onClick={() => props.onSkill(skill)}>
              {skill.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => props.onManage()}>{t`Manage…`}</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  );
}
