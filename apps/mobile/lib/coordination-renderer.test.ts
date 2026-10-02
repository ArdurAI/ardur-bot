// @vitest-environment jsdom
import type { ChiefDispatch } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChiefDispatchLine } from "../components/coordination-line";

vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./work-record", () => ({ watchMotionAllowed: vi.fn(), workRecordShouldPulse: vi.fn() }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./i18n", () => {
  const t = (text: string, args?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => args?.[key] ?? "");
  return { t, useI18n: () => ({ t }) };
});
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({
    children,
    accessibilityLiveRegion,
    numberOfLines,
  }: {
    children: ReactNode;
    accessibilityLiveRegion?: string;
    numberOfLines?: number;
  }) =>
    createElement(
      "span",
      {
        "aria-live": accessibilityLiveRegion,
        "data-lines": numberOfLines,
      },
      children,
    ),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityRole: string;
    accessibilityLabel: string;
    accessibilityState: { expanded: boolean };
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-expanded": accessibilityState.expanded,
      },
      children,
    ),
  Alert: {},
  Animated: {},
  Linking: {},
}));

const dispatch: ChiefDispatch = {
  requestMessageId: "request",
  revision: 87,
  memberId: "replacement",
  memberName: "Replacement",
  state: "messaged",
  reason: "eligible",
  activity: {
    revision: 87,
    runId: "run",
    delegationId: "assignment",
    attempt: 1,
    sourceSeq: 1,
    key: "write-notion",
    state: "active",
    updatedAt: "2026-01-01T00:00:00Z",
  },
};

describe("native correction dispatch renderer", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each([
    ["requested", "Told Member to stand down", "Stopping Member"],
    ["confirmed", "Member stood down", undefined],
    ["uncertain", "The previous action may have finished. I’ll check before retrying.", undefined],
  ] as const)(
    "announces the %s stop honestly and keeps details expandable",
    (state, label, activity) => {
      act(() =>
        root.render(
          createElement(ChiefDispatchLine, {
            dispatch: { ...dispatch, stop: { revision: 86, memberName: "Member", state } },
            detail: "Preparation request",
            actionProps: {},
          }),
        ),
      );
      const button = container.querySelector("button")!;
      expect(button.getAttribute("role")).toBe("button");
      expect(button.getAttribute("aria-label")).toBe([label, activity].filter(Boolean).join(" · "));
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.querySelector('[aria-live="polite"]')?.textContent).toBe(label);
      expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(activity ? 2 : 1);
      expect(container.textContent).not.toMatch(
        /86|87|Replacement|Creating the Notion page|Preparation request/,
      );
      if (state === "uncertain")
        expect(button.querySelector("span")?.hasAttribute("data-lines")).toBe(false);
      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("Preparation request");
    },
  );

  it("returns to the normal member headline and genuine activity for a replacement", () => {
    const render = (value: ChiefDispatch) =>
      act(() =>
        root.render(
          createElement(ChiefDispatchLine, {
            dispatch: value,
            detail: "Preparation request",
            actionProps: {},
          }),
        ),
      );
    render({ ...dispatch, stop: { revision: 86, memberName: "Member", state: "confirmed" } });
    render(dispatch);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Messaged Replacement · Creating the Notion page",
    );
    expect(container.textContent).not.toContain("stood down");
  });
});
