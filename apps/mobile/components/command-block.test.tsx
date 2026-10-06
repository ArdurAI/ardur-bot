// @vitest-environment jsdom
import type { CommandBlock } from "@ardurbot/contracts";
import { COMMAND_REFUSALS } from "@ardurbot/contracts";
import { commandOutput } from "@ardurbot/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { activateUiLocale, resetI18nForTests } from "../lib/i18n";
import { RU_MESSAGES } from "../lib/locales/ru";
import { ZH_MESSAGES } from "../lib/locales/zh";
import { NativeCommandBlock } from "./command-block";

// Native controls become DOM controls; the component, state and dictionary lookup stay real.
vi.mock("react-native", () => {
  const surface =
    (tag: string) =>
    ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) =>
      createElement(tag, { onClick: onPress, disabled }, children);
  return {
    View: surface("div"),
    Text: surface("span"),
    ScrollView: surface("pre"),
    Pressable: surface("button"),
    StyleSheet: { create: (styles: unknown) => styles },
  };
});
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({}) }));
const exported = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/command-export", () => ({ exportCommandRun: exported }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  resetI18nForTests();
});
function fixture(overrides: Partial<CommandBlock>): CommandBlock {
  return {
    commandId: "command",
    runId: "run",
    attemptId: null,
    executionId: "execution",
    command: "pwd",
    cwd: "/workspace",
    computerId: null,
    computer: null,
    startedAt: null,
    durationMs: null,
    exitCode: null,
    outcome: "cancelled",
    stdout: null,
    stderr: null,
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}
async function mount(block: CommandBlock) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetI18nForTests("ru");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<NativeCommandBlock block={block} />));
  await act(async () => container.querySelector("button")!.click());
  return container;
}
it.each(["command-size", "file-location"] as const)(
  "renders %s using phone dictionaries, updates an expanded block and exports by original run id",
  async (refusalId) => {
    const error = COMMAND_REFUSALS[refusalId];
    const block = fixture({ refusalId, error, stdout: error, stderr: error });
    const container = await mount(block);
    const ru = RU_MESSAGES[error];
    expect(ru).toBeTruthy();
    expect(ru).not.toBe(error);
    // Fails if the native dictionary lookup is removed from the renderer.
    expect(container.querySelector("pre")!.textContent).toBe(
      `stdout:\n${error}\nstderr:\n${error}\nerror:\n${ru}`,
    );
    await act(async () => activateUiLocale("zh-CN"));
    expect(container.querySelector("pre")!.textContent).toBe(
      `stdout:\n${error}\nstderr:\n${error}\nerror:\n${ZH_MESSAGES[error]}`,
    );
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(exported).toHaveBeenCalledWith("run");
    expect(block.error).toBe(error);
  },
);
it.each(["command-size", "file-location"] as const)(
  "translates the exact legacy %s error",
  async (id) => {
    const container = await mount(fixture({ error: COMMAND_REFUSALS[id] }));
    expect(container.querySelector("pre")!.textContent).toContain(
      RU_MESSAGES[COMMAND_REFUSALS[id]],
    );
  },
);
it.each([
  { refusalId: "future", error: COMMAND_REFUSALS["file-location"] },
  { error: `prefix ${COMMAND_REFUSALS["command-size"]}` },
  { error: "ordinary failure" },
  {
    error: null,
    stdout: COMMAND_REFUSALS["file-location"],
    stderr: COMMAND_REFUSALS["command-size"],
  },
])("preserves ordinary output and unknown/substring errors: %j", async (fields) => {
  const block = fixture(fields);
  const container = await mount(block);
  expect(container.querySelector("pre")!.textContent).toBe(commandOutput(block));
});

it.each(["command-size", "file-location"] as const)(
  "uses the %s identifier without parsing the original error words",
  async (refusalId) => {
    const container = await mount(fixture({ refusalId, error: "original recorded detail" }));
    expect(container.querySelector("pre")!.textContent).toContain(
      RU_MESSAGES[COMMAND_REFUSALS[refusalId]],
    );
  },
);

it.each([
  "Run commands inside this bot's folder or a registered folder.",
  "This command was not run because its request is invalid. Check the command and folder.",
])("translates merged guidance and follows phone locale changes: %s", async (error) => {
  const block = fixture({ error, stdout: error, stderr: error });
  const container = await mount(block);
  expect(RU_MESSAGES[error]).not.toBe(error);
  expect(container.querySelector("pre")!.textContent).toBe(
    `stdout:\n${error}\nstderr:\n${error}\nerror:\n${RU_MESSAGES[error]}`,
  );
  await act(async () => activateUiLocale("zh-CN"));
  expect(container.querySelector("pre")!.textContent).toBe(
    `stdout:\n${error}\nstderr:\n${error}\nerror:\n${ZH_MESSAGES[error]}`,
  );
  expect(block.error).toBe(error);
});

it.each([
  "Run commands inside this bot's folder or a registered folder.",
  "This command was not run because its request is invalid. Check the command and folder.",
])("does not reinterpret future refusal identifiers as merged guidance: %s", async (error) => {
  const block = fixture({ error, refusalId: "future-refusal" });
  const container = await mount(block);
  expect(container.querySelector("pre")!.textContent).toBe(commandOutput(block));
});
