// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  tools: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    mcp: {
      servers: {
        create: api.create,
        list: api.list,
        tools: api.tools,
        update: api.update,
        remove: api.remove,
      },
      assignments: { approve: api.approve },
    },
    integrationSetup: { get: vi.fn(), save: vi.fn() },
  },
}));
vi.mock("./connect-remote-mcp", async () => {
  const actual =
    await vi.importActual<typeof import("./connect-remote-mcp")>("./connect-remote-mcp");
  return { ...actual, connectRemoteMcp: vi.fn(actual.connectRemoteMcp) };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Button: ({
    variant: _variant,
    render,
    size: _size,
    children,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string; render?: ReactNode }) =>
    render ? (
      <span>
        {render}
        {children}
      </span>
    ) : (
      <button {...props}>{children}</button>
    ),
}));

import { connectRemoteMcp } from "./connect-remote-mcp";
import { IntegrationSetup } from "./IntegrationSetup";

const setup = {
  canConfigure: true,
  needsSetup: false,
  webUrl: "https://app.example.test",
  providers: [],
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onServerConnected = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([]);
  api.remove.mockResolvedValue({ ok: true });
  api.update.mockResolvedValue({ ok: true });
  api.approve.mockResolvedValue({ id: "assignment" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () =>
    root.render(
      <IntegrationSetup serverSetup initialState={setup} onServerConnected={onServerConnected} />,
    ),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const field = [...container.querySelectorAll("label")].find((item) =>
    item.textContent?.includes(label),
  );
  const input = field?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Executor connect", () => {
  it("shows a rejected token and keeps the server", async () => {
    const server = {
      id: "executor-1",
      name: "Executor",
      endpoint: "http://localhost:8000/mcp",
      catalogId: null,
      managedBy: null,
      enabled: true,
      transport: "streamable_http",
      connectionState: "needs-sign-in",
    };
    api.list.mockResolvedValueOnce([]).mockResolvedValue([server]);
    api.create.mockResolvedValue(server);
    api.tools.mockRejectedValue(new Error("rejected"));
    await mount();
    await click("Executor");
    await fill("Server URL", "http://localhost:8000/mcp");
    await fill("Access token", "synthetic-test-value");
    await click("Connect");
    expect(container.textContent).toContain("That token was not accepted. Check it and try again.");
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalled();
    expect(onServerConnected).not.toHaveBeenCalled();
  });

  it.each([
    ["needs-credential", "Enter a credential for this server and try again."],
    ["cancelled", "Sign-in was declined. Reconnect to try again."],
    ["needs-sign-in", "Sign-in did not finish. Try again."],
  ] as const)("shows a sentence for %s and does not connect the bot", async (outcome, sentence) => {
    vi.mocked(connectRemoteMcp).mockResolvedValueOnce(outcome);
    await mount();
    await click("Executor");
    await fill("Server URL", "http://localhost:8000/mcp");
    await click("Connect");
    expect(container.textContent).toContain(sentence);
    expect(onServerConnected).not.toHaveBeenCalled();
  });

  it("connects the bot only when the server is connected", async () => {
    vi.mocked(connectRemoteMcp).mockResolvedValueOnce({ serverId: "executor-1" });
    await mount();
    await click("Executor");
    await fill("Server URL", "http://localhost:8000/mcp");
    await click("Connect");
    expect(onServerConnected).toHaveBeenCalledExactlyOnceWith("executor-1");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
