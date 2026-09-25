// @vitest-environment jsdom

import {
  localImportFixture,
  localImportServerFixture,
  localImportStatusFixture,
} from "@ardurbot/testkit/local-import-fixtures";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ImportedServerCredentials } from "./ImportedServerCredentials";
import { LocalImportPage } from "./LocalImportPage";

const fake = vi.hoisted(() => ({
  status: vi.fn(),
  run: vi.fn(),
  configure: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { localImport: fake } }));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: translate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Checkbox: ({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange: (checked: boolean) => void }) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
  Switch: ({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange: (checked: boolean) => void }) => (
    <input
      {...props}
      type="checkbox"
      role="switch"
      aria-checked={props.checked ?? false}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
  vi.clearAllMocks();
});
async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  await act(async () => root.render(<LocalImportPage />));
  return node;
}
function button(node: HTMLElement, text: string) {
  return [...node.querySelectorAll("button")].find((button) => button.textContent === text)!;
}
it("shows counts and privacy, previews only on request, imports selected categories and undoes", async () => {
  let imported = false;
  fake.status.mockImplementation(async () => ({
    ...localImportStatusFixture,
    importedAt: imported ? "2026-09-24T12:00:00.000Z" : null,
    imported: imported ? [{ tool: "claude-code", count: 1 }] : [],
  }));
  fake.run.mockImplementation(async (action) => {
    if (action.action === "preview")
      return { preview: { item: localImportFixture.items[0], content: "A fixture memory body." } };
    if (action.action === "import") imported = true;
    if (action.action === "undo") imported = false;
    return {
      result: {
        created: action.action === "import" ? 1 : 0,
        updated: 0,
        unchanged: 0,
        removed: action.action === "undo" ? 1 : 0,
        skipped: 0,
        conflicts: 0,
      },
    };
  });
  const node = await render();
  expect(node.textContent).toContain("Found on this Mac");
  expect(node.textContent).toContain("Memory folders: 1 · Notes: 1");
  expect(node.textContent).toContain("never their sign-ins, tokens or chat history");
  expect(node.textContent).not.toContain("A fixture memory body.");
  expect(node.querySelector('[role="switch"]')).toBeNull();
  await act(async () => button(node, "build.md").click());
  expect(node.textContent).toContain("A fixture memory body.");
  await act(async () => (node.querySelector("#claude-code-skills") as HTMLInputElement).click());
  await act(async () => button(node, "Import all").click());
  expect(fake.run).toHaveBeenLastCalledWith({
    action: "import",
    scanId: localImportFixture.scanId,
    tool: "claude-code",
    categories: ["instructions", "memories", "servers"],
  });
  expect((node.querySelector('[role="switch"]') as HTMLInputElement).checked).toBe(false);
  await act(async () => button(node, "Remove imported items from Claude Code").click());
  expect(fake.run).toHaveBeenLastCalledWith({ action: "undo", tool: "claude-code" });
});
it("scans automatically on first open and gives a retry action on host failure", async () => {
  fake.status.mockResolvedValue({ ...localImportStatusFixture, manifest: null });
  fake.run.mockRejectedValue(new Error("private diagnostic"));
  const node = await render();
  expect(fake.run).toHaveBeenCalledWith({ action: "scan" });
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("then re-scan");
  expect(node.textContent).not.toContain("private diagnostic");
  expect(button(node, "Re-scan").disabled).toBe(false);
});
it("keeps the first import's selection when enabling automatic import without reopening", async () => {
  let status = { ...localImportStatusFixture };
  fake.status.mockImplementation(async () => status);
  fake.run.mockImplementation(async (action) => {
    status = {
      ...status,
      importedAt: "2026-09-24T12:00:00.000Z",
      selection: { [action.tool]: action.categories },
    };
    return {};
  });
  fake.configure.mockResolvedValue({});
  const node = await render();
  await act(async () => button(node, "Import all").click());
  await act(async () => (node.querySelector('[role="switch"]') as HTMLInputElement).click());
  expect(fake.configure).toHaveBeenLastCalledWith({
    autoImport: true,
    selection: { "claude-code": ["instructions", "memories", "skills", "servers"] },
  });
});
it("sends only newly entered credentials and clears the password field after save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.credentials.mockResolvedValue({ ok: true });
  const onSaved = vi.fn(async () => undefined);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  await act(async () =>
    root.render(<ImportedServerCredentials server={localImportServerFixture} onSaved={onSaved} />),
  );
  await act(async () => button(node, "Set up credentials").click());
  const input = node.querySelector("input")!;
  expect(input.type).toBe("password");
  expect(input.value).toBe("");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "newly-entered-value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(node, "Save credentials").click());
  expect(fake.credentials).toHaveBeenCalledWith({
    serverId: "imported-server",
    env: { API_KEY: "newly-entered-value" },
    headers: {},
  });
  expect(onSaved).toHaveBeenCalledOnce();
  await act(async () => button(node, "Set up credentials").click());
  expect(node.querySelector("input")!.value).toBe("");
});
it("persists a category change immediately when automatic import is enabled", async () => {
  fake.status.mockResolvedValue({
    ...localImportStatusFixture,
    autoImport: true,
    importedAt: "2026-09-24T12:00:00.000Z",
    selection: { "claude-code": ["memories", "skills"] },
  });
  fake.configure.mockResolvedValue({});
  const node = await render();
  await act(async () => (node.querySelector("#claude-code-skills") as HTMLInputElement).click());
  expect(fake.configure).toHaveBeenCalledWith({ selection: { "claude-code": ["memories"] } });
});

it("persists the displayed selection when enabling automatic import and restores it on reopen", async () => {
  let status = {
    ...localImportStatusFixture,
    autoImport: false,
    importedAt: "2026-09-24T12:00:00.000Z",
    selection: { "claude-code": ["memories", "skills"] },
  };
  fake.status.mockImplementation(async () => status);
  fake.configure.mockImplementation(async (input) => {
    status = { ...status, ...input };
    return status;
  });
  const node = await render();
  await act(async () => (node.querySelector("#claude-code-memories") as HTMLInputElement).click());
  expect(fake.configure).not.toHaveBeenCalled();
  await act(async () => (node.querySelector("#local-import-auto") as HTMLInputElement).click());
  expect(fake.configure).toHaveBeenLastCalledWith({
    autoImport: true,
    selection: { "claude-code": ["skills"] },
  });
  const reopened = await render();
  expect((reopened.querySelector("#local-import-auto") as HTMLInputElement).checked).toBe(true);
  expect((reopened.querySelector("#claude-code-memories") as HTMLInputElement).checked).toBe(false);
  expect((reopened.querySelector("#claude-code-skills") as HTMLInputElement).checked).toBe(true);
});
