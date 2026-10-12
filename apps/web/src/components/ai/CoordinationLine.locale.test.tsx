// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatter } from "@lingui/format-po";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The real checked-in German catalog backs this mock, so the component renders
// exactly what a German reader sees: the translation, or the English id when
// the catalog lacks one (which these tests then catch). The mock reads the
// holder lazily at render time; beforeAll fills it from messages.po.
const german = vi.hoisted(() => ({ byMessage: new Map<string, string>() }));

vi.mock("@lingui/react/macro", () => {
  const lookup = (id: string) =>
    german.byMessage.get(id) || german.byMessage.get(id.replace("{0}", "{name}"));
  const interpolate = (template: string, values: unknown[]) =>
    template.replace(/\{(?:\d+|name)\}/g, (match) =>
      match === "{name}"
        ? String(values[0] ?? "")
        : String(values[Number(match.slice(1, -1))] ?? ""),
    );
  const translate = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const id = parts.reduce(
      (text, part, index) => text + part + (index < values.length ? `{${index}}` : ""),
      "",
    );
    return interpolate(lookup(id) || id, values);
  };
  return {
    useLingui: () => ({ t: translate }),
    Trans: ({ children }: { children: ReactNode }) =>
      (typeof children === "string" ? lookup(children) || children : children) as ReactNode,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
      <>{value === 1 ? one.replace("#", "1") : other.replace("#", String(value))}</>
    ),
  };
});

import type { CoordinationBlock } from "@ardurbot/core";
import { ChiefDispatchLine, ChiefReceiptText, CoordinationLine } from "./CoordinationLine";

function block(patch: Partial<CoordinationBlock> = {}): CoordinationBlock {
  return {
    kind: "coordination",
    nonce: "group-ask:1:run:call-1",
    round: 1,
    text: "Say hello to your teammates.",
    updates: [],
    members: [
      { botId: "radiant", name: "Radiant", outcome: "answered" },
      { botId: "zai", name: "zai-bot", outcome: "failed", reasonCode: "auth" },
    ],
    ...patch,
  };
}

const ENGLISH_PHRASES = ["couldn't answer", "rate limit", "unavailable", "stopped before"];

describe("CoordinationLine in German", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(async () => {
    const filename = path.join(import.meta.dirname, "../../locales/de/messages.po");
    const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
      locale: "de",
      sourceLocale: "en",
      filename,
    });
    for (const entry of Object.values(catalog))
      if (entry.message && typeof entry.translation === "string")
        german.byMessage.set(entry.message, entry.translation);
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderFailure(member: CoordinationBlock["members"][number]): HTMLElement {
    act(() => {
      root.render(<CoordinationLine block={block({ members: [member] })} />);
    });
    const failure = container.querySelector<HTMLElement>('[data-testid="coordination-failure"]');
    expect(failure).toBeTruthy();
    return failure!;
  }

  it("renders the saved access blocker and blocked receipt in German", () => {
    act(() =>
      root.render(
        <ChiefDispatchLine
          dispatch={{
            requestMessageId: "request",
            revision: 1,
            memberId: "chief",
            memberName: "Chief",
            state: "needs-owner",
            blockerKey: "connect-linear",
            reason: "access",
          }}
          detail="request"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="chief-activity"]')?.textContent).toBe(
      "Verbinden Sie Linear oder geben Sie einem Teammitglied Lese- und Schreibzugriff.",
    );
    expect(container.textContent).not.toContain("Messaged");
    act(() => root.render(<ChiefReceiptText receiptKey="needs-owner" />));
    expect(container.textContent).toBe(
      "Verstanden — diese Aufgabe braucht Ihre Hilfe, bevor ich sie zuweisen kann.",
    );
  });

  it.each(["de", "en", "es", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"])(
    "has all blocked assignment copy in %s",
    async (locale) => {
      const filename = path.join(import.meta.dirname, `../../locales/${locale}/messages.po`);
      const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
        locale,
        sourceLocale: "en",
        filename,
      });
      for (const message of [
        "Needs you",
        "Got it — this task needs you before I can assign it.",
        "Connect Linear or grant a team member permission to read and write.",
        "Connect GitHub or grant a team member permission to read and write.",
      ]) {
        const entry = Object.values(catalog).find((entry) => entry.message === message);
        expect(entry?.translation).toBeTruthy();
        if (locale !== "en") expect(entry?.translation).not.toBe(message);
      }
    },
  );

  it.each([
    ["auth", "zai-bot konnte nicht antworten: Das Modellkonto erfordert Aufmerksamkeit"],
    ["rate-limit", "zai-bot konnte nicht antworten: Das Modellkonto hat ein Ratenlimit erreicht"],
    ["model-unavailable", "zai-bot konnte nicht antworten: Sein Modell ist nicht verfügbar"],
    ["stopped", "zai-bot wurde vor dem Antworten gestoppt"],
    ["other", "zai-bot konnte nicht antworten"],
  ] as const)("renders the %s code translated, with no English leaking", (reasonCode, expected) => {
    const failure = renderFailure({
      botId: "zai",
      name: "zai-bot",
      outcome: "failed",
      reasonCode,
    });
    expect(failure.textContent).toContain(expected);
    expect(failure.textContent).toContain("zai-bot");
    for (const phrase of ENGLISH_PHRASES) expect(failure.textContent).not.toContain(phrase);
  });

  it("shows the German fix label for a fixable code", () => {
    const failure = renderFailure({
      botId: "zai",
      name: "zai-bot",
      outcome: "failed",
      reasonCode: "auth",
    });
    expect(failure.textContent).toContain("Beheben");
    expect(failure.textContent).not.toContain("Fix");
  });

  it("renders an old English reason translated through its mapped code", () => {
    const failure = renderFailure({
      botId: "zai",
      name: "zai-bot",
      outcome: "failed",
      reason: "zai-bot couldn't answer: its model account needs attention",
    });
    expect(failure.textContent).toContain(
      "zai-bot konnte nicht antworten: Das Modellkonto erfordert Aufmerksamkeit",
    );
    for (const phrase of ENGLISH_PHRASES) expect(failure.textContent).not.toContain(phrase);
  });

  it("falls back to the generic translated line for an unknown old reason", () => {
    const failure = renderFailure({
      botId: "zai",
      name: "zai-bot",
      outcome: "failed",
      reason: "zai-bot froze mid-reply",
    });
    expect(failure.textContent).toContain("zai-bot konnte nicht antworten");
    expect(failure.textContent).not.toContain("froze");
  });
});
