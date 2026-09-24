// @vitest-environment jsdom
import type { MemoryDocumentHead } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  history: vi.fn(),
  restore: vi.fn(),
  import: vi.fn(),
  export: vi.fn(),
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

import { GitMemorySettings } from "./GitMemorySettings";
import { MemoryHistory } from "./MemoryHistory";
import { MemoryImportExport } from "./MemoryImportExport";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";

const doc: MemoryDocumentHead = {
  id: "doc",
  documentId: "doc",
  revision: 2,
  scopeKey: { kind: "user", spaceId: "space", userId: "user" },
  path: "fact.md",
  content: "After",
  author: { kind: "bot", userId: "user", botId: "bot" },
  model: { provider: "local", modelId: "fixture", effort: "high" },
  runId: "run",
  threadId: "thread",
  references: [],
  createdAt: "2026-09-23T12:00:00.000Z",
  updatedAt: "2026-09-23T12:00:00.000Z",
  deletedAt: null,
  delivery: { status: "delivered", generation: 0, provider: null },
};
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
function button(container: HTMLElement, label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
describe("memory settings lifecycle views", () => {
  it("shows provenance and before/after history and restores with the current revision", async () => {
    const onChange = vi.fn();
    api.history.mockResolvedValue({
      items: [doc, { ...doc, revision: 1, content: "Before" }],
      nextCursor: null,
    });
    api.restore.mockResolvedValue({ ...doc, revision: 3, content: "Before" });
    await mounted(<MemoryHistory document={doc} onChange={onChange} />, async (container) => {
      expect(container.textContent).toContain("local · fixture · high");
      expect(container.textContent).toContain("Before");
      await act(async () => button(container, "Revision 1").click());
      await act(async () => button(container, "Restore").click());
      expect(api.restore).toHaveBeenCalledWith({
        documentId: "doc",
        revision: 1,
        expectedRevision: 2,
      });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }));
    });
  });
  it("previews an import without writes, then confirms the exact preview hash", async () => {
    const revision = {
      documentId: doc.id,
      revision: 1,
      scopeKey: doc.scopeKey,
      path: doc.path,
      content: "Fact",
      author: doc.author,
      model: doc.model,
      runId: doc.runId,
      threadId: doc.threadId,
      references: [],
      createdAt: doc.createdAt,
      deletedAt: null,
    };
    const bundle = { version: 1, documents: [{ id: doc.id, revisions: [revision] }] };
    api.import.mockResolvedValue({
      hash: "preview-hash",
      documents: 1,
      revisions: 1,
      conflicts: [],
      scopes: [],
    });
    const onImported = vi.fn();
    await mounted(<MemoryImportExport onImported={onImported} />, async (container) => {
      const input = container.querySelector('input[type="file"]')!;
      Object.defineProperty(input, "files", {
        value: [{ size: 100, text: async () => JSON.stringify(bundle) }],
      });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(api.import).not.toHaveBeenCalled();
      await act(async () => button(container, "Preview import").click());
      expect(api.import).toHaveBeenLastCalledWith({ bundle, remapping: {} });
      expect(onImported).not.toHaveBeenCalled();
      await act(async () => button(container, "Import").click());
      expect(api.import).toHaveBeenLastCalledWith({
        bundle,
        remapping: {},
        expectedHash: "preview-hash",
      });
      expect(onImported).toHaveBeenCalledOnce();
    });
  });
  it("defaults to built-in, enables Git, and previews a vault switch before applying", async () => {
    api.location
      .mockResolvedValueOnce({
        hash: "migration-hash",
        documents: 2,
        revisions: 4,
        conflicts: [],
        scopes: [],
        generation: 0,
        config: null,
      })
      .mockResolvedValueOnce({
        config: { provider: "builtin", documentStore: "obsidian", generation: 1 },
      });
    const onConfigChange = vi.fn();
    await mounted(
      <MemorySettingsOverlay
        embedded
        config={null}
        onConfigChange={onConfigChange}
        onClose={() => undefined}
      />,
      async (container) => {
        const location = container.querySelector("select")!;
        expect(location.value).toBe("postgres");
        expect(container.querySelector('option[value="git"]')).toHaveProperty("disabled", false);
        await act(async () => {
          location.value = "obsidian";
          location.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(container.textContent).toContain("This path is on your server");
        await act(async () => button(container, "Preview migration").click());
        expect(api.location).toHaveBeenCalledTimes(0);
        // A path must be entered before a migration can be previewed.
        const input = container.querySelector("input")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            input,
            "/fixture/empty-folder",
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => button(container, "Preview migration").click());
        expect(api.location).toHaveBeenCalledWith({
          location: "obsidian",
          folder: "/fixture/empty-folder",
          expectedGeneration: 0,
        });
        expect(onConfigChange).not.toHaveBeenCalled();
        await act(async () => button(container, "Use this location").click());
        expect(api.location).toHaveBeenLastCalledWith({
          location: "obsidian",
          folder: "/fixture/empty-folder",
          expectedGeneration: 0,
          expectedHash: "migration-hash",
        });
      },
    );
  });
  it("tests a Git connection, clears the credential, and confirms the reviewed proposal mode", async () => {
    const config = {
      provider: "builtin",
      documentStore: "git",
      documentSettings: { host: "github.com" },
      generation: 1,
    };
    api.gitLocation
      .mockResolvedValueOnce({
        hash: "git-preview",
        connectionId: "encrypted-connection",
        documents: 1,
        revisions: 2,
        conflicts: [],
        scopes: [],
        generation: 0,
        config: null,
      })
      .mockResolvedValueOnce({ config });
    const changed = vi.fn();
    await mounted(
      <GitMemorySettings config={null} onConfigChange={changed} onBusyChange={() => undefined} />,
      async (container) => {
        const fill = async (label: string, value: string) =>
          act(async () => {
            const input = container.querySelector(`input[aria-label="${label}"]`)!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
              input,
              value,
            );
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
        await fill("Repository URL", "https://github.com/fixture/memory.git");
        await fill("Repository token", "fixture-credential");
        await act(async () => {
          const mode = container.querySelector<HTMLSelectElement>(
            'select[aria-label="Publication mode"]',
          )!;
          mode.value = "propose";
          mode.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await act(async () => button(container, "Test connection and preview").click());
        expect(changed).not.toHaveBeenCalled();
        expect(
          container.querySelector<HTMLInputElement>('input[aria-label="Repository token"]')!.value,
        ).toBe("");
        expect(container.textContent).toContain(
          "Shared recall will use proposed facts after merge.",
        );
        await act(async () => button(container, "Use this location").click());
        expect(api.gitLocation).toHaveBeenLastCalledWith({
          url: "https://github.com/fixture/memory.git",
          branch: "main",
          mode: "propose",
          expectedGeneration: 0,
          connectionId: "encrypted-connection",
          expectedHash: "git-preview",
        });
        expect(changed).toHaveBeenCalledWith(config);
      },
    );
  });
});
