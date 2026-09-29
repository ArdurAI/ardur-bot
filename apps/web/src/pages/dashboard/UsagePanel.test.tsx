// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { UsageSummary } from "@ardurbot/contracts";
import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const { compileMessage } = createRequire(import.meta.resolve("@lingui/core"))(
  "@lingui/message-utils/compileMessage",
) as { compileMessage: (message: string) => never };

function formatPlural(value: number, one: string, other: string) {
  const text = value === 1 ? one : other;
  return text.replaceAll("#", new Intl.NumberFormat("en").format(value));
}

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    formatPlural(value, one, other),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((message, part, i) => message + part + (values[i] ?? ""), ""),
  }),
}));

import UsagePanel from "./UsagePanel";

const summary = {
  inputTokens: 0,
  outputTokens: 0,
  runs: 0,
  dayStart: "2026-09-29T00:00:00.000Z",
  weekStart: "2026-09-23T00:00:00.000Z",
  asOf: "2026-09-29T00:00:00.000Z",
} satisfies Omit<UsageSummary, "providers">;

function provider(records: number, inputTokens: number, outputTokens: number) {
  return {
    provider: records === 1 ? "One" : "Many",
    today: { records, inputTokens, outputTokens, cost: null },
    week: { records, inputTokens, outputTokens, cost: null },
    daily: [],
  };
}

it("formats usage counts with the locale's grouping and plural", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <UsagePanel
        data={{ ...summary, providers: [provider(5, 100000, 12702), provider(1, 1, 0)] }}
      />,
    ),
  );
  const text = container.textContent ?? "";
  expect(text).toContain("5 usage records");
  expect(text).toContain("112,702 tokens");
  expect(text).not.toContain("112702");
  expect(text).toContain("1 usage record");
  expect(text).toContain("1 token");
  expect(text).not.toContain("1 tokens");
  expect(text).not.toContain("1 usage records");
  act(() => root.unmount());
});

const RECORDS = "{records, plural, one {# usage record} other {# usage records}}";
const TOKENS = "{tokens, plural, one {# token} other {# tokens}}";

function catalogMessage(locale: string, msgid: string) {
  const catalog = readFileSync(
    path.join(import.meta.dirname, "../../locales", locale, "messages.po"),
    "utf8",
  );
  const key = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
  const at = catalog.indexOf(key);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = at + key.length;
  return catalog.slice(start, catalog.indexOf('"', start));
}

it("formats the usage catalogs for English, German, and Russian", () => {
  i18n.setMessagesCompiler(compileMessage);
  const grouped = (locale: string, value: number) => new Intl.NumberFormat(locale).format(value);
  for (const locale of ["en", "de"] as const) {
    i18n.load(locale, {
      [RECORDS]: catalogMessage(locale, RECORDS),
      [TOKENS]: catalogMessage(locale, TOKENS),
    });
    i18n.activate(locale);
  }
  i18n.activate("en");
  expect(i18n._(RECORDS, { records: 112702 })).toBe(`${grouped("en", 112702)} usage records`);
  expect(i18n._(TOKENS, { tokens: 112702 })).toBe(`${grouped("en", 112702)} tokens`);
  expect(i18n._(RECORDS, { records: 1 })).toBe("1 usage record");
  expect(i18n._(TOKENS, { tokens: 1 })).toBe("1 token");
  i18n.activate("de");
  expect(i18n._(RECORDS, { records: 112702 })).toBe(`${grouped("de", 112702)} Nutzungsdatensätze`);
  expect(i18n._(RECORDS, { records: 1 })).toBe("1 Nutzungsdatensatz");
  expect(i18n._(TOKENS, { tokens: 112702 })).toBe(`${grouped("de", 112702)} Token`);
  i18n.load("ru", {
    [RECORDS]: catalogMessage("ru", RECORDS),
    [TOKENS]: catalogMessage("ru", TOKENS),
  });
  i18n.activate("ru");
  const ru = (value: number) => grouped("ru", value);
  expect(i18n._(RECORDS, { records: 1 })).toBe(`${ru(1)} запись об использовании`);
  expect(i18n._(RECORDS, { records: 2 })).toBe(`${ru(2)} записи об использовании`);
  expect(i18n._(RECORDS, { records: 5 })).toBe(`${ru(5)} записей об использовании`);
  expect(i18n._(TOKENS, { tokens: 1 })).toBe(`${ru(1)} токен`);
  expect(i18n._(TOKENS, { tokens: 2 })).toBe(`${ru(2)} токена`);
  expect(i18n._(TOKENS, { tokens: 5 })).toBe(`${ru(5)} токенов`);
});

it("translates token counts for Spanish and Portuguese", () => {
  i18n.setMessagesCompiler(compileMessage);
  for (const locale of ["es", "pt-BR"] as const) {
    i18n.load(locale, { [TOKENS]: catalogMessage(locale, TOKENS) });
    i18n.activate(locale);
    expect(i18n._(TOKENS, { tokens: 1 })).toBe("1 símbolo");
    expect(i18n._(TOKENS, { tokens: 5 })).toBe("5 símbolos");
  }
});

const period = {
  records: 1,
  inputTokens: 120,
  outputTokens: 1,
  cost: null,
};
const partialSummary = (incomplete: boolean | undefined): UsageSummary => ({
  inputTokens: 120,
  outputTokens: 1,
  runs: 1,
  dayStart: "2026-09-24T00:00:00Z",
  weekStart: "2026-09-21T00:00:00Z",
  asOf: "2026-09-24T12:00:00Z",
  providers: [
    {
      provider: "anthropic",
      today: { ...period, ...(incomplete === undefined ? {} : { incomplete }) },
      week: { ...period, incomplete: false },
      daily: [{ date: "2026-09-24", records: 1, tokens: 121 }],
    },
  ],
});

async function render(data: UsageSummary) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<UsagePanel data={data} />));
  return { container, root };
}

it("shows Partially reported when a period's totals are only a lower bound", async () => {
  const { container, root } = await render(partialSummary(true));
  expect(container.textContent).toContain("Partially reported");
  expect(container.textContent).toContain("121 tokens");
  await act(async () => root.unmount());
});

it("omits the marker when every period total was fully reported", async () => {
  for (const incomplete of [false, undefined] as const) {
    const { container, root } = await render(partialSummary(incomplete));
    expect(container.textContent).not.toContain("Partially reported");
    await act(async () => root.unmount());
  }
});
