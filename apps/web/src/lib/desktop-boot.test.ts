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

it("sends the theme as soon as it is known, and sends again only when it changes", async () => {
  const { rememberDesktopBoot } = await import("./desktop-boot");
  rememberDesktopBoot({ theme: "light" });
  expect(save).toHaveBeenCalledExactlyOnceWith({ theme: "light" });

  rememberDesktopBoot({ theme: "light" });
  expect(save).toHaveBeenCalledOnce();

  rememberDesktopBoot({ theme: "dark" });
  expect(save.mock.calls).toEqual([[{ theme: "light" }], [{ theme: "dark" }]]);
});

it("sends the same theme again after a save failed", async () => {
  const { rememberDesktopBoot } = await import("./desktop-boot");
  save.mockRejectedValueOnce(new Error("The app is closing."));
  rememberDesktopBoot({ theme: "system" });
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));

  rememberDesktopBoot({ theme: "system" });
  expect(save).toHaveBeenCalledTimes(2);
});

it("does nothing in a browser", async () => {
  vi.stubGlobal("window", {});
  const { rememberDesktopBoot } = await import("./desktop-boot");
  expect(() => rememberDesktopBoot({ theme: "dark" })).not.toThrow();
});

it("records the account theme the app applies", async () => {
  const { setUiAppearance } = await import("./ui-appearance");
  setUiAppearance("light");
  expect(save).toHaveBeenCalledExactlyOnceWith({ theme: "light" });

  // Applying the same value again sends nothing.
  setUiAppearance("light");
  expect(save).toHaveBeenCalledOnce();

  setUiAppearance("dark");
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ theme: "dark" });
});
