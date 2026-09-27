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
          (result, part, index) => result + part + (index < values.length ? `{${index}}` : ""),
          "",
        );
        return i18n._({
          id: message,
          message,
          values: Object.fromEntries(values.map((value, index) => [index, value])),
        });
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

it("translates the registry's model error without a reason identifier", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog = readFileSync(
    join(process.cwd(), "apps/web/src/locales/zh-CN/messages.po"),
    "utf8",
  );
  const message = "Antigravity did not recognise the model {0}. Pick a model from its list.";
  const translation = catalog.match(
    /msgid "Antigravity did not recognise the model \{0\}\. Pick a model from its list\."\nmsgstr "([^"]+)"/,
  )?.[1];
  expect(translation).toBe("Antigravity 无法识别模型 {0}。请从其列表中选择模型。");
  i18n.load("zh-CN", { [message]: translation! });
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
    "pin-model-unknown",
    "The pinned model is unavailable in this runtime.",
  );
  expect(problem.reasonId).toBeUndefined();
  await act(async () => {
    root.render(<ProviderErrorMessage text="" runtimeProblem={problem} />);
  });
  expect(element.textContent).toContain("无法识别模型 gemini-3.8-flash-low");
  await act(async () => root.unmount());
});
