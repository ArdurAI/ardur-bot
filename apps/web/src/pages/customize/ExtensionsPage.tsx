import type {
  DesktopExtension,
  ExtensionPreview,
  IntegrationDescriptor,
} from "@ardurbot/contracts";
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Blocks, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import type { SettingsPageProps } from "../settings-types";
import { ConfigureExtension } from "./ConfigureExtension";
import { EmptyList, ListSection, PageError, RowMenu } from "./CustomizeControls";
import { ensureCustomizationHost } from "./native";

export default function ExtensionsPage({
  navigate,
  onBusyChange,
}: Partial<Pick<SettingsPageProps, "navigate" | "onBusyChange">>) {
  const { t } = useLingui();
  const bridge = desktopBridge()?.customization;
  const [items, setItems] = useState<DesktopExtension[]>([]);
  const [preview, setPreview] = useState<ExtensionPreview | null>(null);
  const [configuring, setConfiguring] = useState<DesktopExtension | null>(null);
  const [catalog, setCatalog] = useState<IntegrationDescriptor[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setItems(await bridge.list(selectedSpaceId()));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    setFailed(false);
    try {
      await run();
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  if (!bridge)
    return (
      <p className="text-sm text-muted-foreground">{t`Open the desktop app to manage extensions.`}</p>
    );
  return (
    <section className="flex min-h-96 flex-col gap-6" aria-label={t`Extensions`}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t`Allow the assistant to directly interact with apps, data, and tools on your computer`}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () =>
                setCatalog(
                  (await rpc.integrations.list()).catalog.filter(
                    (item) => item.transport === "stdio",
                  ),
                ),
              )
            }
          >{t`Browse extensions`}</Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => setPreview(await bridge.prepare(selectedSpaceId())))
            }
          >
            <Plus />
            {t`Add`}
          </Button>
        </div>
      </div>
      {failed ? <PageError retry={() => void refresh()} /> : null}
      <ListSection title={t`Installed on your computer`} count={items.length}>
        {items.length ? (
          items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 py-3">
              <Blocks className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="truncate text-xs text-muted-foreground">{item.description}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || item.state !== "installed"}
                onClick={() => setConfiguring(item)}
              >{t`Configure`}</Button>
              <RowMenu
                name={item.name}
                disabled={busy}
                actions={[
                  {
                    label: t`Uninstall`,
                    action: () => void action(() => bridge.uninstall(selectedSpaceId(), item.id)),
                  },
                ]}
              />
            </div>
          ))
        ) : (
          <EmptyList />
        )}
      </ListSection>
      <Button
        className="self-start"
        variant="ghost"
        onClick={() => navigate?.("mcp")}
      >{t`Advanced settings`}</Button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void action(async () => setPreview(await bridge.prepare(selectedSpaceId())))}
        className={`mt-auto rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground ${dragging ? "bg-accent" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file && !busy)
            void action(async () => setPreview(await bridge.prepareDrop(selectedSpaceId(), file)));
        }}
      >
        {t`Drag .MCPB or .DXT files here to install`}
      </button>
      {preview ? (
        <ConfigureExtension
          installing
          name={preview.name}
          fields={preview.fields}
          onClose={() => {
            void bridge.cancel(selectedSpaceId(), preview.id);
            setPreview(null);
          }}
          onSave={async (values) => {
            await ensureCustomizationHost();
            await bridge.install(selectedSpaceId(), preview.id, values);
            await refresh();
          }}
          pickPath={(field) =>
            bridge.selectPaths(
              field.type === "directory" ? "directory" : "file",
              Boolean(field.multiple),
            )
          }
        />
      ) : null}
      {configuring ? (
        <ConfigureExtension
          name={configuring.name}
          fields={configuring.fields}
          onClose={() => setConfiguring(null)}
          onSave={async (values) => {
            await bridge.configure(selectedSpaceId(), configuring.id, values);
            await refresh();
          }}
          pickPath={(field) =>
            bridge.selectPaths(
              field.type === "directory" ? "directory" : "file",
              Boolean(field.multiple),
            )
          }
        />
      ) : null}
      {catalog ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setCatalog(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t`Browse extensions`}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {catalog.length ? (
                catalog.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-3"
                  >
                    <Blocks className="size-5" />
                    <div className="flex-1 text-sm">
                      {item.name}
                      <p className="text-xs text-muted-foreground">{item.vendor}</p>
                    </div>
                    <Badge variant="secondary">{t`Included`}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!item.available}
                      onClick={() => {
                        setCatalog(null);
                        navigate?.("integrations");
                      }}
                    >{t`Open`}</Button>
                  </div>
                ))
              ) : (
                <EmptyList />
              )}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
