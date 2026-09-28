// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  promptFocus: vi.fn(),
  ensureFirstBot: vi.fn(),
  refreshAccount: vi.fn(),
  returnToSetup: vi.fn(),
  onChange: vi.fn(),
  savePendingChange: null as ((pending: boolean) => void) | null,
}));

vi.mock("../lib/desktop", () => ({
  desktopBridge: () => ({
    guidedSetup: {
      refreshAccount: api.refreshAccount,
      returnToSetup: api.returnToSetup,
      onChange: api.onChange,
    },
  }),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    guidedSetup: { status: api.status },
    onboarding: { start: api.start, promptFocus: api.promptFocus },
  },
}));
vi.mock("../lib/use-first-bot-setup", () => ({
  useFirstBotSetup: () => api.ensureFirstBot,
}));
vi.mock("./ModelSettingsOverlay", () => ({
  ModelSettingsOverlay: ({
    onSavePendingChange,
  }: {
    onSavePendingChange: (value: boolean) => void;
  }) => {
    api.savePendingChange = onSavePendingChange;
    return null;
  },
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { GuidedOnboardingPage } from "./GuidedOnboarding";

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.savePendingChange = null;
  api.status.mockResolvedValue({ model: "saved", firstBot: false });
  api.refreshAccount.mockResolvedValue(undefined);
  api.returnToSetup.mockResolvedValue(undefined);
  api.start.mockResolvedValue(undefined);
  api.promptFocus.mockResolvedValue(undefined);
  api.onChange.mockReturnValue(() => undefined);
  node = document.createElement("div");
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render(step: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/guided-onboarding?step=${step}`]}>
        <GuidedOnboardingPage />
      </MemoryRouter>,
    );
  });
}

it("waits for an in-flight model save before account read-back and returning", async () => {
  await render("model");
  await act(async () => api.savePendingChange?.(true));
  const button = [...node.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Return to setup",
  );
  await act(async () => button?.click());
  expect(api.refreshAccount).not.toHaveBeenCalled();
  expect(api.returnToSetup).not.toHaveBeenCalled();
  await act(async () => api.savePendingChange?.(false));
  expect(api.refreshAccount).toHaveBeenCalledOnce();
  expect(api.returnToSetup).toHaveBeenCalledOnce();
});

it("stops scheduling greeting calls after cancel during bot creation", async () => {
  let resolveCreate: (bot: { id: string }) => void = () => undefined;
  api.ensureFirstBot.mockImplementation(
    () =>
      new Promise<{ id: string }>((resolve) => {
        resolveCreate = resolve;
      }),
  );
  await render("bot");
  const button = [...node.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Create bot",
  );
  await act(async () => button?.click());
  expect(api.ensureFirstBot).toHaveBeenCalledOnce();
  const onChange = api.onChange.mock.calls[0]?.[0] as (snapshot: {
    steps: { status: string }[];
  }) => void;
  await act(async () => onChange({ steps: [{ status: "cancelled" }] }));
  await act(async () => resolveCreate({ id: "bot-a" }));
  expect(api.start).not.toHaveBeenCalled();
  expect(api.promptFocus).not.toHaveBeenCalled();
});
