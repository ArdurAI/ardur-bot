// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TeamRow } from "@ardurbot/contracts";
import { TeamRowSchema } from "@ardurbot/contracts";
import { i18n } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamBoardRow } from "./TeamBoard";

vi.mock("./CompareStart", () => ({ CompareStart: () => null }));
vi.mock("./ComparePanel", () => ({ ComparisonList: () => null }));
vi.mock("./PeerMessagesOverlay", () => ({ PeerMessagesOverlay: () => null }));
vi.mock("../lib/rpc", () => ({ rpc: { delegations: {} } }));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
// The real translator with the real Russian catalog behind it, so the row reads as a
// Russian reader sees it: the translation, or the English id where the catalog has none.
vi.mock("@lingui/react/macro", async () => {
  const { i18n } = await import("@lingui/core");
  const translate = (
    parts: TemplateStringsArray | { id: string; message?: string; values?: object },
    ...values: unknown[]
  ) => {
    if (typeof parts === "object" && "id" in parts && !Array.isArray(parts))
      return i18n._({
        id: parts.id,
        message: parts.message ?? parts.id,
        values: (parts.values ?? values[0] ?? {}) as Record<string, unknown>,
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

const usageLimit = "{runtime}'s usage limit is reached. Try again after it resets.";
const unknownRuntime = "This runtime";

/** The catalog's own translation of a message, read from the file a release ships. */
function russian(message: string): string {
  const catalog = readFileSync(join(process.cwd(), "apps/web/src/locales/ru/messages.po"), "utf8");
  const key = `msgid ${JSON.stringify(message)}\nmsgstr "`;
  const at = catalog.indexOf(key);
  expect(at, `${message} is missing from the Russian catalog`).toBeGreaterThanOrEqual(0);
  return catalog.slice(at + key.length, catalog.indexOf('"\n', at + key.length));
}

function blocked(patch: Partial<TeamRow>): TeamRow {
  return TeamRowSchema.parse({
    botId: "worker",
    botName: "Reviewer",
    threadId: "thread",
    cursor: 1,
    state: "blocked",
    sentence: "Review sources",
    requesterName: "Chief",
    reason: "Claude Code's usage limit is reached. Try again after it resets.",
    action: "Open conversation",
    rootTaskId: "root",
    delegationId: "handoff",
    canStop: false,
    canAccept: false,
    chain: [],
    delegations: [],
    executing: null,
    usage: { tokens: 0, costs: [] },
    ...patch,
  });
}

async function text(row: TeamRow): Promise<string> {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow row={row} refresh={vi.fn(async () => undefined)} />
      </MemoryRouter>,
    ),
  );
  const rendered = node.textContent ?? "";
  await act(async () => root.unmount());
  return rendered;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("ru", {
    [usageLimit]: russian(usageLimit),
    [unknownRuntime]: russian(unknownRuntime),
  });
  i18n.activate("ru");
});
afterEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

it("writes a blocked card's categorized reason in the reader's language", async () => {
  const rendered = await text(blocked({ reasonCategory: "usage-limit", reasonRuntime: "Codex" }));
  expect(rendered).toContain(russian(usageLimit).replace("{runtime}", "Codex"));
  // The category's sentence, not the English text that was recorded next to it.
  expect(rendered).not.toContain("usage limit is reached");
});

it("names an unknown runtime in the reader's language", async () => {
  const rendered = await text(blocked({ reasonCategory: "usage-limit", reasonRuntime: null }));
  expect(rendered).toContain(russian(usageLimit).replace("{runtime}", russian(unknownRuntime)));
  expect(rendered).not.toContain(unknownRuntime);
});

it("keeps the words of a reason that has no category", async () => {
  const rendered = await text(blocked({ reason: "npm test failed." }));
  expect(rendered).toContain("npm test failed.");
});
