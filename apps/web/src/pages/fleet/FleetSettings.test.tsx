// @vitest-environment jsdom

import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  discover: vi.fn(async () => []),
  test: vi.fn(async () => []),
  placement: vi.fn(),
  bot: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { fleet: api, computer: { connect: api.connect } } }));
const catalog = vi.hoisted(() => new Map<string, string>());
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.reduce((out, part, i) => out + part + (values[i] ?? ""), "");
    return catalog.get(text) ?? text;
  };
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Checkbox: ({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange: (checked: boolean) => void }) => (
    <input type="checkbox" {...props} onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { FleetSettings } from "./FleetSettings";
import { PlacementNotice } from "./PlacementNotice";

afterEach(() => {
  catalog.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("renders capacity and assignments, applies placement, and requests explicit move consent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue({
    targets: [
      {
        id: "host",
        name: "This Mac",
        kind: "host",
        connectionId: null,
        state: "connected",
        capacity: { ...unknownCapacity(), memoryFree: 1024 ** 3, memoryTotal: 8 * 1024 ** 3 },
        bots: [{ id: "bot", name: "Builder" }],
      },
    ],
    placement: { mode: "free-memory", preferredTargetId: "host", minimumFreeGb: 4 },
    bots: [
      {
        id: "bot",
        name: "Builder",
        moveAutomatically: false,
        pending: {
          targetId: "other",
          connectionId: "other",
          fromTargetId: "host",
          reason: "it had the most free memory",
          decidedAt: new Date().toISOString(),
        },
      },
    ],
  });
  const element = document.createElement("div"),
    root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    expect(element.textContent).toContain("1.0 GB free");
    expect(element.textContent).toContain("Builder");
    expect(element.querySelector("progress")?.value).toBe(1024 ** 3);
    expect(api.bot).not.toHaveBeenCalled();
    const move = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Move",
    )!;
    await act(async () => move.click());
    expect(api.bot).toHaveBeenCalledWith({ botId: "bot", decision: "accept" });
    const select = element.querySelector<HTMLSelectElement>('[aria-label="Placement"]')!;
    await act(async () => {
      select.value = "manual";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.placement).toHaveBeenCalledWith({
      mode: "manual",
      preferredTargetId: "host",
      minimumFreeGb: 4,
    });
  } finally {
    await act(async () => root.unmount());
  }
});
it("translates the local Docker row the API names for its platform", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  catalog.set("Docker on this computer", "Docker на этом компьютере");
  const docker = {
    id: "default",
    name: "Docker on this computer",
    kind: "docker",
    connectionId: null,
    state: "connected",
    capacity: { ...unknownCapacity(), memoryFree: 1024 ** 3, memoryTotal: 8 * 1024 ** 3 },
    bots: [],
  };
  api.list.mockResolvedValue({
    targets: [
      docker,
      { ...docker, id: "office", name: "Docker on this computer", connectionId: "office" },
    ],
    placement: { mode: "threshold", preferredTargetId: "default", minimumFreeGb: 4 },
    bots: [],
  });
  const element = document.createElement("div"),
    root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    const names = [...element.querySelectorAll("[data-fleet-target] p.font-medium")].map(
      (name) => name.textContent,
    );
    expect(names).toEqual(["Docker на этом компьютере", "Docker on this computer"]);
    const preferred = element.querySelector<HTMLSelectElement>(
      '[aria-label="Preferred computer"]',
    )!;
    expect([...preferred.options].map((option) => option.textContent)).toEqual([
      "Docker на этом компьютере",
      "Docker on this computer",
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
it("prefills a Tailscale peer without importing credentials or adding it automatically", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue({
    targets: [],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.discover.mockResolvedValue([
    {
      id: "peer",
      name: "peer.example.invalid",
      kind: "tailscale",
      connectionId: null,
      state: "discovered",
      endpoint: "100.64.0.2",
      capacity: unknownCapacity(),
      bots: [],
      ssh: {
        host: "peer.example.invalid",
        user: "runner",
        port: 22,
        authentication: "tailscale",
        baseDirectory: "~/.ardurbot/computers",
      },
    },
  ] as never);
  const element = document.createElement("div"),
    root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    expect(element.textContent).toContain("100.64.0.2");
    const add = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Add as SSH computer",
    )!;
    await act(async () => add.click());
    expect(element.querySelector<HTMLInputElement>('[aria-label="Host"]')?.value).toBe(
      "peer.example.invalid",
    );
    expect(element.querySelector<HTMLInputElement>('[aria-label="User"]')?.value).toBe("runner");
    expect(api.connect).not.toHaveBeenCalled();
    await act(async () =>
      element
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "peer.example.invalid",
        settings: expect.objectContaining({
          engine: "ssh",
          ssh: expect.objectContaining({ authentication: "tailscale" }),
        }),
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows placement consent in the conversation only while input is pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"),
    root = createRoot(element),
    open = vi.fn();
  const placement = {
    status: "pending" as const,
    targetId: "remote",
    targetName: "Linux computer",
    connectionId: "remote",
    fromTargetId: "host",
    reason: "it had the most free memory",
    decidedAt: new Date().toISOString(),
  };
  try {
    await act(async () =>
      root.render(<PlacementNotice run={{ status: "waiting_input", placement }} onOpen={open} />),
    );
    expect(element.textContent).toContain("Move to Linux computer?");
    await act(async () => element.querySelector("button")!.click());
    expect(open).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<PlacementNotice run={{ status: "running", placement }} onOpen={open} />),
    );
    expect(element.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});
