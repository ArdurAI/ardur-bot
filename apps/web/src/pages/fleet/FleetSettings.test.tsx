// @vitest-environment jsdom

import type { FleetTarget } from "@ardurbot/contracts";
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
  details: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
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
vi.mock("@ardurbot/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ardurbot/ui-web")>();
  return {
    ...actual,
    Checkbox: ({
      onCheckedChange,
      ...props
    }: ComponentProps<"input"> & { onCheckedChange: (checked: boolean) => void }) => (
      <input
        type="checkbox"
        {...props}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { Dialog, DialogContent } from "@ardurbot/ui-web";
import { discoveredFormKind, FleetSettings } from "./FleetSettings";
import { PlacementNotice } from "./PlacementNotice";

afterEach(() => {
  catalog.clear();
  vi.clearAllMocks();
  api.discover.mockResolvedValue([]);
  vi.unstubAllGlobals();
});
it("maps each discovered kind into the right connection form", () => {
  const target = { endpoint: "unix:///fixture/docker.sock" } as FleetTarget;
  expect(discoveredFormKind({ ...target, kind: "docker" })).toBe("docker");
  expect(discoveredFormKind({ ...target, kind: "podman" })).toBe("docker");
  expect(
    discoveredFormKind({ ...target, kind: "podman", endpoint: "unix:///fixture/podman.sock" }),
  ).toBe("podman");
  expect(discoveredFormKind({ ...target, kind: "kubernetes" })).toBe("kubernetes");
  expect(discoveredFormKind({ ...target, kind: "ssh" })).toBe("ssh");
  expect(discoveredFormKind({ ...target, kind: "tailscale" })).toBe("ssh");
  expect(
    discoveredFormKind({
      ...target,
      kind: "docker",
      endpoint: "unix:///fixture/.colima/default/docker.sock",
    }),
  ).toBe("docker");
});

it("confirms removal, shows pinned-bot refusal, and leaves discovered rows without Remove", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = {
    id: "saved",
    name: "Office",
    kind: "docker",
    connectionId: "saved",
    state: "connected",
    capacity: unknownCapacity(),
    bots: [{ id: "example", name: "Example" }],
  };
  api.list.mockResolvedValue({
    targets: [saved],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.discover.mockResolvedValue([
    { ...saved, id: "found", state: "discovered", connectionId: null, bots: [] },
  ] as never);
  api.remove.mockRejectedValue(new Error("1 bot runs on this computer: Example. Move it first."));
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    expect(element.querySelector('[data-fleet-target="found"]')?.textContent).not.toContain(
      "Remove",
    );
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>('[data-fleet-target="saved"] button:last-child')!
        .click(),
    );
    expect(document.body.textContent).toContain(
      "Its saved connection and credentials will be deleted. Past run history remains.",
    );
    expect(document.body.textContent).toContain("Bots on this computer: Example");
    const dialog = document.body.querySelector('[aria-label="Remove computer"]')!;
    const remove = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "Remove",
    )!;
    await act(async () => remove.click());
    expect(api.remove).toHaveBeenCalledWith({ connectionId: "saved" });
    expect(dialog.textContent).toContain("1 bot runs on this computer: Example. Move it first.");
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it("prefills Edit and saves a renamed target through fleet.update", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = {
    id: "saved",
    name: "Office",
    kind: "docker",
    connectionId: "saved",
    state: "connected",
    endpoint: "unix:///fixture/docker.sock",
    capacity: unknownCapacity(),
    bots: [],
  };
  api.list.mockResolvedValue({
    targets: [saved],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.details.mockResolvedValue({
    id: "saved",
    name: "Office",
    settings: {
      engine: "docker",
      endpoint: "unix:///fixture/docker.sock",
      namespace: "ardurbot",
      storageSize: "10Gi",
      cpuRequest: "250m",
      cpuLimit: "2",
      memoryRequest: "256Mi",
      memoryLimit: "2Gi",
    },
    hasCredential: false,
    activeRuns: false,
  });
  api.update.mockResolvedValue({ ok: true, checkedAt: new Date().toISOString(), targets: [] });
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    const edit = [
      ...element.querySelectorAll<HTMLButtonElement>('[data-fleet-target="saved"] button'),
    ].find((button) => button.textContent === "Edit")!;
    await act(async () => edit.click());
    const dialog = document.body.querySelector('[aria-label="Edit computer"]')!;
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("Office");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Engine endpoint"]')?.value).toBe(
      "unix:///fixture/docker.sock",
    );
    const name = dialog.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        name,
        "Workshop",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      dialog
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "saved",
        connection: expect.objectContaining({ name: "Workshop" }),
      }),
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
it("warns before changing a connection with an active run", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = {
    id: "saved",
    name: "Office",
    kind: "docker",
    connectionId: "saved",
    state: "connected",
    endpoint: "unix:///fixture/docker.sock",
    capacity: unknownCapacity(),
    bots: [],
  };
  api.list.mockResolvedValue({
    targets: [saved],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.details.mockResolvedValue({
    id: "saved",
    name: "Office",
    settings: {
      engine: "docker",
      endpoint: "unix:///fixture/docker.sock",
      namespace: "ardurbot",
      storageSize: "10Gi",
      cpuRequest: "250m",
      cpuLimit: "2",
      memoryRequest: "256Mi",
      memoryLimit: "2Gi",
    },
    hasCredential: false,
    activeRuns: true,
  });
  api.update.mockResolvedValue({ ok: true, checkedAt: new Date().toISOString(), targets: [] });
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    const edit = [
      ...element.querySelectorAll<HTMLButtonElement>('[data-fleet-target="saved"] button'),
    ].find((button) => button.textContent === "Edit")!;
    await act(async () => edit.click());
    const dialog = document.body.querySelector('[aria-label="Edit computer"]')!;
    const endpoint = dialog.querySelector<HTMLInputElement>('[aria-label="Engine endpoint"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        endpoint,
        "unix:///fixture/new.sock",
      );
      endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      dialog
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(dialog.textContent).toContain("Saving this connection change may interrupt them");
    expect(api.update).not.toHaveBeenCalled();
    await act(async () =>
      dialog
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ confirmActive: true }));
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
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
it("names built-in rows by their key and the API's host label, and saved connections as named", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  catalog.set("This Mac", "Этот Mac");
  catalog.set("Docker engine on this Mac", "Docker на этом Mac");
  catalog.set("Default computer", "Компьютер по умолчанию");
  const row = {
    kind: "docker",
    connectionId: null,
    state: "connected",
    capacity: { ...unknownCapacity(), memoryFree: 1024 ** 3, memoryTotal: 8 * 1024 ** 3 },
    bots: [],
  };
  api.list.mockResolvedValue({
    targets: [
      { ...row, id: "host", name: "This computer", kind: "host", builtin: "host" },
      { ...row, id: "default", name: "Default computer", kind: "e2b", builtin: "default" },
      { ...row, id: "docker", name: "Docker on this computer", builtin: "local-docker" },
      { ...row, id: "office", name: "This Mac", connectionId: "office" },
    ],
    hostLabel: "This Mac",
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
    const translated = ["Этот Mac", "Компьютер по умолчанию", "Docker на этом Mac", "This Mac"];
    expect(names).toEqual(translated);
    const preferred = element.querySelector<HTMLSelectElement>(
      '[aria-label="Preferred computer"]',
    )!;
    expect([...preferred.options].map((option) => option.textContent)).toEqual(translated);
  } finally {
    await act(async () => root.unmount());
  }
});
it("shows probe reasons and checks without reporting memory for unreachable engines", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const checkedAt = "2026-09-27T18:00:00.000Z";
  const base = { kind: "docker" as const, capacity: unknownCapacity(), bots: [] };
  api.list.mockResolvedValue({
    targets: [
      {
        ...base,
        id: "saved",
        name: "Docker Desktop on this Mac",
        connectionId: "saved",
        state: "unavailable",
        reachability: { status: "installed-not-running", reason: "engine-not-running", checkedAt },
      },
      {
        ...base,
        id: "remote",
        name: "Remote engine",
        connectionId: "remote",
        state: "unavailable",
        reachability: { status: "not-reachable", reason: "timed-out", checkedAt },
      },
      {
        ...base,
        id: "running",
        name: "Running engine",
        connectionId: "running",
        state: "connected",
        reachability: { status: "running", checkedAt },
      },
    ],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.discover.mockResolvedValue([
    {
      ...base,
      id: "found",
      name: "OrbStack on this Mac",
      connectionId: null,
      state: "discovered",
      reachability: { status: "installed-not-running", reason: "socket-missing", checkedAt },
    },
  ] as never);
  const element = document.createElement("div"),
    root = createRoot(element);
  try {
    await act(async () => root.render(<FleetSettings />));
    const row = (id: string) =>
      element.querySelector(`[data-fleet-target="${id}"]`)?.textContent ?? "";
    expect(row("saved")).toContain("Installed, not running · Engine not running");
    expect(row("saved")).toContain("Checked");
    expect(row("remote")).toContain("Not reachable · Timed out");
    expect(row("found")).toContain("Socket missing");
    expect(row("saved")).not.toContain("Memory not reported");
    expect(row("running")).toContain("Memory not reported");
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
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="Host"]')?.value).toBe(
      "peer.example.invalid",
    );
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="User"]')?.value).toBe(
      "runner",
    );
    expect(api.connect).not.toHaveBeenCalled();
    await act(async () =>
      document.body
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

function SettingsWrapper({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent aria-label="Settings" data-testid="user-settings">
        {children}
      </DialogContent>
    </Dialog>
  );
}

it("opens Add computer dialog with prefilled engine from discovered row, and Escape closes only Add dialog with focus restore", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue({
    targets: [],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.discover.mockResolvedValue([
    {
      id: "docker-engine",
      name: "Docker Desktop on this Mac",
      kind: "docker",
      connectionId: null,
      state: "discovered",
      endpoint: "/fixture/docker-desktop.sock",
      capacity: unknownCapacity(),
      bots: [],
    },
  ] as never);

  const onSettingsClose = vi.fn();
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(
        <SettingsWrapper onClose={onSettingsClose}>
          <FleetSettings />
        </SettingsWrapper>,
      ),
    );

    expect(document.body.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Add computer"]')).toBeNull();

    const add = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Add",
    )!;
    add.focus();
    expect(document.activeElement).toBe(add);

    await act(async () => add.click());

    const dialog = document.body.querySelector<HTMLElement>('[aria-label="Add computer"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector("h2")?.textContent).toBe("Add computer");
    expect(dialog.querySelector("form")).not.toBeNull();

    expect(
      document.body.querySelector<HTMLSelectElement>('[aria-label="Connection type"]')?.value,
    ).toBe("docker");
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe(
      "Docker Desktop on this Mac",
    );
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Engine endpoint"]')?.value,
    ).toBe("/fixture/docker-desktop.sock");

    // Pressing Escape closes only the nested Add dialog, not Settings, and restores focus
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(document.body.querySelector('[aria-label="Add computer"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(onSettingsClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(add);

    // Re-open and verify Cancel button also closes only Add dialog
    await act(async () => add.click());
    expect(document.body.querySelector('[aria-label="Add computer"]')).not.toBeNull();
    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )!;
    await act(async () => cancel.click());
    expect(document.body.querySelector('[aria-label="Add computer"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(onSettingsClose).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    element.remove();
    document.body.innerHTML = "";
  }
});

it("opens empty Add computer dialog from header, protects pending saves, handles rejected saves, and closes on resolved save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue({
    targets: [],
    bots: [],
    placement: { mode: "manual", preferredTargetId: "host", minimumFreeGb: 4 },
  });
  api.discover.mockResolvedValue([]);
  const changed = vi.fn();
  window.addEventListener("fleet:changed", changed);

  const onSettingsClose = vi.fn();
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);

  const changeInput = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  try {
    await act(async () =>
      root.render(
        <SettingsWrapper onClose={onSettingsClose}>
          <FleetSettings />
        </SettingsWrapper>,
      ),
    );

    const headerAdd = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Add computer",
    )!;
    headerAdd.focus();
    await act(async () => headerAdd.click());

    const dialog = document.body.querySelector<HTMLElement>('[aria-label="Add computer"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector("h2")?.textContent).toBe("Add computer");

    // Defaults are empty for SSH
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("");
    expect(
      document.body.querySelector<HTMLSelectElement>('[aria-label="Connection type"]')?.value,
    ).toBe("ssh");
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="Host"]')?.value).toBe("");
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="User"]')?.value).toBe("");

    const nameInput = document.body.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    const hostInput = document.body.querySelector<HTMLInputElement>('[aria-label="Host"]')!;
    const userInput = document.body.querySelector<HTMLInputElement>('[aria-label="User"]')!;
    await act(async () => {
      changeInput(nameInput, "Remote Box");
      changeInput(hostInput, "box.local");
      changeInput(userInput, "admin");
    });

    // 1. Deferred save keeps dialog open with Cancel disabled and Escape ignored
    let rejectConnect!: (error: unknown) => void;
    api.connect.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectConnect = reject;
        }),
    );

    await act(async () => {
      document.body
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Remote Box",
        settings: expect.objectContaining({
          engine: "ssh",
          ssh: expect.objectContaining({ host: "box.local", user: "admin" }),
        }),
      }),
    );

    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )! as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);

    // Escape is ignored while save is pending; dialog remains open
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(document.body.querySelector('[aria-label="Add computer"]')).not.toBeNull();
    expect(onSettingsClose).not.toHaveBeenCalled();

    // 2. Rejected save shows error and re-enables Cancel
    await act(async () => {
      rejectConnect(new Error("Unable to connect to computer: host unreachable"));
    });

    expect(document.body.textContent).toContain(
      "Could not add the computer. Check its settings and try again.",
    );
    expect(cancel.disabled).toBe(false);

    // Cancel now successfully closes the dialog
    await act(async () => cancel.click());
    expect(document.body.querySelector('[aria-label="Add computer"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(onSettingsClose).not.toHaveBeenCalled();

    // 3. Resolved save closes dialog, refreshes list, and emits fleet:changed
    await act(async () => headerAdd.click());
    expect(document.body.querySelector('[aria-label="Add computer"]')).not.toBeNull();

    await act(async () => {
      changeInput(
        document.body.querySelector<HTMLInputElement>('[aria-label="Name"]')!,
        "Remote Box 2",
      );
      changeInput(
        document.body.querySelector<HTMLInputElement>('[aria-label="Host"]')!,
        "box2.local",
      );
      changeInput(document.body.querySelector<HTMLInputElement>('[aria-label="User"]')!, "admin2");
    });

    const initialListCalls = api.list.mock.calls.length;
    api.connect.mockResolvedValueOnce({ id: "box-2" });

    await act(async () => {
      document.body
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('[aria-label="Add computer"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(onSettingsClose).not.toHaveBeenCalled();
    expect(api.list.mock.calls.length).toBeGreaterThan(initialListCalls);
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("fleet:changed", changed);
    await act(async () => root.unmount());
    element.remove();
    document.body.innerHTML = "";
  }
});
