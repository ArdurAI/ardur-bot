// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePinProblem } from "@ardurbot/contracts";
import { i18n } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderErrorMessage } from "./provider-error-message";

vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("@lingui/react/macro", async () => {
  const { i18n } = await import("@lingui/core");
  return {
    useLingui: () => ({
      t: (parts: TemplateStringsArray, ...values: unknown[]) => {
        const message = parts.reduce(
          (result, part, index) => result + part + (values[index] ?? ""),
          "",
        );
        return i18n._({ id: message, message });
      },
    }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

afterEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

it("translates an ordinary runtime timeout in Simplified Chinese", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog = readFileSync(
    join(process.cwd(), "apps/web/src/locales/zh-CN/messages.po"),
    "utf8",
  );
  const translation = catalog.match(
    /msgid "Antigravity did not finish in time\. Try again\."\nmsgstr "([^"]+)"/,
  )?.[1];
  expect(translation).toBe("Antigravity 未能按时完成。请重试。");
  i18n.load("zh-CN", { "Antigravity did not finish in time. Try again.": translation! });
  i18n.activate("zh-CN");
  const element = document.createElement("div");
  const root = createRoot(element);
  const problem = runtimePinProblem(
    {
      runtimeKind: "antigravity",
      provider: "antigravity",
      modelId: "gemini-3.8-flash-low",
      effort: "low",
      credentialId: "native:antigravity",
      revision: 1,
    },
    "runtime-unavailable",
    "Antigravity did not finish in time. Try again.",
    "timeout",
  );
  await act(async () => {
    root.render(<ProviderErrorMessage text="" runtimeProblem={problem} />);
  });
  expect(element.textContent).toContain("Antigravity 未能按时完成。请重试。");
  await act(async () => root.unmount());
});
