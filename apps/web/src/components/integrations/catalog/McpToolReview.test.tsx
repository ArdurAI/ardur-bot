// @vitest-environment jsdom
import type { Bot, BotMcpServer, McpServer, SpaceToolPolicies } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { McpToolReview } from "./McpToolReview";

const api = vi.hoisted(() => ({
  tools: vi.fn(),
  list: vi.fn(),
  all: vi.fn(),
  permissions: vi.fn(),
}));
vi.mock("../../../lib/rpc", () => ({
  rpc: { mcp: { servers: api, assignments: { all: api.all } } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@ardurbot/ui-web", () => {
  const box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: box,
    DialogContent: box,
    DialogTitle: box,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Checkbox: ({
      checked,
      onCheckedChange,
      ...props
    }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange(value: boolean): void }) => (
      <input
        {...props}
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("loads an existing MCP grant, saves Ask and Block without changing other servers, and reopens it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let policies: SpaceToolPolicies = { get_item: "allow" };
  let allowedTools = ["get_item", "update_item"];
  const server = { id: "server", spaceToolPolicies: policies } as McpServer;
  const assignment = () =>
    ({
      botId: "bot",
      serverId: server.id,
      allowedTools,
      allowAllTools: false,
      needsReview: false,
    }) as BotMcpServer;
  api.tools.mockResolvedValue({
    tools: [
      { id: "get_item", description: "Read an item", inputSchemaDigest: "a".repeat(64) },
      { id: "update_item", description: "Update an item", inputSchemaDigest: "b".repeat(64) },
    ],
  });
  api.all.mockImplementation(async () => [
    assignment(),
    { ...assignment(), serverId: "other-server" },
  ]);
  api.list.mockImplementation(async () => [{ ...server, spaceToolPolicies: policies }]);
  api.permissions.mockImplementation(async (input) => {
    policies = input.spaceToolPolicies;
    allowedTools = input.toolIds;
    return [];
  });
  const onClose = vi.fn();
  const onSaved = vi.fn(async () => undefined);
  const node = document.createElement("div");
  const root = createRoot(node);
  const render = (key: number) =>
    root.render(
      <McpToolReview
        key={key}
        server={server}
        bots={[{ id: "bot", name: "Helper" } as Bot]}
        assignments={{ bot: [assignment()] }}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
  await act(async () => render(1));
  const select = (id: string) =>
    node.querySelector<HTMLSelectElement>(`[aria-label="Permission for ${id}"]`)!;
  expect(select("get_item").value).toBe("allow");
  expect([...select("update_item").options].map((option) => option.value)).toEqual([
    "ask",
    "block",
  ]);
  await act(async () => {
    select("get_item").value = "ask";
    select("get_item").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    select("update_item").value = "block";
    select("update_item").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Save")!.click(),
  );
  expect(api.permissions).toHaveBeenCalledExactlyOnceWith({
    serverId: "server",
    botIds: ["bot"],
    toolIds: ["get_item"],
    spaceToolPolicies: { get_item: "ask-first", update_item: "ask-first" },
  });
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
  await act(async () => render(2));
  expect(select("get_item").value).toBe("ask");
  expect(select("update_item").value).toBe("block");
  await act(async () => root.unmount());
});
