import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./apply-ui-direction", () => ({ applyUiDirection: vi.fn() }));

const save = vi.fn(async (_snapshot: unknown) => undefined);

beforeEach(() => {
  // Each test starts with a renderer that has sent nothing yet.
  vi.resetModules();
  save.mockClear();
  vi.stubGlobal("window", {
    ardurbotDesktop: { boot: { save } },
    matchMedia: () => ({ matches: false }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("sends the theme and language once both are known, then only when one changes", async () => {
  const { rememberDesktopBoot } = await import("./desktop-boot");
  rememberDesktopBoot({ theme: "light" });
  expect(save).not.toHaveBeenCalled();

  rememberDesktopBoot({ language: "de" });
  rememberDesktopBoot({ theme: "light" });
  rememberDesktopBoot({ language: "de", theme: "light" });
  expect(save).toHaveBeenCalledExactlyOnceWith({ theme: "light", language: "de" });

  rememberDesktopBoot({ theme: "dark" });
  rememberDesktopBoot({ language: "ko" });
  expect(save.mock.calls).toEqual([
    [{ theme: "light", language: "de" }],
    [{ theme: "dark", language: "de" }],
    [{ theme: "dark", language: "ko" }],
  ]);
});

it("sends the same values again after a save failed", async () => {
  const { rememberDesktopBoot } = await import("./desktop-boot");
  save.mockRejectedValueOnce(new Error("The app is closing."));
  rememberDesktopBoot({ theme: "system", language: "en" });
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));

  rememberDesktopBoot({ theme: "system" });
  expect(save).toHaveBeenCalledTimes(2);
});

it("does nothing in a browser", async () => {
  vi.stubGlobal("window", {});
  const { rememberDesktopBoot } = await import("./desktop-boot");
  expect(() => rememberDesktopBoot({ theme: "dark", language: "en" })).not.toThrow();
});

it("records the account theme the app applies and the language on screen", async () => {
  const { setUiAppearance } = await import("./ui-appearance");
  const { activateUiLocale, setCatalogLoadersForTests } = await import("./i18n");
  const empty = async () => ({ messages: {} });
  setCatalogLoadersForTests({
    en: empty,
    de: empty,
    ko: empty,
    tr: empty,
    hi: empty,
    "pt-BR": empty,
    "zh-CN": empty,
    es: empty,
    ru: empty,
  });

  await activateUiLocale("de");
  expect(save).not.toHaveBeenCalled();
  setUiAppearance("light");
  expect(save).toHaveBeenCalledExactlyOnceWith({ theme: "light", language: "de" });

  // Applying the same values again sends nothing.
  setUiAppearance("light");
  await activateUiLocale("de");
  expect(save).toHaveBeenCalledOnce();
});
