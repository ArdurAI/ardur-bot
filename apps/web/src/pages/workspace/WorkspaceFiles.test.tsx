// @vitest-environment jsdom
import type { Bot, WorkspaceContext } from "@ardurbot/contracts";
import type { MessageDescriptor } from "@lingui/core";
import type { ComponentProps, ReactNode, Ref } from "react";
import { act, useImperativeHandle, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceFileSessions } from "./file-sessions";
import { WorkspaceFileGuard } from "./WorkspaceFileGuard";
import { WorkspaceFiles } from "./WorkspaceFiles";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    workspace: { list: api.list, read: api.read, save: api.save },
    threads: { send: api.send },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (value: MessageDescriptor) => value.message ?? value.id } }),
}));
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
      find: vi.fn(),
      selection: () => (area.current ? { text: "hello", startLine: 1, endLine: 1 } : null),
    }));
    return (
      <textarea
        ref={area}
        data-editor
        aria-label={document.path}
        readOnly={document.readOnly}
        value={document.content}
        onChange={(event) => onChange(document.id, event.target.value)}
      />
    );
  },
}));

const context: WorkspaceContext = {
  botId: "bot",
  computerId: "computer",
  generation: 2,
  files: "live",
  observedAt: "2026-09-28T00:00:00.000Z",
};
const version = "a".repeat(64);
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
const tick = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === name || element.getAttribute("aria-label") === name,
  );
const click = async (name: string) => {
  const target = button(name);
  if (!target) throw new Error(`Missing button ${name}`);
  await act(async () => target.click());
  await tick();
  await tick();
};
async function type(text: string) {
  const element = host.querySelector("textarea");
  if (!element) throw new Error("Missing editor");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      element,
      text,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function Leave() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/elsewhere")}>
      Leave
    </button>
  );
}
async function show(botId = "bot", next: Partial<WorkspaceContext> = {}) {
  const bot = { id: botId, name: botId } as Bot;
  const fileContext = { ...context, botId, ...next };
  window.history.replaceState(null, "", "/");
  await act(async () =>
    renderer.render(
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <WorkspaceFileGuard />
                <WorkspaceFiles bot={bot} context={fileContext} />
                <Leave />
              </>
            }
          />
          <Route path="/elsewhere" element={<p>Left the conversation</p>} />
        </Routes>
      </BrowserRouter>,
    ),
  );
  await tick();
  await tick();
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetWorkspaceFileSessions();
  vi.clearAllMocks();
  api.list.mockResolvedValue({
    context,
    entries: [{ path: "notes.md", kind: "file", size: 5 }],
  });
  api.read.mockImplementation(async ({ path }: { path: string }) => ({
    context,
    path,
    content: "hello",
    size: 5,
    binary: false,
    readOnly: false,
    version,
  }));
  api.save.mockResolvedValue({ saved: true, approvalRequired: false, version: "b".repeat(64) });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  host = document.createElement("div");
  document.body.append(host);
  renderer = createRoot(host);
  await show();
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  host.remove();
  resetWorkspaceFileSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace files", () => {
  it("opens, edits, and saves a file with the IDE's approval and conflict protection", async () => {
    await click("notes.md");
    const editor = host.querySelector("textarea");
    expect(editor?.value).toBe("hello");
    expect(editor?.readOnly).toBe(false);
    expect(api.read).toHaveBeenCalledTimes(1);
    await click("notes.md");
    expect(api.read).toHaveBeenCalledTimes(1);

    await type("hello!");
    expect(button("Save")?.disabled).toBe(false);
    await click("Save");
    expect(api.save).toHaveBeenCalledWith({
      botId: "bot",
      computerId: "computer",
      generation: 2,
      path: "notes.md",
      content: "hello!",
      version,
      approved: false,
    });
    expect(host.textContent).toContain("Saved");
    expect(button("Save")?.disabled).toBe(true);

    await type("hello again");
    api.save.mockResolvedValueOnce({ saved: false, approvalRequired: true });
    api.save.mockResolvedValueOnce({
      saved: true,
      approvalRequired: false,
      version: "c".repeat(64),
    });
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await click("Save");
    expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ approved: true }));
    expect(host.textContent).toContain("Saved");

    await type("conflicted");
    api.save.mockResolvedValueOnce({
      saved: false,
      approvalRequired: false,
      reason: "The file changed. Open it again before saving.",
    });
    await click("Save");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "The file changed. Open it again before saving.",
    );
    expect(host.querySelector("textarea")?.value).toBe("conflicted");
  });

  it("keeps an unsaved buffer across tabs, bots, refresh, and closing the pane", async () => {
    await click("notes.md");
    await type("dirty notes");
    await click("Refresh");
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click("Close notes.md");
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");
    await click("Leave");
    expect(host.textContent).not.toContain("Left the conversation");
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");

    await show("other");
    expect(host.querySelector("textarea")).toBeNull();
    await show("bot");
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");
    expect(api.read).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
    renderer = createRoot(host);
    await show("bot");
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");
    expect(api.read).toHaveBeenCalledTimes(1);

    await show("bot", { computerId: null, generation: null, files: "unavailable" });
    expect(host.textContent).toContain("Files are unavailable on this computer.");
    await show("bot");
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");
  });

  it("shows binary and oversized files without opening an editable buffer", async () => {
    api.read.mockResolvedValueOnce({
      context,
      path: "notes.md",
      content: "",
      size: 2,
      binary: true,
      readOnly: true,
      version,
    });
    await click("notes.md");
    expect(host.textContent).toContain("Binary file");
    expect(host.querySelector("textarea")).toBeNull();

    api.read.mockResolvedValueOnce({
      context,
      path: "notes.md",
      content: "partial",
      size: 9,
      binary: false,
      readOnly: true,
      version,
    });
    await click("notes.md");
    expect(host.querySelector("textarea")?.readOnly).toBe(true);
    expect(host.querySelector("textarea")?.value).toBe("partial");
    expect(host.textContent).toContain("Read only: file is larger than 2 MB");
    expect(button("Save")?.disabled).toBe(true);
  });
});
