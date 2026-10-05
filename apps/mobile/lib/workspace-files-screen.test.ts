// @vitest-environment jsdom
import type { WorkspaceContext } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FilesScreen from "../app/ide";
import { rpc } from "./api";
import { activateUiLocale } from "./i18n";
import { RpcServerError } from "./rpc-error";

const fakes = vi.hoisted(() => ({ params: { botId: "bot" } as { botId?: string }, paired: false }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./dispatch", () => ({ hasPairedDevice: async () => fakes.paired }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => fakes.params,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => h("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => h("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    h("span", { role: accessibilityRole }, children),
  ActivityIndicator: () => h("span", null, "Loading"),
  Button: ({ title, onPress, disabled }: { title: string; onPress(): void; disabled?: boolean }) =>
    h("button", { type: "button", onClick: onPress, disabled }, title),
}));
const context: WorkspaceContext = {
  botId: "bot",
  computerId: "computer",
  rootId: "root",
  generation: 2,
  files: "live",
  observedAt: "2026-09-28T00:00:00.000Z",
};
const changed = () => new RpcServerError("Computer changed. Refresh files.", "CONFLICT");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let describeCount: number;
let listCount: number;
let readCount: number;
let failures: "list" | "read" | null;
let remaining: number;
let replacement: Partial<WorkspaceContext>;
const tick = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
};
async function show() {
  await act(async () => root.render(h(FilesScreen)));
  await tick();
  await tick();
}
async function click(name: string) {
  const button = [...host.querySelectorAll("button")].find((button) => button.textContent === name);
  if (!button) throw new Error(`Missing button ${name}`);
  await act(async () => button.click());
  await tick();
  await tick();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activateUiLocale("en");
  fakes.params = { botId: "bot" };
  fakes.paired = false;
  describeCount = 0;
  listCount = 0;
  readCount = 0;
  remaining = 1;
  failures = null;
  replacement = {};
  vi.mocked(rpc)
    .mockReset()
    .mockImplementation(async (name, input) => {
      if (name === "workspace/describe")
        return {
          ...context,
          botId: (input as { botId: string }).botId,
          generation: ++describeCount === 1 ? 2 : 3,
          ...(describeCount > 1 ? replacement : {}),
        };
      if (name === "workspace/list") {
        listCount++;
        if (failures === "list" && remaining-- > 0) throw changed();
        return { entries: [{ path: "notes.md", kind: "file", size: 5 }] };
      }
      if (name === "workspace/read") {
        readCount++;
        if (failures === "read" && remaining-- > 0) throw changed();
        return { path: "notes.md", content: "File contents", binary: false };
      }
      if (name === "ide/roots") return [{ id: "registered", name: "Registered" }];
      if (name === "ide/list")
        return { entries: [{ path: "registered.md", kind: "file", size: 5 }] };
      if (name === "ide/read") return { content: "Registered contents", binary: false };
      throw new Error(`Unexpected procedure ${name}`);
    });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activateUiLocale("en");
  vi.unstubAllGlobals();
});

it.each(["list", "read"] as const)(
  "recovers mobile bot %s once with the returned root and generation",
  async (operation) => {
    failures = operation;
    await show();
    if (operation === "read") await click("notes.md");
    expect(describeCount).toBe(2);
    expect(operation === "list" ? listCount : readCount).toBe(2);
    expect(vi.mocked(rpc)).toHaveBeenCalledWith(
      `workspace/${operation}`,
      expect.objectContaining({ rootId: "root", generation: 3 }),
      ...(operation === "list" ? [expect.anything()] : []),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(operation === "list" ? "notes.md" : "File contents");
  },
);
it.each(["list", "read"] as const)(
  "shows the server sentence after a second mobile %s conflict",
  async (operation) => {
    failures = operation;
    remaining = 2;
    await show();
    if (operation === "read") await click("notes.md");
    expect(describeCount).toBe(2);
    expect(operation === "list" ? listCount : readCount).toBe(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Computer changed. Refresh files.",
    );
    await tick();
    expect(operation === "list" ? listCount : readCount).toBe(2);
    await click("Retry");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);
it.each(["ru", "zh-CN"] as const)(
  "translates the second-failure sentence in %s",
  async (locale) => {
    failures = "list";
    remaining = 2;
    activateUiLocale(locale);
    await show();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      locale === "ru" ? "Компьютер изменился. Обновите файлы." : "计算机已更改。请刷新文件。",
    );
  },
);
it.each([
  { files: "unavailable" as const },
  { rootId: "replacement-root" },
  { computerId: "replacement-computer", rootId: "replacement-root" },
])("does not replay an old mobile path on a replaced or unavailable target: %s", async (next) => {
  failures = "read";
  replacement = next;
  await show();
  await click("notes.md");
  expect(readCount).toBe(1);
  expect(host.textContent).not.toContain("File contents");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  if (next.files) expect(host.textContent).toContain("Files are unavailable on this computer.");
});
it("keeps paired-device files unavailable without describing a workspace", async () => {
  fakes.paired = true;
  await show();
  expect(host.textContent).toContain("Sign in to browse files.");
  expect(rpc).not.toHaveBeenCalled();
});
it("keeps the separate registered-root flow", async () => {
  fakes.params = {};
  await show();
  await click("registered.md");
  expect(host.textContent).toContain("Registered contents");
  expect(describeCount).toBe(0);
});
it.each(["bot", "unmount"])("ignores a mobile file response after %s changes", async (change) => {
  let resolve!: (value: unknown) => void;
  await show();
  vi.mocked(rpc).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await click("notes.md");
  if (change === "bot") {
    fakes.params = { botId: "other" };
    await show();
  } else await act(async () => root.render(null));
  await act(async () => resolve({ content: "Late contents", binary: false }));
  await tick();
  expect(host.textContent).not.toContain("Late contents");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("uses the generic fallback for an untrusted error without retry", async () => {
  await show();
  vi.mocked(rpc).mockRejectedValueOnce(new Error("Computer changed. Refresh files."));
  await click("notes.md");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load");
  expect(describeCount).toBe(1);
});

it("shows a safe describe failure without retrying the read", async () => {
  await show();
  vi.mocked(rpc)
    .mockRejectedValueOnce(changed())
    .mockRejectedValueOnce(
      new RpcServerError("Files are unavailable on this computer.", "CONFLICT"),
    );
  await click("notes.md");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Files are unavailable on this computer.",
  );
  const readCalls = vi.mocked(rpc).mock.calls.filter(([name]) => name === "workspace/read");
  expect(readCalls).toHaveLength(1);
});
it("does not retry an unrelated typed conflict", async () => {
  await show();
  vi.mocked(rpc).mockRejectedValueOnce(
    new RpcServerError("Files are unavailable on this computer.", "CONFLICT"),
  );
  await click("notes.md");
  expect(describeCount).toBe(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Files are unavailable on this computer.",
  );
});
