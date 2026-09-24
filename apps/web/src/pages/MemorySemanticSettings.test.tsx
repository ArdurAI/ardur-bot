// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  testProvider: vi.fn(),
  location: vi.fn(),
  connectProvider: vi.fn(),
  deliveryProgress: vi.fn(async () => ({ total: 3, delivered: 1, pending: 1, failed: 1 })),
  syncState: vi.fn(async () => null),
}));
vi.mock("../lib/rpc", () => ({ rpc: { memory: api } }));
vi.mock("./KnowledgeSection", () => ({ SpaceMemorySection: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((s, p, i) => s + p + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Field: Container,
    FieldLabel: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor} {...props}>
        {children}
      </label>
    ),
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    Toggle: Container,
  };
});

import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import {
  GraphitiSettingsForm,
  Mem0OssSettingsForm,
  Mem0SettingsForm,
} from "./memory-providers/ExternalMemorySettingsForm";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount(element: ReactNode, run: (container: HTMLDivElement) => Promise<void>) {
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
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(input: HTMLSelectElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("semantic memory Settings", () => {
  it("discloses the platform host before submitting and clears the password after a successful test", async () => {
    const connect = vi.fn(async () => true);
    await mount(<Mem0SettingsForm busy={false} onConnect={connect} />, async (container) => {
      expect(container.textContent).toContain("Sends memory text to api.mem0.ai");
      const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
      await fill(key, "fixture-placeholder");
      await act(async () => button(container, "Test connection").click());
      expect(connect).toHaveBeenCalledWith({
        settings: { baseUrl: "https://api.mem0.ai" },
        credentials: { apiKey: "fixture-placeholder" },
      });
      expect(key.value).toBe("");
    });
  });
  it.each([Mem0OssSettingsForm, GraphitiSettingsForm])(
    "accepts optional credentials and shows only the selected host",
    async (Form) => {
      const connect = vi.fn(async () => true);
      await mount(<Form busy={false} onConnect={connect} />, async (container) => {
        await fill(
          container.querySelector<HTMLInputElement>('input[type="url"]')!,
          "https://memory.example.test/service",
        );
        expect(container.textContent).toContain("Sends memory text to memory.example.test");
        await act(async () => button(container, "Test connection").click());
        expect(connect).toHaveBeenCalledWith({
          settings: { baseUrl: "https://memory.example.test/service" },
          credentials: {},
        });
      });
    },
  );
  it("requires a successful connection test and a document preview before saving the service", async () => {
    api.testProvider.mockResolvedValue({ ok: true });
    api.location.mockResolvedValue({ documents: 2, revisions: 3, hash: "preview", conflicts: [] });
    api.connectProvider.mockResolvedValue({ provider: "graphiti" });
    const changed = vi.fn();
    await mount(
      <MemorySettingsOverlay
        embedded
        config={null}
        onClose={() => undefined}
        onConfigChange={changed}
      />,
      async (container) => {
        await select(container.querySelector("select")!, "service");
        await select(container.querySelector('select[aria-label="Memory service"]')!, "graphiti");
        await fill(
          container.querySelector<HTMLInputElement>('input[type="url"]')!,
          "https://memory.example.test",
        );
        await act(async () => button(container, "Test connection").click());
        expect(api.testProvider).toHaveBeenCalledWith({
          provider: "graphiti",
          settings: { baseUrl: "https://memory.example.test" },
          credentials: {},
        });
        expect(api.connectProvider).not.toHaveBeenCalled();
        expect(container.textContent).toContain("2 documents, 3 revisions");
        await act(async () => button(container, "Use this location").click());
        expect(api.connectProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "graphiti",
            expectedHash: "preview",
            expectedGeneration: 0,
          }),
        );
        expect(changed).toHaveBeenCalled();
      },
    );
  });
  it("keeps a failed connection test from previewing or saving", async () => {
    api.testProvider.mockRejectedValue(new Error("offline"));
    await mount(
      <MemorySettingsOverlay
        embedded
        config={null}
        onClose={() => undefined}
        onConfigChange={() => undefined}
      />,
      async (container) => {
        await select(container.querySelector("select")!, "service");
        await select(container.querySelector('select[aria-label="Memory service"]')!, "graphiti");
        await fill(
          container.querySelector<HTMLInputElement>('input[type="url"]')!,
          "http://127.0.0.1:8000",
        );
        await act(async () => button(container, "Test connection").click());
        expect(api.location).not.toHaveBeenCalled();
        expect(api.connectProvider).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("retry");
      },
    );
  });
  it("shows the configured destination and indexing count without revealing credentials", async () => {
    await mount(
      <MemorySettingsOverlay
        embedded
        config={{
          provider: "graphiti",
          settings: { baseUrl: "https://memory.example.test" },
          documentStore: "postgres",
          documentSettings: {},
          generation: 1,
          defaultMemoryScope: "isolated",
          updatedAt: "2026-09-23T12:00:00Z",
        }}
        onClose={() => undefined}
        onConfigChange={() => undefined}
      />,
      async (container) => {
        expect(container.textContent).toContain("Sends memory text to memory.example.test");
        expect(container.querySelector('[role="status"]')?.textContent).toBe(
          "Indexed 1 of 3 · 1 failed",
        );
      },
    );
  });
});
