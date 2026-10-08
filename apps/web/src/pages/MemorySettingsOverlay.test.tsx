// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  location: vi.fn(),
  connectProvider: vi.fn(),
  setDefaultScope: vi.fn(),
  gitLocation: vi.fn(),
  syncState: vi.fn(async () => null),
  retrySync: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    memory: api,
    me: async () => ({ spaceId: "space", userId: "user" }),
    bots: { list: async () => [] },
  },
}));
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: vi.fn() }));
vi.mock("./KnowledgeSection", () => ({
  SpaceMemorySection: () => <div>Documents and Skills</div>,
}));
vi.mock("./memory-providers/registry", () => {
  const entry = {
    id: "fixture",
    name: "Fixture service",
    SettingsForm: () => <div>Service settings</div>,
  };
  return {
    defaultMemoryProviderSettings: () => entry,
    memoryProviderSettings: () => entry,
    MEMORY_PROVIDER_SETTINGS: [entry],
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Dialog: Container,
    DialogContent: Container,
    DialogClose: Container,
    DialogTitle: Container,
    DialogDescription: Container,
  };
});

import { MemorySettingsOverlay } from "./MemorySettingsOverlay";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mounted(element: ReactNode, run: (container: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

it("shows the Git repository form exactly once when Git is chosen as the location", async () => {
  await mounted(
    <MemorySettingsOverlay
      embedded
      config={null}
      onConfigChange={() => undefined}
      onClose={() => undefined}
    />,
    async (container) => {
      const location = container.querySelector("select")!;
      expect(location.value).toBe("postgres");
      await act(async () => {
        location.value = "git";
        location.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelectorAll('[data-testid="git-memory-settings"]')).toHaveLength(1);
      const urlLabels = [...container.querySelectorAll("label")].filter((label) =>
        label.textContent?.includes("Repository URL"),
      );
      expect(urlLabels).toHaveLength(1);
      expect(container.querySelectorAll('input[aria-label="Repository URL"]')).toHaveLength(1);
      expect(container.querySelectorAll('select[aria-label="Publication mode"]')).toHaveLength(1);
      expect(
        container.querySelectorAll('select[aria-label="Repository authentication"]'),
      ).toHaveLength(1);
    },
  );
});

it("shows the Git repository form exactly once when Git is already configured", async () => {
  await mounted(
    <MemorySettingsOverlay
      embedded
      config={
        {
          provider: "builtin",
          documentStore: "git",
          documentSettings: {
            url: "https://github.com/fixture/memory.git",
            branch: "main",
            mode: "publish",
            host: "github.com",
          },
          generation: 3,
        } as never
      }
      onConfigChange={() => undefined}
      onClose={() => undefined}
    />,
    async (container) => {
      const location = container.querySelector("select")!;
      expect(location.value).toBe("git");
      expect(container.querySelectorAll('[data-testid="git-memory-settings"]')).toHaveLength(1);
      expect(container.querySelectorAll('input[aria-label="Repository URL"]')).toHaveLength(1);
      expect(container.querySelectorAll('select[aria-label="Publication mode"]')).toHaveLength(1);
    },
  );
});

it("keeps the chosen location and a single Publication mode control when the config loads late", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    embedded: true,
    onConfigChange: () => undefined,
    onClose: () => undefined,
  };
  try {
    await act(async () => root.render(<MemorySettingsOverlay {...props} config={undefined} />));
    const location = container.querySelector("select")!;
    await act(async () => {
      location.value = "git";
      location.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(location.value).toBe("git");
    // The saved config arrives after the user already picked Git (the screenshot-job race).
    await act(async () =>
      root.render(
        <MemorySettingsOverlay
          {...props}
          config={
            {
              provider: "builtin",
              documentStore: "postgres",
              documentSettings: {},
              generation: 0,
              defaultMemoryScope: "isolated",
            } as never
          }
        />,
      ),
    );
    expect(container.querySelectorAll('[data-testid="git-memory-settings"]')).toHaveLength(1);
    expect(container.querySelectorAll('select[aria-label="Publication mode"]')).toHaveLength(1);
    expect(container.querySelector("select")!.value).toBe("git");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
