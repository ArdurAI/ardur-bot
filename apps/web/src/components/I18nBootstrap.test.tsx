// @vitest-environment jsdom
import { useLingui } from "@lingui/react";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateUiLocale, bootstrapI18n, setCatalogLoadersForTests } from "../lib/i18n";
import type { UiLocale } from "../lib/ui-locale";
import { UI_LOCALE_STORAGE_KEY } from "../lib/ui-locale";
import { I18nBootstrap } from "./I18nBootstrap";

type Catalog = { messages: Record<string, string> };
type Loader = () => Promise<Catalog>;

const SETTINGS: Partial<Record<UiLocale, string>> = { en: "Settings", de: "Einstellungen" };

function loaders(overrides: Partial<Record<UiLocale, Loader>> = {}): Record<UiLocale, Loader> {
  const load = (locale: UiLocale): Loader => {
    const text = SETTINGS[locale];
    const messages: Record<string, string> = text ? { Settings: text } : {};
    return overrides[locale] ?? (async () => ({ messages }));
  };
  return {
    en: load("en"),
    de: load("de"),
    ko: load("ko"),
    tr: load("tr"),
    hi: load("hi"),
    "pt-BR": load("pt-BR"),
    "zh-CN": load("zh-CN"),
    es: load("es"),
    ru: load("ru"),
  };
}

function Label() {
  const { i18n } = useLingui();
  return <p>{i18n._("Settings")}</p>;
}

const mounted: Array<() => void> = [];

function mount(children: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<I18nBootstrap>{children}</I18nBootstrap>));
  mounted.push(() => act(() => root.unmount()));
  return container;
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  setCatalogLoadersForTests(null);
  vi.unstubAllGlobals();
});

it("renders nothing in English while the saved language is still loading", async () => {
  let loadGerman: (catalog: Catalog) => void = () => undefined;
  const german = new Promise<Catalog>((resolve) => {
    loadGerman = resolve;
  });
  setCatalogLoadersForTests(loaders({ de: () => german }));
  // This window last showed English; German was chosen since, in another window.
  await activateUiLocale("en");
  localStorage.setItem(UI_LOCALE_STORAGE_KEY, "de");

  const view = mount(<Label />);
  expect(view.textContent).toBe("");
  expect(view.querySelector('[data-ardur-app-state="i18n-pending"]')).not.toBeNull();

  await act(async () => loadGerman({ messages: { Settings: "Einstellungen" } }));
  expect(view.textContent).toBe("Einstellungen");
});

it("shows the saved language on the first frame when its catalog loaded before React", async () => {
  const german = vi.fn(async () => ({ messages: { Settings: "Einstellungen" } }));
  setCatalogLoadersForTests(loaders({ de: german }));
  localStorage.setItem(UI_LOCALE_STORAGE_KEY, "de");
  await bootstrapI18n();

  const view = mount(<Label />);
  expect(view.textContent).toBe("Einstellungen");
  expect(view.querySelector('[data-ardur-app-state="i18n-pending"]')).toBeNull();
  expect(german).toHaveBeenCalledOnce();
});

it("keeps the English fallback on the first frame when the saved catalog failed to load", async () => {
  const german = vi.fn(async (): Promise<Catalog> => {
    throw new Error("catalog unavailable");
  });
  setCatalogLoadersForTests(loaders({ de: german }));
  localStorage.setItem(UI_LOCALE_STORAGE_KEY, "de");
  await bootstrapI18n();

  const view = mount(<Label />);
  expect(view.textContent).toBe("Settings");
  expect(german).toHaveBeenCalledOnce();
});

it("waits for the saved language when nothing was loaded before React", async () => {
  setCatalogLoadersForTests(loaders());
  localStorage.setItem(UI_LOCALE_STORAGE_KEY, "de");

  const view = mount(<Label />);
  expect(view.textContent).toBe("");

  await act(async () => undefined);
  expect(view.textContent).toBe("Einstellungen");
});
