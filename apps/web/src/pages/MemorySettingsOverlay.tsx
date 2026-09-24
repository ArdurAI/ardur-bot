import type { MemoryImportPreview, SpaceMemoryConfig } from "@ardurbot/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { SpaceMemorySection } from "./KnowledgeSection";
import type { MemoryProviderConnectionDraft } from "./memory-providers/registry";
import {
  defaultMemoryProviderSettings,
  MEMORY_PROVIDER_SETTINGS,
  memoryProviderSettings,
} from "./memory-providers/registry";

type Location = "postgres" | "obsidian" | "service";
function configuredLocation(config: SpaceMemoryConfig | null | undefined): Location {
  return config?.provider && config.provider !== "builtin"
    ? "service"
    : config?.documentStore === "obsidian"
      ? "obsidian"
      : "postgres";
}
export function MemorySettingsOverlay({
  onClose,
  config,
  onConfigChange,
  embedded = false,
  onBusyChange,
}: {
  onClose: () => void;
  config: SpaceMemoryConfig | null | undefined;
  onConfigChange: (config: SpaceMemoryConfig | null) => void;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const locationId = useId();
  const scopeId = useId();
  const [location, setLocation] = useState<Location>(() => configuredLocation(config));
  const [provider, setProvider] = useState(
    config?.provider && config.provider !== "builtin"
      ? config.provider
      : defaultMemoryProviderSettings().id,
  );
  const [scope, setScope] = useState<"isolated" | "shared">(
    config?.defaultMemoryScope ?? "isolated",
  );
  const [folder, setFolder] = useState(config?.documentSettings.folder ?? "");
  const [localDesktop, setLocalDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MemoryImportPreview | null>(null);
  const [pendingConnection, setPendingConnection] = useState<MemoryProviderConnectionDraft | null>(
    null,
  );
  const [refresh, setRefresh] = useState(0);
  const registration = memoryProviderSettings(provider);
  useEffect(() => {
    let active = true;
    void window.ardurbotDesktop?.memoryFolders
      ?.available()
      .then((available) => {
        if (active) setLocalDesktop(available);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setLocation(configuredLocation(config));
    setFolder(config?.documentSettings.folder ?? "");
    setScope(config?.defaultMemoryScope ?? "isolated");
    setPreview(null);
  }, [config]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function chooseFolder() {
    setBusy(true);
    setError(null);
    try {
      const me = await rpc.me();
      const selected = await window.ardurbotDesktop?.memoryFolders?.select(me.spaceId);
      if (selected) {
        setFolder(selected.path);
        setPreview(null);
      }
    } catch {
      setError(t`Could not attach the folder. Retry.`);
    } finally {
      setBusy(false);
    }
  }
  async function migrate(write: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.memory.location({
        location: location === "obsidian" ? "obsidian" : "postgres",
        ...(location === "obsidian" ? { folder } : {}),
        expectedGeneration: config?.generation ?? 0,
        ...(write && preview ? { expectedHash: preview.hash } : {}),
      });
      if (result.config) {
        onConfigChange(result.config);
        setRefresh((value) => value + 1);
        setPreview(null);
      } else setPreview(result);
    } catch {
      setError(t`Could not change memory location. Check the folder and preview again.`);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function connect(draft: MemoryProviderConnectionDraft) {
    if (!registration) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.memory.location({
        location: "postgres",
        expectedGeneration: config?.generation ?? 0,
      });
      setPreview(result);
      setPendingConnection(draft);
      return false;
    } catch {
      setError(t`Could not connect the memory service. Check the connection and retry.`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function confirmConnection() {
    if (!pendingConnection || !preview || !registration) return;
    setBusy(true);
    setError(null);
    try {
      const next = await rpc.memory.connectProvider({
        provider: registration.id,
        ...pendingConnection,
        defaultMemoryScope: scope,
        expectedGeneration: config?.generation ?? 0,
        expectedHash: preview.hash,
      });
      onConfigChange(next);
      setPendingConnection(null);
      setPreview(null);
      setRefresh((value) => value + 1);
    } catch {
      setError(t`Could not connect the memory service. Preview again and retry.`);
      setPreview(null);
      setPendingConnection(null);
    } finally {
      setBusy(false);
    }
  }
  async function changeScope(value: "isolated" | "shared") {
    setScope(value);
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      onConfigChange(await rpc.memory.setDefaultScope({ defaultMemoryScope: value }));
    } catch {
      setError(t`Could not change the default scope. Retry.`);
    } finally {
      setBusy(false);
    }
  }
  const activeLocation = configuredLocation(config);
  const changed =
    location !== activeLocation ||
    (location === "obsidian" && folder !== config?.documentSettings.folder);
  const locationLine =
    activeLocation === "service"
      ? (memoryProviderSettings(config!.provider)?.name ?? config!.provider)
      : localDesktop
        ? t`On this device`
        : t`On your server`;
  const body = (
    <>
      {!embedded ? (
        <div className="flex items-center justify-between px-6 pt-6">
          <div>
            <DialogTitle>
              <Trans>Memory</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Memory location and documents</Trans>
            </DialogDescription>
          </div>
          <DialogClose
            aria-label={t`Close memory settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
      ) : null}
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <label htmlFor={locationId} className="text-sm">
          <Trans>Memory location</Trans>
        </label>
        <NativeSelect
          id={locationId}
          className="mt-2 w-full"
          value={location}
          disabled={busy || config === undefined}
          onChange={(event) => {
            setLocation(event.target.value as Location);
            setPreview(null);
            setPendingConnection(null);
          }}
        >
          <NativeSelectOption value="postgres">
            <Trans>Built-in</Trans>
          </NativeSelectOption>
          <NativeSelectOption value="obsidian">
            <Trans>Obsidian vault</Trans>
          </NativeSelectOption>
          <NativeSelectOption value="git" disabled>
            <Trans>Git repository</Trans>
          </NativeSelectOption>
          <NativeSelectOption value="service">
            <Trans>Another service</Trans>
          </NativeSelectOption>
        </NativeSelect>
        <p className="mt-2 text-sm text-muted-foreground">{locationLine}</p>
        <details className="mt-2 text-xs text-muted-foreground">
          <summary>
            <Trans>Details</Trans>
          </summary>
          <p>
            <Trans>Git repository: Coming next.</Trans>
          </p>
          <p>
            {activeLocation === "service"
              ? t`Indexing sends documents to ${locationLine}.`
              : t`No embedding service is configured.`}
          </p>
          {activeLocation === "service" ? (
            <p>
              <Trans>
                The service may use its own embedding providers. Check its settings before saving
                private documents.
              </Trans>
            </p>
          ) : null}
          <label htmlFor={scopeId}>
            <Trans>Default scope</Trans>
            <NativeSelect
              id={scopeId}
              value={scope}
              disabled={busy}
              onChange={(event) => void changeScope(event.target.value as "isolated" | "shared")}
            >
              <NativeSelectOption value="isolated">
                <Trans>Private to each bot</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="shared">
                <Trans>Space shared</Trans>
              </NativeSelectOption>
            </NativeSelect>
          </label>
          <p>
            <Trans>Existing documents keep their scope.</Trans>
          </p>
          {activeLocation === "service" ? (
            <p>
              <Trans>Credentials are stored encrypted on your server.</Trans>
            </p>
          ) : null}
          {location === "obsidian" ? (
            <p>
              <Trans>Obsidian Sync may copy this folder to your other devices</Trans>
            </p>
          ) : null}
        </details>
        {location === "obsidian" ? (
          <div className="mt-4 space-y-2">
            {localDesktop ? (
              <Button variant="outline" disabled={busy} onClick={() => void chooseFolder()}>
                <Trans>Choose folder</Trans>
              </Button>
            ) : (
              <>
                <Input
                  aria-label={t`Memory folder on your server`}
                  value={folder}
                  disabled={busy}
                  onChange={(event) => {
                    setFolder(event.target.value);
                    setPreview(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>This path is on your server, which may be a different machine.</Trans>
                </p>
              </>
            )}
            {folder ? <p className="break-all text-xs text-muted-foreground">{folder}</p> : null}
          </div>
        ) : null}
        {changed && location !== "service" ? (
          <div className="mt-3 space-y-2">
            <Button
              variant="outline"
              disabled={busy || (location === "obsidian" && !folder)}
              onClick={() => void migrate(false)}
            >
              <Trans>Preview migration</Trans>
            </Button>
            {preview ? (
              <>
                <p className="text-sm">
                  <Trans>
                    {preview.documents} documents, {preview.revisions} revisions
                  </Trans>
                </p>
                <p className="break-all font-mono text-xs">{preview.hash}</p>
                {preview.conflicts.map((conflict) => (
                  <p key={conflict.id} className="text-sm text-destructive">
                    <Trans>Conflict: {conflict.path}</Trans>
                  </p>
                ))}
                <Button
                  disabled={busy || preview.conflicts.length > 0}
                  onClick={() => void migrate(true)}
                >
                  <Trans>Use this location</Trans>
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {location === "service" ? (
          <div className="mt-4 space-y-3">
            <NativeSelect
              aria-label={t`Memory service`}
              value={provider}
              disabled={busy}
              onChange={(event) => {
                setProvider(event.target.value);
                setPendingConnection(null);
                setPreview(null);
              }}
            >
              {MEMORY_PROVIDER_SETTINGS.map((entry) => (
                <NativeSelectOption key={entry.id} value={entry.id}>
                  {entry.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {registration ? <registration.SettingsForm busy={busy} onConnect={connect} /> : null}
            {pendingConnection && preview ? (
              <div className="space-y-2">
                <p>
                  <Trans>
                    {preview.documents} documents, {preview.revisions} revisions
                  </Trans>
                </p>
                <p className="break-all font-mono text-xs">{preview.hash}</p>
                <Button
                  disabled={busy || preview.conflicts.length > 0}
                  onClick={() => void confirmConnection()}
                >
                  <Trans>Use this location</Trans>
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <SpaceMemorySection key={refresh} />
      </div>
    </>
  );
  if (embedded)
    return (
      <div data-testid="memory-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          if (busy) details.cancel();
          else onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(760px,calc(100%-2rem))] w-[560px] flex-col gap-0 overflow-hidden p-0"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
