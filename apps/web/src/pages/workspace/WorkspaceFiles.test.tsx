// @vitest-environment jsdom
import type { Bot, WorkspaceContext } from "@ardurbot/contracts";
import type { MessageDescriptor } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode, Ref } from "react";
import { act, useImperativeHandle, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceFileSessions } from "./file-sessions";
import { WorkspaceFileGuard } from "./WorkspaceFileGuard";
import { WorkspaceFiles } from "./WorkspaceFiles";

const api = vi.hoisted(() => ({
  describe: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    workspace: { describe: api.describe, list: api.list, read: api.read, save: api.save },
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
    // The real editor keeps a tab's text until its id changes.
    const [seenId, setSeenId] = useState(document.id);
    const [text, setText] = useState(document.content);
    if (document.id !== seenId) {
      setSeenId(document.id);
      setText(document.content);
    }
    useImperativeHandle(ref, () => ({
      find: vi.fn(),
      selection: () => (area.current ? { text: "hello", startLine: 1, endLine: 1 } : null),
    }));
    return (
      <textarea
        ref={area}
        data-editor
        data-document-id={seenId}
        aria-label={document.path}
        readOnly={document.readOnly}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(document.id, event.target.value);
        }}
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
async function show(
  botId = "bot",
  next: Partial<WorkspaceContext> = {},
  location?: { path: string; line?: number; requestId: number },
) {
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
                <WorkspaceFiles bot={bot} context={fileContext} location={location} />
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
  vi.resetAllMocks();
  api.describe.mockResolvedValue({ ...context, generation: 3 });
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
  it("opens a checked path intent in the bot root and keeps its draft on repeated navigation", async () => {
    await show("bot", { rootId: "sandbox-computer" }, { path: "notes.md", line: 2, requestId: 1 });
    expect(api.read).toHaveBeenCalledWith({
      botId: "bot",
      computerId: "computer",
      generation: 2,
      rootId: "sandbox-computer",
      path: "notes.md",
    });
    await type("draft from IDE");
    await show("bot", { rootId: "sandbox-computer" }, { path: "notes.md", line: 3, requestId: 2 });
    expect(host.querySelector("textarea")?.value).toBe("draft from IDE");
    expect(api.read).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "retains a conflicted draft when an intent is replayed after reopening (host: %s)",
    async (runsOnHost) => {
      const location = { path: "notes.md", line: 2, requestId: 1 };
      await show("bot", { rootId: "sandbox-computer", runsOnHost }, location);
      if (runsOnHost) expect(host.textContent).toContain("This computer · bot's folder");
      await type("conflicted intent draft");
      api.save.mockResolvedValueOnce({
        saved: false,
        approvalRequired: false,
        reason: "The file changed. Open it again before saving.",
      });
      await click("Save");
      await act(async () => renderer.render(null));
      await show("bot", { rootId: "sandbox-computer", runsOnHost }, location);
      expect(host.querySelector("textarea")?.value).toBe("conflicted intent draft");
      expect(api.read).toHaveBeenCalledTimes(1);
      await show("bot", { rootId: "sandbox-computer", runsOnHost }, { ...location, requestId: 2 });
      expect(host.querySelector("textarea")?.value).toBe("conflicted intent draft");
      expect(api.read).toHaveBeenCalledTimes(1);
    },
  );
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

    const serverVersion = "d".repeat(64);
    const previousId = host.querySelector("textarea")?.getAttribute("data-document-id");
    api.read.mockResolvedValueOnce({
      context,
      path: "notes.md",
      content: "from disk",
      size: 9,
      binary: false,
      readOnly: false,
      version: serverVersion,
    });
    await click("notes.md");
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("textarea")?.value).toBe("from disk");
    expect(host.querySelector("[role='alert']")).toBeNull();
    const nextId = host.querySelector("textarea")?.getAttribute("data-document-id");
    expect(nextId).toBeTruthy();
    expect(nextId).not.toBe(previousId);
    expect(nextId).toContain(serverVersion);
    await type("from disk!");
    await click("Save");
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "from disk!", version: serverVersion }),
    );
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

  it("keeps unsaved edits visible when the computer stops and its generation changes", async () => {
    await click("notes.md");
    await type("dirty notes");
    await show("bot", { generation: 3, files: "saved" });
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");

    await act(async () => renderer.unmount());
    renderer = createRoot(host);
    await show("bot", { generation: 4, files: "saved" });
    expect(host.querySelector("textarea")?.value).toBe("dirty notes");
    await click("Leave");
    expect(host.textContent).not.toContain("Left the conversation");

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await click("Close notes.md");
    expect(host.querySelector("textarea")).toBeNull();
    await click("Leave");
    expect(host.textContent).toContain("Left the conversation");
  });

  it("describes a failed save with the server reason, not a load error", async () => {
    await click("notes.md");
    await type("hello!");
    api.save.mockRejectedValueOnce(
      new ORPCError("CONFLICT", { message: "The computer is busy. Wait for it to finish." }),
    );
    await click("Save");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "The computer is busy. Wait for it to finish.",
    );
    expect(host.textContent).not.toContain("Could not load files. Try again.");

    api.save.mockRejectedValueOnce(
      new ORPCError("CONFLICT", { message: "Computer changed. Refresh files." }),
    );
    await click("Save");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "Computer changed. Refresh files.",
    );

    api.save.mockRejectedValueOnce(new Error("socket hang up"));
    await click("Save");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "Could not save this file. Try again.",
    );

    api.save.mockResolvedValueOnce({
      saved: false,
      approvalRequired: false,
      reason: "The file changed. Open it again before saving.",
    });
    await click("Save");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "The file changed. Open it again before saving.",
    );
  });

  it("describes a deleted file with an action instead of a generic failure", async () => {
    await click("notes.md");
    await type("hello!");
    api.save.mockResolvedValueOnce({
      saved: false,
      approvalRequired: false,
      reason: "This file no longer exists. Save it as a new file or close it.",
    });
    await click("Save");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "This file no longer exists. Save it as a new file or close it.",
    );
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
    expect(host.textContent).toContain("This is a binary file. You cannot edit it here.");
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
    expect(host.textContent).toContain("This file is larger than 2 MB. Open a copy to edit it.");
    expect(button("Save")?.disabled).toBe(true);
  });
});

const changed = () => new ORPCError("CONFLICT", { message: "Computer changed. Refresh files." });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workspace generation recovery", () => {
  it("recovers the opening list once and publishes the binding without repeated directory reads", async () => {
    api.list.mockClear().mockRejectedValueOnce(changed());
    const publish = vi.fn();
    await act(async () =>
      renderer.render(
        <WorkspaceFiles
          bot={{ id: "bot", name: "bot" } as Bot}
          context={context}
          onContextChange={publish}
        />,
      ),
    );
    await tick();
    await tick();
    expect(api.describe).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 3 }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ generation: 3 }));
    expect(button("notes.md")).toBeDefined();
    expect(host.querySelector("[role=alert]")).toBeNull();
    await tick();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("recovers a file read and retains its draft through another recovery and a save conflict", async () => {
    api.read.mockRejectedValueOnce(changed());
    await click("notes.md");
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 3 }));
    expect(host.querySelector("textarea")?.value).toBe("hello");
    expect(host.querySelector("[role=alert]")).toBeNull();
    await type("draft");
    api.describe.mockResolvedValueOnce({ ...context, generation: 4 });
    api.list.mockRejectedValueOnce(changed());
    await click("Refresh");
    expect(host.querySelector("textarea")?.value).toBe("draft");
    api.save.mockRejectedValueOnce(changed());
    await click("Save");
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 4, version, approved: false }),
    );
    expect(api.describe).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      "Computer changed. Refresh files.",
    );
    expect(host.querySelector("textarea")?.value).toBe("draft");
  });

  it("recovers nested folders and quick open through the same list path", async () => {
    api.list.mockImplementation(async ({ path }) => ({
      context,
      entries: path
        ? [{ path: "src/nested.md", kind: "file", size: 5 }]
        : [{ path: "src", kind: "dir", size: 0 }],
    }));
    await click("Refresh");
    api.list.mockRejectedValueOnce(changed());
    await click("src");
    expect(button("nested.md")).toBeDefined();
    expect(api.describe).toHaveBeenCalledTimes(1);
    api.describe.mockResolvedValueOnce({ ...context, generation: 4 });
    api.list.mockRejectedValueOnce(changed());
    await click("Quick open");
    expect(host.querySelector("[role=option]")?.textContent).toBe("src/nested.md");
    expect(api.describe).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  it("coalesces parallel stale tree and file reads into one describe", async () => {
    const refresh = deferred<WorkspaceContext>();
    api.describe.mockReturnValueOnce(refresh.promise);
    api.read.mockRejectedValueOnce(changed());
    await click("notes.md");
    api.list.mockRejectedValueOnce(changed());
    await click("Refresh");
    expect(api.describe).toHaveBeenCalledTimes(1);
    await act(async () => refresh.resolve({ ...context, generation: 3 }));
    await tick();
    await tick();
    expect(host.querySelector("textarea")?.value).toBe("hello");
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(api.read).toHaveBeenCalledTimes(2);
  });

  it.each(["list", "read"] as const)(
    "shows the safe sentence after two %s conflicts without a third attempt",
    async (operation) => {
      api[operation].mockClear().mockRejectedValueOnce(changed()).mockRejectedValueOnce(changed());
      await click(operation === "list" ? "Refresh" : "notes.md");
      expect(api[operation]).toHaveBeenCalledTimes(2);
      expect(api.describe).toHaveBeenCalledTimes(1);
      expect(host.querySelector("[role=alert]")?.textContent).toBe(
        "Computer changed. Refresh files.",
      );
      await tick();
      expect(api[operation]).toHaveBeenCalledTimes(2);
      if (operation === "list") {
        await click("Refresh");
        expect(button("notes.md")).toBeDefined();
      }
    },
  );

  it("shows a safe refresh failure and keeps Refresh usable", async () => {
    api.list.mockRejectedValueOnce(changed());
    api.describe.mockRejectedValueOnce(
      new ORPCError("CONFLICT", { message: "Files are unavailable on this computer." }),
    );
    await click("Refresh");
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      "Files are unavailable on this computer.",
    );
    expect(api.list).toHaveBeenCalledTimes(2); // initial list plus the failed refresh
    await click("Refresh");
    expect(button("notes.md")).toBeDefined();
  });

  it.each([
    new ORPCError("CONFLICT", { message: "The computer is busy. Wait for it to finish." }),
    new ORPCError("BAD_REQUEST", { message: "Computer changed. Refresh files." }),
    new Error("Computer changed. Refresh files."),
    new ORPCError("INTERNAL_SERVER_ERROR", { message: "private diagnostic" }),
  ])("does not retry an unrelated or untrusted failure: %s", async (error) => {
    api.read.mockRejectedValueOnce(error);
    await click("notes.md");
    expect(api.describe).not.toHaveBeenCalled();
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR"
        ? error.message
        : "Could not load files. Try again.",
    );
  });

  it.each([
    { files: "unavailable" as const },
    { computerId: "replacement", rootId: "replacement-root" },
    { rootId: "replacement-root" },
  ])("does not replay a file read after the binding changes: %s", async (replacement) => {
    api.read.mockRejectedValueOnce(changed());
    api.describe.mockResolvedValueOnce({ ...context, generation: 3, ...replacement });
    await click("notes.md");
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("[role=alert]")).toBeNull();
    if (replacement.files)
      expect(host.textContent).toContain("Files are unavailable on this computer.");
  });

  it.each(["unmount", "bot", "root", "generation"])(
    "discards a late file response after %s changes",
    async (change) => {
      const pending = deferred<Awaited<ReturnType<typeof api.read>>>();
      api.read.mockReturnValueOnce(pending.promise);
      await click("notes.md");
      if (change === "unmount") await act(async () => renderer.render(null));
      else
        await show(
          change === "bot" ? "other" : "bot",
          change === "root"
            ? { rootId: "other-root" }
            : change === "generation"
              ? { generation: 5 }
              : {},
        );
      await act(async () =>
        pending.resolve({
          context,
          path: "notes.md",
          content: "late data",
          size: 9,
          binary: false,
          readOnly: false,
          version,
        }),
      );
      await tick();
      expect(host.querySelector("textarea")).toBeNull();
      await show();
      expect(host.querySelector("textarea")).toBeNull();
    },
  );

  it("discards a describe completed after switching bots", async () => {
    const refresh = deferred<WorkspaceContext>();
    api.describe.mockReturnValueOnce(refresh.promise);
    api.read.mockRejectedValueOnce(changed());
    await click("notes.md");
    await show("other");
    await act(async () => refresh.resolve({ ...context, generation: 3 }));
    await tick();
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[role=alert]")).toBeNull();
  });
});

it("does not replay a location intent when recovery replaces its root", async () => {
  api.read.mockRejectedValueOnce(changed());
  api.describe.mockResolvedValueOnce({ ...context, rootId: "replacement-root", generation: 3 });
  await show("bot", {}, { path: "notes.md", requestId: 1 });
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(host.querySelector("textarea")).toBeNull();
});

it("loads a newer external binding and ignores its old pending directory response", async () => {
  const pending = deferred<{ entries: { path: string; kind: string; size: number }[] }>();
  api.list.mockReturnValueOnce(pending.promise);
  await click("Refresh");
  api.list.mockResolvedValueOnce({ entries: [{ path: "current.md", kind: "file", size: 5 }] });
  await show("bot", { generation: 5 });
  expect(button("current.md")).toBeDefined();
  await act(async () =>
    pending.resolve({ entries: [{ path: "obsolete.md", kind: "file", size: 5 }] }),
  );
  await tick();
  expect(button("obsolete.md")).toBeUndefined();
  expect(button("current.md")).toBeDefined();
});
