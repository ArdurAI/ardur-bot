// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { activateUiLocale, resetI18nForTests } from "../lib/i18n";
import { RU_MESSAGES } from "../lib/locales/ru";
import { ZH_MESSAGES } from "../lib/locales/zh";
import { ComposerRecipients } from "./composer-recipients";

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("span", { "data-testid": testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  resetI18nForTests();
});
it("renders the actual native labels and updates the phone language", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetI18nForTests("ru");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ComposerRecipients names={["Alpha", "Beta"]} queued={["Beta"]} color="currentColor" />,
    ),
  );
  expect(container.querySelector('[data-testid="composer-recipients"]')?.textContent).toBe(
    RU_MESSAGES["To {names}"]?.replace("{names}", "Alpha, Beta"),
  );
  expect(container.querySelector('[data-testid="composer-queued"]')?.textContent).toBe(
    RU_MESSAGES["Queued: {queued}"]?.replace("{queued}", "Beta"),
  );
  await act(async () => activateUiLocale("zh-CN"));
  expect(container.querySelector('[data-testid="composer-recipients"]')?.textContent).toBe(
    ZH_MESSAGES["To {names}"]?.replace("{names}", "Alpha, Beta"),
  );
  await act(async () =>
    root.render(<ComposerRecipients names={[]} queued={[]} color="currentColor" />),
  );
  expect(container.textContent).toBe("");
});
