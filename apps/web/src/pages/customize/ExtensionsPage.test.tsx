// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMocks = vi.hoisted(() => ({
  integrationsList: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  bridge: {
    customization: {
      list: vi.fn().mockResolvedValue([]),
      prepare: vi.fn().mockResolvedValue(null),
      prepareDrop: vi.fn().mockResolvedValue(null),
      cancel: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue({}),
      configure: vi.fn().mockResolvedValue({}),
      uninstall: vi.fn().mockResolvedValue(undefined),
      selectPaths: vi.fn().mockResolvedValue([]),
    },
  } as any,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));

vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Container,
    Button: ({
      variant: _variant,
      size: _size,
      children,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button {...props}>{children}</button>
    ),
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  };
});

vi.mock("../../lib/desktop", () => ({
  desktopBridge: () => bridgeMocks.bridge,
}));

vi.mock("../../lib/rpc", () => ({
  rpc: {
    integrations: {
      list: rpcMocks.integrationsList,
    },
  },
  selectedSpaceId: () => "test-space",
}));

vi.mock("./native", () => ({
  ensureCustomizationHost: vi.fn().mockResolvedValue(undefined),
}));

import ExtensionsPage from "./ExtensionsPage";

describe("ExtensionsPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    bridgeMocks.bridge = {
      customization: {
        list: vi.fn().mockResolvedValue([]),
        prepare: vi.fn().mockResolvedValue(null),
        prepareDrop: vi.fn().mockResolvedValue(null),
        cancel: vi.fn().mockResolvedValue(undefined),
        install: vi.fn().mockResolvedValue({}),
        configure: vi.fn().mockResolvedValue({}),
        uninstall: vi.fn().mockResolvedValue(undefined),
        selectPaths: vi.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows empty catalogue state with title, message, Add button running prepare, and Close button", async () => {
    rpcMocks.integrationsList.mockResolvedValue({
      catalog: [
        {
          id: "github",
          name: "GitHub",
          vendor: "github",
          transport: "remote-http",
          available: true,
        },
      ],
    });

    await act(async () => {
      root.render(<ExtensionsPage />);
    });

    const browseBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Browse extensions",
    );
    expect(browseBtn).toBeDefined();

    await act(async () => {
      browseBtn!.click();
    });

    expect(container.querySelector("h2")?.textContent).toBe("Browse extensions");
    expect(
      container.textContent?.includes(
        "No extensions are in the built-in catalogue yet. Use Add to install an extension from a file or folder on this computer.",
      ),
    ).toBe(true);

    const dialogButtons = Array.from(
      container.querySelector('[data-testid="dialog"]')?.querySelectorAll("button") ?? [],
    );
    const addBtn = dialogButtons.find((b) => b.textContent?.trim() === "Add");
    const closeBtn = dialogButtons.find((b) => b.textContent?.trim() === "Close");

    expect(addBtn).toBeDefined();
    expect(closeBtn).toBeDefined();

    // Clicking Add runs the same action as the page's Add button
    await act(async () => {
      addBtn!.click();
    });
    expect(bridgeMocks.bridge.customization.prepare).toHaveBeenCalledWith("test-space");

    // Close button closes the dialog
    await act(async () => {
      browseBtn!.click();
    });
    const newCloseBtn = Array.from(
      container.querySelector('[data-testid="dialog"]')?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent?.trim() === "Close");
    await act(async () => {
      newCloseBtn!.click();
    });
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
  });

  it("shows failed request state with message and Retry button which retries loading", async () => {
    rpcMocks.integrationsList.mockRejectedValueOnce(new Error("Network failed"));

    await act(async () => {
      root.render(<ExtensionsPage />);
    });

    const browseBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Browse extensions",
    );
    await act(async () => {
      browseBtn!.click();
    });

    expect(container.querySelector("h2")?.textContent).toBe("Browse extensions");
    expect(
      container.textContent?.includes(
        "Could not load the extension catalogue. Check the connection and try again.",
      ),
    ).toBe(true);

    const dialogButtons = Array.from(
      container.querySelector('[data-testid="dialog"]')?.querySelectorAll("button") ?? [],
    );
    const retryBtn = dialogButtons.find((b) => b.textContent?.trim() === "Retry");
    expect(retryBtn).toBeDefined();

    // Clicking Retry attempts to load again
    rpcMocks.integrationsList.mockResolvedValueOnce({ catalog: [] });
    await act(async () => {
      retryBtn!.click();
    });
    expect(rpcMocks.integrationsList).toHaveBeenCalledTimes(2);
    expect(
      container.textContent?.includes(
        "No extensions are in the built-in catalogue yet. Use Add to install an extension from a file or folder on this computer.",
      ),
    ).toBe(true);
  });

  it("renders non-empty catalogue items with Install button", async () => {
    rpcMocks.integrationsList.mockResolvedValue({
      catalog: [
        {
          id: "local-ext",
          name: "My Local Extension",
          vendor: "Acme",
          transport: "stdio",
          available: true,
        },
      ],
    });

    await act(async () => {
      root.render(<ExtensionsPage />);
    });

    const browseBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Browse extensions",
    );
    await act(async () => {
      browseBtn!.click();
    });

    expect(container.querySelector("h2")?.textContent).toBe("Browse extensions");
    expect(container.textContent?.includes("My Local Extension")).toBe(true);
    expect(container.textContent?.includes("Acme")).toBe(true);

    const dialogButtons = Array.from(
      container.querySelector('[data-testid="dialog"]')?.querySelectorAll("button") ?? [],
    );
    const installBtn = dialogButtons.find((b) => b.textContent?.trim() === "Install");
    expect(installBtn).toBeDefined();
  });

  it("renders missing desktop bridge fallback when not in desktop", async () => {
    bridgeMocks.bridge = undefined;

    await act(async () => {
      root.render(<ExtensionsPage />);
    });

    expect(container.textContent?.includes("Open the desktop app to manage extensions.")).toBe(
      true,
    );
  });
});
