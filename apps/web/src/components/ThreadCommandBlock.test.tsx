// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CommandBlock, CommandRefusalId } from "@ardurbot/contracts";
import { COMMAND_REFUSALS } from "@ardurbot/contracts";
import { commandDisplayOutput, commandOutput, exportCommandLog } from "@ardurbot/core";
import { createCompiledCatalog } from "@lingui/cli/api";
import { setupI18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadCommandBlock } from "./ThreadCommandBlock";

const catalogIds = vi.hoisted(() => new Map<string, string>());

// The Node harness uses the runtime hook and real compiled catalogs for tagged messages.
vi.mock("@lingui/react/macro", async () => {
  const { useLingui } = await import("@lingui/react");
  return {
    useLingui: () => {
      const { i18n } = useLingui();
      return {
        i18n,
        t: (parts: TemplateStringsArray) =>
          i18n._(catalogIds.get(parts.join("")) ?? parts.join("")),
      };
    },
  };
});
const calls = vi.hoisted(() => ({ open: vi.fn(), list: vi.fn(), export: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { commands: calls } }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const expected = {
  ru: {
    "command-size":
      "Команда не выполнена, потому что её размер превышает 64 КБ. Сохраните код в файл и запустите этот файл.",
    "file-location": "Используйте путь внутри папки этого бота или зарегистрированной папки.",
  },
  "zh-CN": {
    "command-size": "此命令未运行，因为它超过了 64 KB。请将代码放入文件并运行该文件。",
    "file-location": "请使用此机器人的文件夹或已注册文件夹内的路径。",
  },
};
async function mount(block: CommandBlock) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const i18n = setupI18n();
  for (const locale of ["ru", "zh-CN"]) {
    const filename = path.resolve(`apps/web/src/locales/${locale}/messages.po`);
    const entries = await formatter().parse(readFileSync(filename, "utf8"), {
      locale,
      sourceLocale: "en",
      filename,
    });
    for (const [id, entry] of Object.entries(entries)) catalogIds.set(entry.message ?? id, id);
    const translations = Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [id, entry.translation || entry.message || id]),
    );
    const { source, errors } = createCompiledCatalog(locale, translations, { namespace: "json" });
    expect(errors).toEqual([]);
    i18n.load(locale, JSON.parse(source).messages);
  }
  i18n.activate("ru");
  calls.open.mockResolvedValue(block);
  calls.list.mockResolvedValue({ blocks: [block] });
  calls.export.mockResolvedValue({
    text: exportCommandLog(block.runId, [block]),
    filename: "commands.log",
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <ThreadCommandBlock block={block} />
      </I18nProvider>,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click(),
  );
  return { container, i18n };
}
function fixture(overrides: Partial<CommandBlock> = {}): CommandBlock {
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
it.each(["command-size", "file-location"] as CommandRefusalId[])(
  "renders %s in an expanded block and search results, updates locale, and copies/exports original evidence",
  async (refusalId) => {
    const error = COMMAND_REFUSALS[refusalId];
    const block = fixture({ refusalId, error, stdout: error, stderr: error });
    const { container, i18n } = await mount(block);
    // This assertion fails on the original display path, even when catalogs contain the text.
    expect(container.querySelector("pre")!.textContent).toContain(
      `error:\n${expected.ru[refusalId]}`,
    );
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(container.querySelector("details pre")!.textContent).toContain(
      `error:\n${expected.ru[refusalId]}`,
    );
    await act(async () => i18n.activate("zh-CN"));
    for (const pre of container.querySelectorAll("pre")) {
      expect(pre.textContent).toBe(
        `stdout:\n${error}\nstderr:\n${error}\nerror:\n${expected["zh-CN"][refusalId]}`,
      );
    }
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const buttons = [...container.querySelectorAll("button")];
    await act(async () =>
      buttons
        .find((button) => button.textContent === i18n._(catalogIds.get("Copy output")!))!
        .click(),
    );
    expect(copy).toHaveBeenCalledWith(commandOutput(block));
    const create = vi.fn((_blob: Blob) => "blob:fixture");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () =>
      buttons
        .find((button) => button.textContent === i18n._(catalogIds.get("Export block")!))!
        .click(),
    );
    expect(calls.export).toHaveBeenCalledWith(
      { runId: "run", commandId: "command" },
      { context: { spaceId: undefined } },
    );
    const blob = create.mock.calls[0]?.[0] as unknown as Blob;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text).toContain(`error:\n${error}`);
    expect(text).not.toContain(expected["zh-CN"][refusalId]);
    expect(block.error).toBe(error);
  },
);
it.each(["command-size", "file-location"] as const)(
  "translates only the exact legacy %s error",
  async (id) => {
    const { container } = await mount(fixture({ error: COMMAND_REFUSALS[id] }));
    expect(container.querySelector("pre")!.textContent).toContain(expected.ru[id]);
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
])("preserves unknown/substring errors and ordinary streams: %j", async (fields) => {
  const block = fixture(fields);
  const { container } = await mount(block);
  expect(container.querySelector("pre")!.textContent).toBe(commandOutput(block));
});

it.each(["command-size", "file-location"] as const)(
  "uses the %s identifier without parsing its raw error words",
  async (refusalId) => {
    const { container } = await mount(fixture({ refusalId, error: "original recorded detail" }));
    expect(container.querySelector("pre")!.textContent).toContain(expected.ru[refusalId]);
  },
);
it("resolves search result errors independently of the expanded block", async () => {
  const { container } = await mount(fixture({ error: "ordinary failure" }));
  const match = fixture({ refusalId: "file-location", error: COMMAND_REFUSALS["file-location"] });
  calls.list.mockResolvedValueOnce({ blocks: [match] });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector("details pre")!.textContent).toContain(
    expected.ru["file-location"],
  );
  expect(container.querySelector("pre")!.textContent).toContain("ordinary failure");
});

it.each([
  "Run commands inside this bot's folder or a registered folder.",
  "This command was not run because its request is invalid. Check the command and folder.",
])("translates merged guidance without changing copied evidence: %s", async (error) => {
  const block = fixture({ error, rerunDisabledReason: error });
  const { container, i18n } = await mount(block);
  const translated = i18n._(catalogIds.get(error)!);
  expect(translated).not.toBe(error);
  expect(container.querySelector("pre")!.textContent).toBe(commandDisplayOutput(block, translated));
  expect(container.textContent).toContain(translated);
  expect(container.textContent).not.toContain(error);
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector("details pre")!.textContent).toBe(
    commandDisplayOutput(block, translated),
  );
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === i18n._(catalogIds.get("Copy output")!))!
      .click(),
  );
  expect(copy).toHaveBeenCalledWith(commandOutput(block));
  expect(block.error).toBe(error);
});

it.each([
  "Run commands inside this bot's folder or a registered folder.",
  "This command was not run because its request is invalid. Check the command and folder.",
])("does not reinterpret future refusal identifiers as merged guidance: %s", async (error) => {
  const block = fixture({ error, refusalId: "future-refusal" });
  const { container } = await mount(block);
  expect(container.querySelector("pre")!.textContent).toBe(commandOutput(block));
});
