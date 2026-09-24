import { Button, Dialog, DialogClose, DialogContent, DialogTitle, Input } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { LoadingState } from "../components/ai/primitives";
import {
  matchesSetting,
  SettingsSearchProvider,
  useSettingsSearch,
} from "../components/SettingsRow";
import { desktopBridge } from "../lib/desktop";
import { SETTINGS_GROUPS, settingsGroupLabels, settingsSections } from "./settings-sections";
import type { SettingsPageProps, SettingsSection } from "./settings-types";

export type { SettingsSection } from "./settings-types";

type Props = Omit<SettingsPageProps, "navigate" | "onBusyChange"> & {
  initialSection?: SettingsSection;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
};

export function SettingsOverlay({
  initialSection = "general",
  onVoiceStatusMaybeChanged,
  ...props
}: Props) {
  const { t, i18n } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [busy, setBusy] = useState(false);
  const search = useSettingsSearch();
  const context = {
    desktop: !!desktopBridge(),
    isDeploymentOwner: props.isDeploymentOwner === true,
  };
  const available = settingsSections.filter((item) => item.available(context));
  const active = available.find((item) => item.id === section) ?? available[0]!;
  const title = i18n._(active.label);
  const visible = available.filter(
    (item) =>
      matchesSetting(i18n._(item.label), search.query) ||
      (item.id === active.id && search.rowMatch),
  );
  const Page = active.component;
  useEffect(() => setSection(initialSection), [initialSection]);
  function navigate(next: SettingsSection) {
    if (busy) return;
    search.setQuery("");
    setSection(next);
  }
  function close() {
    if (busy) return;
    props.onClose();
    void Promise.resolve(onVoiceStatusMaybeChanged?.()).catch(() => undefined);
  }
  const closeLabel =
    active.id === "models"
      ? t`Close model settings`
      : active.id === "memory"
        ? t`Close memory settings`
        : active.id === "voice"
          ? t`Close voice settings`
          : t`Close user settings`;
  const fullPane = ["models", "memory", "capabilities", "voice"].includes(active.id);
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) details.cancel();
        else close();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={active.id}
        showCloseButton={false}
        initialFocus={() => panelRef.current}
        className="flex h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[1080px]"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            data-testid="settings-nav"
            aria-label={t`Settings`}
            className="flex max-h-[35vh] shrink-0 flex-col gap-3 overflow-y-auto border-b border-border p-3 md:max-h-none md:w-56 md:border-b-0 md:border-e"
          >
            <Input
              type="search"
              aria-label={t`Search settings`}
              placeholder={t`Search settings`}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
            />
            {SETTINGS_GROUPS.map((group) => {
              const items = visible.filter((item) => item.group === group);
              if (!items.length) return null;
              return (
                <fieldset
                  key={group}
                  className="min-w-0"
                  aria-label={i18n._(settingsGroupLabels[group])}
                >
                  <div className="px-2 pb-1 text-xs text-muted-foreground">
                    {i18n._(settingsGroupLabels[group])}
                  </div>
                  {items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Button
                        key={item.id}
                        variant="ghost"
                        data-testid={`settings-nav-${item.id}`}
                        aria-current={active.id === item.id ? "page" : undefined}
                        disabled={busy}
                        onClick={() => navigate(item.id)}
                        className={`w-full justify-start gap-2 text-sm ${active.id === item.id ? "bg-muted" : "text-muted-foreground"}`}
                      >
                        <Icon className="size-4" strokeWidth={1.75} />
                        {i18n._(item.label)}
                      </Button>
                    );
                  })}
                </fieldset>
              );
            })}
            {!visible.length ? (
              <p className="px-2 text-sm text-muted-foreground">{t`No settings found.`}</p>
            ) : null}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-4 px-6 pt-6">
              <DialogTitle className="text-2xl font-medium">{title}</DialogTitle>
              <DialogClose
                aria-label={closeLabel}
                disabled={busy}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
              </DialogClose>
            </div>
            <div
              className={`min-h-0 flex-1 ${fullPane ? "flex flex-col overflow-hidden" : "rk-scroll overflow-y-auto px-6 pb-6 pt-2"}`}
            >
              <SettingsSearchProvider
                query={search.query}
                sectionLabel={title}
                register={search.register}
              >
                <Suspense fallback={<LoadingState label={t`Loading…`} />}>
                  <Page
                    key={active.id}
                    {...props}
                    onClose={close}
                    onBusyChange={setBusy}
                    navigate={navigate}
                  />
                </Suspense>
              </SettingsSearchProvider>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
