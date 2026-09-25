// @vitest-environment jsdom
import type { ComponentProps, ReactNode, Ref } from "react";
import { act, useImperativeHandle, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  roots: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  changes: vi.fn(),
  bots: vi.fn(),
  send: vi.fn(),
  find: vi.fn(),
  head: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    ide: api,
    bots: { list: api.bots },
    threads: { send: api.send, head: api.head, subscribe: api.subscribe },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((s, p, i) => s + p + (values[i] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("./terminal", () => ({
  IdeTerminal: ({ root }: { root: { computerId: string } }) => (
    <div data-terminal-computer={root.computerId}>terminal surface</div>
  ),
}));
vi.mock("./editor", () => ({
  default: ({
    document,
    onChange,
    ref,
  }: {
    document: { id: string; path: string; content: string; readOnly: boolean };
    onChange(id: string, content: string): void;
    ref: Ref<unknown>;
  }) => {
    const area = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      find: api.find,
      selection: () => {
        const el = area.current!;
        if (el.selectionStart === el.selectionEnd) return null;
        return {
          text: el.value.slice(el.selectionStart, el.selectionEnd),
          startLine: el.value.slice(0, el.selectionStart).split("\n").length,
          endLine: el.value.slice(0, el.selectionEnd - 1).split("\n").length,
        };
      },
    }));
    return (
      <textarea
        ref={area}
        data-editor
        aria-label={document.path}
        readOnly={document.readOnly}
        value={document.content}
        onChange={(e) => onChange(document.id, e.target.value)}
      />
    );
  },
}));

import IdePage from "./IdePage";

let host: HTMLDivElement, renderer: ReturnType<typeof createRoot>;
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent === name || el.getAttribute("aria-label") === name,
  )!;
const click = async (name: string) => {
  await act(async () => button(name).click());
  await tick();
};
async function type(element: HTMLTextAreaElement | HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  api.roots.mockResolvedValue([
    {
      id: "root",
      name: "Project",
      path: "/",
      kind: "sandbox",
      computerId: "computer",
      botId: "bot",
    },
  ]);
  api.list.mockImplementation(async ({ path }) => ({
    hiddenCount: 0,
    entries:
      path === ""
        ? [
            { path: "src", kind: "dir", size: 0 },
            { path: "readme.md", kind: "file", size: 5 },
          ]
        : [{ path: "src/main.ts", kind: "file", size: 20 }],
  }));
  api.read.mockImplementation(async ({ path }) => ({
    path,
    content: "first\nsecond\nthird",
    readOnly: false,
    binary: false,
    version: "a".repeat(64),
    size: 18,
  }));
  api.save.mockResolvedValue({ saved: true, approvalRequired: false, version: "b".repeat(64) });
  api.changes.mockResolvedValue({ items: [], nextCursor: null });
  api.bots.mockResolvedValue([{ id: "bot", name: "Builder" }]);
  api.send.mockResolvedValue({ runId: "run" });
  api.head.mockResolvedValue({ threadId: "thread", cursor: 0 });
  api.subscribe.mockImplementation(async function* () {});
  vi.spyOn(window, "confirm").mockReturnValue(false);
  host = document.createElement("div");
  document.body.append(host);
  renderer = createRoot(host);
  window.history.replaceState(null, "", "/app/ide");
  await act(async () =>
    renderer.render(
      <BrowserRouter>
        <Routes>
          <Route path="/app/ide" element={<IdePage />} />
          <Route path="/app" element={<p>Bots page</p>} />
        </Routes>
      </BrowserRouter>,
    ),
  );
  await tick();
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("IDE page", () => {
  it("refreshes the tree and Quick Open after shell file changes with Changes closed", async () => {
    expect(button("readme.md")).toBeDefined();
    api.list.mockResolvedValue({
      hiddenCount: 0,
      entries: [{ path: "created.txt", kind: "file", size: 4 }],
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await tick();
    expect(button("readme.md")).toBeUndefined();
    expect(button("created.txt")).toBeDefined();
    await click("Open");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("created.txt");
    expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain("readme.md");
    expect(api.changes).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
  it("shows the hidden entry count and keeps supported siblings usable", async () => {
    api.list.mockResolvedValueOnce({
      entries: [{ path: "src/main.ts", kind: "file", size: 20 }],
      hiddenCount: 2,
    });
    await click("src");
    expect(host.textContent).toContain("Some entries have unsupported names and are hidden (2).");
    await click("main.ts");
    expect(host.querySelector("textarea[data-editor]")).not.toBeNull();
  });
  it("blocks closing, switching computers and navigating while a save is in flight", async () => {
    await click("readme.md");
    await type(host.querySelector("textarea[data-editor]")!, "pending save");
    let finish!: (value: unknown) => void;
    api.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(window.confirm).mockReturnValue(true);
    await click("Save");
    expect(button("Close readme.md").disabled).toBe(true);
    const computer = host.querySelector<HTMLSelectElement>('select[aria-label="Computer"]')!;
    expect(computer.disabled).toBe(true);
    await click("Close readme.md");
    await act(async () => {
      computer.dispatchEvent(new Event("change", { bubbles: true }));
      host.querySelector<HTMLAnchorElement>('a[href="/app"]')!.click();
    });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/app/ide");
    expect(host.querySelector("textarea[data-editor]")).not.toBeNull();
    await act(async () =>
      finish({ saved: true, approvalRequired: false, version: "b".repeat(64) }),
    );
    expect(button("Close readme.md").disabled).toBe(false);
    await click("Close readme.md");
    expect(host.querySelector("textarea[data-editor]")).toBeNull();
  });
  it("polls only the open Changes drawer without opening per-bot streams", async () => {
    expect(api.head).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(api.changes).not.toHaveBeenCalled();
    await click("Changes");
    expect(api.changes).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      // Closing cancels the pending refresh; reopening schedules it with this clock.
      await act(async () => button("Changes").click());
      await act(async () => button("Changes").click());
      const calls = api.changes.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(api.changes).toHaveBeenCalledTimes(calls + 1);
      await act(async () => button("Changes").click());
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(api.changes).toHaveBeenCalledTimes(calls + 1);
      expect(api.subscribe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a large Ask a bot selection and shows the truncation before sending", async () => {
    await click("readme.md");
    const area = host.querySelector<HTMLTextAreaElement>("textarea[data-editor]")!;
    await type(area, `${"x".repeat(32_000)}OMITTED`);
    area.setSelectionRange(0, area.value.length);
    await click("Ask a bot");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Selection shortened to 32,000 characters.",
    );
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("/readme.md:1-1");
    await type(host.querySelector('textarea[aria-label="Ask a bot"]')!, "Explain");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const sent = api.send.mock.calls[0]![0].text;
    expect(sent).toContain("/readme.md:1-1");
    expect(sent).toContain("Selection shortened to 32,000 characters.");
    expect(sent).toContain("x".repeat(32_000));
    expect(sent).not.toContain("OMITTED");
    expect(sent.length).toBeLessThan(32_200);
  });
  it("loads tree directories on expansion, edits and saves a tab, and preserves a refusal", async () => {
    expect(api.list.mock.calls.map(([value]) => value.path)).toEqual([""]);
    await click("src");
    expect(api.list).toHaveBeenCalledWith({ rootId: "root", path: "src" });
    await click("main.ts");
    await tick();
    await type(host.querySelector("textarea[data-editor]")!, "edited");
    expect(host.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    await click("Save");
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        rootId: "root",
        path: "src/main.ts",
        content: "edited",
        approved: false,
      }),
    );
    expect(host.textContent).toContain("Saved");
    await type(host.querySelector("textarea[data-editor]")!, "another edit");
    api.save.mockResolvedValue({
      saved: false,
      approvalRequired: false,
      reason: "Path escapes registered folders.",
    });
    await click("Save");
    expect(host.textContent).toContain("Path escapes registered folders.");
    expect(host.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
  });
  it("guards tab close, browser unload and SPA navigation until changes are discarded", async () => {
    await click("readme.md");
    await tick();
    await type(host.querySelector("textarea[data-editor]")!, "dirty");
    await click("Close readme.md");
    expect(host.querySelector("textarea[data-editor]")).not.toBeNull();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => {
      host.querySelector<HTMLAnchorElement>('a[href="/app"]')!.click();
    });
    await tick();
    expect(window.location.pathname).toBe("/app/ide");
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => {
      host.querySelector<HTMLAnchorElement>('a[href="/app"]')!.click();
    });
    await tick();
    expect(window.location.pathname).toBe("/app");
  });
  it("shows a read-only large file and never mounts a binary file", async () => {
    api.read.mockResolvedValue({
      path: "readme.md",
      content: "preview",
      readOnly: true,
      binary: false,
      version: "a".repeat(64),
      size: 3_000_000,
    });
    await click("readme.md");
    await tick();
    expect(host.textContent).toContain("Read only: file is larger than 2 MB");
    expect(button("Save").disabled).toBe(true);
    await click("Close readme.md");
    api.read.mockResolvedValue({
      path: "readme.md",
      content: "",
      readOnly: true,
      binary: true,
      version: "a".repeat(64),
      size: 3,
    });
    await click("readme.md");
    expect(host.textContent).toContain("Binary file");
    expect(host.querySelector("textarea[data-editor]")).toBeNull();
  });
  it("finds nested names with quick-open and hands exact selected lines to a normal turn", async () => {
    await click("Open");
    await tick();
    expect(api.list).toHaveBeenCalledWith({ rootId: "root", path: "src" });
    await type(host.querySelector("input")!, "main");
    await click("src/main.ts");
    await tick();
    const area = host.querySelector<HTMLTextAreaElement>("textarea[data-editor]")!;
    area.setSelectionRange(6, 12);
    await click("Ask a bot");
    const instruction = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Ask a bot"]',
    )!;
    await type(instruction, "Explain this");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await tick();
    expect(api.send).toHaveBeenCalledWith({
      botId: "bot",
      text: "Explain this\n\n/src/main.ts:2-2\n\nsecond",
      clientNonce: expect.any(String),
    });
  });
  it("opens recorded changes as a side-by-side diff and binds the terminal drawer", async () => {
    api.changes.mockResolvedValue({
      items: [
        {
          id: "change",
          path: "src/main.ts",
          before: "old",
          after: "new",
          source: "tool",
          botId: "bot",
          runId: "run",
          createdAt: "2026-01-02T12:00:00Z",
        },
      ],
      nextCursor: null,
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await tick();
    await click("Changes");
    await click("src/main.ts");
    await vi.waitFor(async () => {
      await tick();
      expect(host.querySelector('[data-testid="ide-diff"]')?.textContent).toContain("old");
    });
    expect(host.querySelector('[data-testid="ide-diff"]')?.textContent).toContain("new");
    await click("Terminal");
    expect(host.querySelector('[data-terminal-computer="computer"]')).not.toBeNull();
  });
  it("routes save, quick-open, search and terminal shortcuts", async () => {
    await click("readme.md");
    await tick();
    await type(host.querySelector("textarea[data-editor]")!, "keyboard edit");
    const key = async (key: string, code?: string) => {
      await act(async () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await tick();
    };
    await key("s");
    expect(api.save).toHaveBeenCalledTimes(1);
    await key("f");
    expect(api.find).toHaveBeenCalledTimes(1);
    await key("`", "Backquote");
    expect(host.querySelector('[data-terminal-computer="computer"]')).not.toBeNull();
    await key("p");
    expect(host.querySelector("input[aria-label='Quick open']")).not.toBeNull();
  });
});
