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
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react/macro", async () => {
  const { i18n } = await import("@lingui/core");
  const translate = (
    parts: TemplateStringsArray | { id: string; message?: string },
    ...values: unknown[]
  ) => {
    if (typeof parts === "object" && "id" in parts && !Array.isArray(parts))
      return i18n._({
        id: parts.id,
        message: parts.message ?? parts.id,
        values: (values[0] ?? {}) as Record<string, unknown>,
      });
    const message = (parts as TemplateStringsArray).reduce(
      (result, part, index) => result + part + (index < values.length ? `{${index}}` : ""),
      "",
    );
    return i18n._({
      id: message,
      message,
      values: Object.fromEntries(values.map((value, index) => [index, value])),
    });
  };
  return {
    useLingui: () => ({ t: translate, i18n }),
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

function nativePin(runtimeKind: "claude-code" | "codex-app-server" | "hermes") {
  return {
    runtimeKind,
    provider: `${runtimeKind}-provider`,
    modelId: "fixture-model",
    effort: "high",
    credentialId: `native:${runtimeKind}`,
    revision: 1,
  };
}

it("renders a translated Hermes session-start failure without protocol detail", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const message = "{runtime} could not start a session. Check the runtime and try again.";
  i18n.load("zh-CN", { [message]: "{runtime} 无法启动会话。请检查运行环境后重试。" });
  i18n.activate("zh-CN");
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <ProviderErrorMessage
          text="private protocol detail"
          runtimeProblem={runtimePinProblem(
            nativePin("hermes"),
            "runtime-unavailable",
            "Hermes could not start a session. Check the runtime and try again.",
            "session-start-failed",
          )}
        />,
      ),
    );
    expect(element.textContent).toContain("Hermes 无法启动会话。请检查运行环境后重试。");
    expect(element.textContent).not.toContain("private protocol detail");
  } finally {
    await act(async () => root.unmount());
  }
});

it("renders the pinned context floor with model recovery and no protocol detail", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const message =
    "{runtime} needs a model with at least 64K context; change the model and try again.";
  i18n.load("zh-CN", { [message]: "{runtime} 需要上下文至少为 64K 的模型；请更换模型后重试。" });
  i18n.activate("zh-CN");
  const element = document.createElement("div");
  const root = createRoot(element);
  const onChangeModel = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ProviderErrorMessage
          text="private protocol detail"
          onChangeModel={onChangeModel}
          runtimeProblem={runtimePinProblem(
            nativePin("hermes"),
            "runtime-unavailable",
            "Hermes needs a model with at least 64K context; change the model and try again.",
            "model-context-too-small",
          )}
        />,
      ),
    );
    expect(element.textContent).toContain("Hermes 需要上下文至少为 64K 的模型；请更换模型后重试。");
    expect(element.textContent).not.toContain("private protocol detail");
    const button = element.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(onChangeModel).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["claude-code", "Claude Code"],
  ["codex-app-server", "Codex"],
] as const)("renders each classified cause for a %s pin", async (runtimeKind, runtimeName) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const [reasonId, text] of [
    ["usage-limit", `${runtimeName}'s usage limit is reached. Try again after it resets.`],
    ["signed-out", `Sign in to ${runtimeName} on this computer, then try again.`],
    ["max-turns", `${runtimeName} reached this run's turn limit. Narrow the task and try again.`],
  ] as const) {
    const element = document.createElement("div");
    const root = createRoot(element);
    const problem = runtimePinProblem(
      nativePin(runtimeKind),
      "runtime-unavailable",
      text,
      reasonId,
    );
    await act(async () => {
      root.render(<ProviderErrorMessage text="" runtimeProblem={problem} />);
    });
    expect(element.textContent, reasonId).toContain(text);
    await act(async () => root.unmount());
  }
});

it("renders a classified cause for a Hermes pin, translated, with no English", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog = readFileSync(
    join(process.cwd(), "apps/web/src/locales/zh-CN/messages.po"),
    "utf8",
  );
  const translation = catalog.match(
    /msgid "\{runtime\}'s usage limit is reached\. Try again after it resets\."\nmsgstr "([^"]+)"/,
  )?.[1];
  expect(translation).toBeTruthy();
  i18n.load("zh-CN", {
    "{runtime}'s usage limit is reached. Try again after it resets.": translation!,
  });
  i18n.activate("zh-CN");
  const element = document.createElement("div");
  const root = createRoot(element);
  const problem = runtimePinProblem(
    nativePin("hermes"),
    "runtime-unavailable",
    "Hermes's usage limit is reached. Try again after it resets.",
    "usage-limit",
  );
  await act(async () => {
    root.render(<ProviderErrorMessage text="" runtimeProblem={problem} />);
  });
  expect(element.textContent).toContain("Hermes 的用量已达上限");
  expect(element.textContent).not.toContain("usage limit");
  await act(async () => root.unmount());
});

it("maps an older record's stored sentence back to its category for rendering", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  // A pre-classification record: the generic sentence, stored verbatim, no reason id.
  const problem = runtimePinProblem(
    nativePin("claude-code"),
    "runtime-unavailable",
    "Claude Code could not finish this run — connect it or change the pin.",
  );
  await act(async () => {
    root.render(<ProviderErrorMessage text="" runtimeProblem={problem} />);
  });
  expect(element.textContent).toContain(
    "Claude Code could not finish this run. Check the runtime or change the pin.",
  );
  await act(async () => root.unmount());
});

function refusalPin() {
  return {
    runtimeKind: "codex-app-server" as const,
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    effort: "medium",
    credentialId: "native:codex-app-server",
    revision: 1,
  };
}

it.each([
  [
    "experimental-off",
    "Codex is experimental. Turn on Experimental for Reviewer to use it.",
    ["Turn on Experimental", "Change pin"],
  ],
  [
    "computer-unsupported",
    "Codex runs on the host computer, not in a sandbox. Change Reviewer's computer to use it.",
    ["Open bot settings", "Change pin"],
  ],
  [
    "destinations-bot",
    "Reviewer's allowed model destinations block this model. Change them in Reviewer's settings.",
    ["Open bot settings", "Change pin"],
  ],
  [
    "destinations-space",
    "This space's model policy blocks this model. Change it in Settings, under Models.",
    ["Open Settings", "Change pin"],
  ],
] as const)(
  "shows the refusal's sentence and one button per action: %s",
  async (reasonId, sentence, labels) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const element = document.createElement("div");
    const root = createRoot(element);
    const problem = runtimePinProblem(
      refusalPin(),
      reasonId === "experimental-off" ? "runtime-unavailable" : "locality-denied",
      "recorded sentence",
      reasonId,
    );
    const enableExperimental = vi.fn();
    const openBotDestinations = vi.fn();
    const openBotComputer = vi.fn();
    const openSpaceModels = vi.fn();
    await act(async () => {
      root.render(
        <ProviderErrorMessage
          text=""
          runtimeProblem={problem}
          botName="Reviewer"
          onChangeModel={vi.fn()}
          onEnableExperimental={enableExperimental}
          onOpenBotDestinations={openBotDestinations}
          onOpenBotComputer={openBotComputer}
          onOpenSpaceModels={openSpaceModels}
        />,
      );
    });
    expect(element.textContent).toContain(sentence);
    const buttons = [...element.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(labels);
    await act(async () => root.unmount());
  },
);

it("turns on Experimental for the named bot from the banner", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const problem = runtimePinProblem(
    refusalPin(),
    "runtime-unavailable",
    "Codex is experimental. Turn on Experimental for this bot to use it.",
    "experimental-off",
  );
  const enableExperimental = vi.fn();
  await act(async () => {
    root.render(
      <ProviderErrorMessage
        text=""
        runtimeProblem={problem}
        botName="Reviewer"
        onEnableExperimental={enableExperimental}
      />,
    );
  });
  const button = [...element.querySelectorAll("button")].find(
    (item) => item.textContent === "Turn on Experimental",
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  expect(enableExperimental).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("keeps an unclassified refusal exactly as an older server wrote it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const problem = runtimePinProblem(
    refusalPin(),
    "locality-denied",
    "This bot may only run locally — change the pin or the space policy",
  );
  const onChangeModel = vi.fn();
  await act(async () => {
    root.render(
      <ProviderErrorMessage text="" runtimeProblem={problem} onChangeModel={onChangeModel} />,
    );
  });
  expect(element.textContent).toContain(
    "This bot may only run locally — change the pin or the space policy",
  );
  const buttons = [...element.querySelectorAll("button")].map((button) => button.textContent);
  expect(buttons).toEqual(["Change pin"]);
  await act(async () => root.unmount());
});
