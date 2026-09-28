// @vitest-environment jsdom
import type { Bot } from "@ardurbot/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@ardurbot/ui-web";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { act, lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotCreatePicker as BotCreatePickerComponent } from "./bot-picker";
import type {
  ClearConversationDialog as ClearConversationDialogComponent,
  NewSpaceDialog as NewSpaceDialogComponent,
} from "./dialogs";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
    i18n: {
      locale: "en",
      _: (value: any) => (typeof value === "string" ? value : (value?.message ?? value?.id ?? "")),
    },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

describe("Shell lazy boundaries and preloading", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    class FakeResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    window.ResizeObserver = FakeResizeObserver as any;
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("first click on a dialog opener opens dialog with lazy module while shell and sibling content stay mounted", async () => {
    let resolveDialogsModule!: (mod: any) => void;
    const dialogsPromise = new Promise((resolve) => {
      resolveDialogsModule = resolve;
    });

    const loadDialogs = vi.fn(() => dialogsPromise);
    const preloadDialogs = () => {
      void loadDialogs();
    };

    const NewSpaceDialog = lazy<ComponentType<ComponentProps<typeof NewSpaceDialogComponent>>>(() =>
      loadDialogs().then((module: any) => ({ default: module.NewSpaceDialog })),
    );

    const ClearConversationDialog = lazy<
      ComponentType<ComponentProps<typeof ClearConversationDialogComponent>>
    >(() => loadDialogs().then((module: any) => ({ default: module.ClearConversationDialog })));

    function TestShell() {
      const [newSpaceOpen, setNewSpaceOpen] = useState(false);
      const [clearTarget, setClearTarget] = useState<Bot | null>(null);
      const [siblingMenuOpen] = useState(true);

      return (
        <div data-testid="shell-layout">
          <div data-testid="shell-header">Shell Header</div>
          <div data-testid="shell-sidebar">
            <button
              type="button"
              data-testid="open-new-space"
              onPointerEnter={preloadDialogs}
              onFocus={preloadDialogs}
              onPointerDown={preloadDialogs}
              onClick={() => setNewSpaceOpen(true)}
            >
              New Space Opener
            </button>
            <button
              type="button"
              data-testid="open-clear-dialog"
              onPointerEnter={preloadDialogs}
              onFocus={preloadDialogs}
              onPointerDown={preloadDialogs}
              onClick={() => setClearTarget({ id: "b1", name: "Test Bot" } as Bot)}
            >
              Clear conversation Opener
            </button>
          </div>

          {/* Shared Suspense boundary mirroring Shell.tsx lines 4051-4408 */}
          <Suspense fallback={<div data-testid="shared-boundary-fallback">Suspended!</div>}>
            {siblingMenuOpen ? (
              <div data-testid="sibling-menu-content">Context Menu Sibling</div>
            ) : null}

            {/* Individual Suspense boundaries around each lazily loaded dialog */}
            {newSpaceOpen ? (
              <Suspense fallback={null}>
                <NewSpaceDialog
                  onCancel={() => setNewSpaceOpen(false)}
                  onConfirm={async () => {}}
                />
              </Suspense>
            ) : null}

            {clearTarget ? (
              <Suspense fallback={null}>
                <ClearConversationDialog
                  bot={clearTarget}
                  onCancel={() => setClearTarget(null)}
                  onConfirm={async () => {}}
                />
              </Suspense>
            ) : null}
          </Suspense>
        </div>
      );
    }

    await act(async () => {
      root.render(<TestShell />);
    });

    // Verify initial shell and sibling content are mounted
    expect(container.querySelector('[data-testid="shell-header"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sibling-menu-content"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shared-boundary-fallback"]')).toBeNull();

    // User triggers intent preloading on opener
    const openNewSpaceBtn = container.querySelector(
      '[data-testid="open-new-space"]',
    ) as HTMLButtonElement;
    await act(async () => {
      openNewSpaceBtn.focus();
      openNewSpaceBtn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(loadDialogs).toHaveBeenCalled();

    // First click on dialog opener: dialog state is set and NewSpaceDialog suspends
    await act(async () => {
      openNewSpaceBtn.click();
    });

    // Crucial requirement: While lazy module is loading/suspended,
    // 1. Shell remains mounted
    expect(container.querySelector('[data-testid="shell-header"]')).toBeTruthy();
    // 2. Sibling content in shared boundary is unaffected (not hidden by shared fallback)
    expect(container.querySelector('[data-testid="sibling-menu-content"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shared-boundary-fallback"]')).toBeNull();

    // Now the real dialogs module finishes loading
    const realDialogs = await import("./dialogs");
    await act(async () => {
      resolveDialogsModule(realDialogs);
    });

    // The dialog has now opened with the lazy module (rendered via portal to document.body)
    expect(document.body.textContent).toContain("New space");
    expect(document.querySelector('input[placeholder="Customer support"]')).toBeTruthy();

    // Sibling content and shell remain mounted
    expect(container.querySelector('[data-testid="shell-header"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sibling-menu-content"]')).toBeTruthy();
  });

  it("first click on Clear conversation opener opens dialog while shell and sibling content stay mounted", async () => {
    let resolveDialogsModule!: (mod: any) => void;
    const dialogsPromise = new Promise((resolve) => {
      resolveDialogsModule = resolve;
    });

    const loadDialogs = vi.fn(() => dialogsPromise);
    const preloadDialogs = () => {
      void loadDialogs();
    };

    const ClearConversationDialog = lazy<
      ComponentType<ComponentProps<typeof ClearConversationDialogComponent>>
    >(() => loadDialogs().then((module: any) => ({ default: module.ClearConversationDialog })));

    function TestShell() {
      const [clearTarget, setClearTarget] = useState<Bot | null>(null);
      const [siblingMenuOpen] = useState(true);

      return (
        <div data-testid="shell-layout">
          <div data-testid="shell-header">Shell Header</div>
          <button
            type="button"
            data-testid="open-clear-dialog"
            onPointerEnter={preloadDialogs}
            onFocus={preloadDialogs}
            onPointerDown={preloadDialogs}
            onClick={() => setClearTarget({ id: "b1", name: "Support Bot" } as Bot)}
          >
            Clear conversation Opener
          </button>

          {/* Shared Suspense boundary mirroring Shell.tsx lines 4051-4408 */}
          <Suspense fallback={<div data-testid="shared-boundary-fallback">Suspended!</div>}>
            {siblingMenuOpen ? (
              <div data-testid="sibling-menu-content">Context Menu Sibling</div>
            ) : null}

            {clearTarget ? (
              <Suspense fallback={null}>
                <ClearConversationDialog
                  bot={clearTarget}
                  onCancel={() => setClearTarget(null)}
                  onConfirm={async () => {}}
                />
              </Suspense>
            ) : null}
          </Suspense>
        </div>
      );
    }

    await act(async () => {
      root.render(<TestShell />);
    });

    const openClearBtn = container.querySelector(
      '[data-testid="open-clear-dialog"]',
    ) as HTMLButtonElement;
    await act(async () => {
      openClearBtn.focus();
      openClearBtn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(loadDialogs).toHaveBeenCalled();

    // Click opener
    await act(async () => {
      openClearBtn.click();
    });

    // While suspended, shell and sibling in shared boundary are unaffected
    expect(container.querySelector('[data-testid="shell-header"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sibling-menu-content"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shared-boundary-fallback"]')).toBeNull();

    // Resolve dialog module
    const realDialogs = await import("./dialogs");
    await act(async () => {
      resolveDialogsModule(realDialogs);
    });

    // Dialog is visible via portal
    expect(document.body.textContent).toContain("Clear Support Bot’s conversation?");

    // Shell and sibling remain mounted
    expect(container.querySelector('[data-testid="shell-header"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sibling-menu-content"]')).toBeTruthy();
  });

  it("create picker opens with focusable content on first click after intent preloading", async () => {
    let resolvePickerModule!: (mod: any) => void;
    const pickerPromise = new Promise((resolve) => {
      resolvePickerModule = resolve;
    });

    const loadBotCreatePicker = vi.fn(() => pickerPromise);
    const preloadBotCreatePicker = () => {
      void loadBotCreatePicker();
    };

    const BotCreatePicker = lazy<ComponentType<ComponentProps<typeof BotCreatePickerComponent>>>(
      () => loadBotCreatePicker().then((module: any) => ({ default: module.BotCreatePicker })),
    );

    const testBots: Bot[] = [
      {
        id: "bot-1",
        name: "Helper Bot",
        title: "Test assistant",
        color: "#6366f1",
        status: "active",
        pinned: false,
        sectionId: null,
        unread: false,
      } as Bot,
    ];

    function TestCreateMenu() {
      const [createMenuOpen, setCreateMenuOpen] = useState(false);

      return (
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <PopoverTrigger
            data-testid="create-menu-trigger"
            onPointerEnter={preloadBotCreatePicker}
            onFocus={preloadBotCreatePicker}
            onPointerDown={preloadBotCreatePicker}
            onClick={preloadBotCreatePicker}
          >
            +
          </PopoverTrigger>
          {createMenuOpen ? (
            <PopoverContent data-testid="create-popover-content">
              <Suspense fallback={null}>
                <BotCreatePicker
                  bots={testBots}
                  onCreateBot={() => {}}
                  onOpenBot={() => {}}
                  onCreateGroup={() => {}}
                  onCreateSpace={() => {}}
                  onShowGroupInfo={() => {}}
                  onShowSpaceInfo={() => {}}
                />
              </Suspense>
            </PopoverContent>
          ) : null}
        </Popover>
      );
    }

    await act(async () => {
      root.render(<TestCreateMenu />);
    });

    const trigger = container.querySelector(
      '[data-testid="create-menu-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();

    // User pointerenter / focus / pointerdown triggers preloading
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(loadBotCreatePicker).toHaveBeenCalled();

    // Resolve the real bot-picker chunk
    const realPicker = await import("./bot-picker");
    await act(async () => {
      resolvePickerModule(realPicker);
    });

    // First click to open
    await act(async () => {
      trigger.click();
    });

    // The popover must contain focusable content, not an empty container
    const searchInput = document.querySelector('input[aria-label="Search"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    // Focus can be placed on search input or create buttons
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    // Verify command items exist and are not empty
    expect(document.querySelector('[data-testid="create-new-bot"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="create-new-space"]')).toBeTruthy();
  });
});
