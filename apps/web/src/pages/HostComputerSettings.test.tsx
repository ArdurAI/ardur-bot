// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ status: vi.fn(), disconnect: vi.fn(), clear: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { host: fake } }));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: translate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
}));

import { HostComputerSettings } from "./HostComputerSettings";

const WARNING =
  "Local access lets bots run commands without asking. Avoid it on shared or public servers.";

const containers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of containers.splice(0)) await cleanup();
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
});
async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<HostComputerSettings />));
  return container;
}
it.each([
  [false, "Not set up"],
  [true, "Not running — open the desktop app"],
])("shows the minimal disconnected copy (%s)", async (configured, copy) => {
  fake.status.mockResolvedValue({ configured, connected: false, health: null, roots: [] });
  const container = await render();
  expect(container.textContent).toContain(`Host service: ${copy}`);
  expect(container.textContent).toContain("This computer");
});
it("shows versions and registered folders, and revokes before clearing desktop storage", async () => {
  fake.status.mockResolvedValue({
    roots: ["/fixture/projects"],
    configured: true,
    connected: true,
    health: {
      roots: ["/fixture/projects"],
      claude: { version: "2.1.259" },
      codex: { version: "0.156.1" },
      environment: {
        tools: [
          { name: "gh", status: "signed in" },
          { name: "kubectl", status: "not checked" },
          { name: "docker", status: "not checked" },
        ],
        diagnostic:
          "Your login shell profile failed to load (zsh, exit 1); commands run with a default PATH",
      },
    },
  });
  window.ardurbotDesktop = {
    platform: "darwin",
    host: {
      state: async () => ({ configured: true, roots: ["/fixture/projects"] }),
      setup: vi.fn(),
      addRoot: vi.fn(),
      removeRoot: vi.fn(),
      clear: fake.clear,
    },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  const container = await render();
  expect(container.textContent).toContain("This Mac");
  expect(container.textContent).toContain(
    "Host service: Connected · claude 2.1.259 · codex 0.156.1",
  );
  expect(container.textContent).toContain("/fixture/projects");
  expect(container.textContent).toContain("Tools: gh, kubectl, docker");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Your login shell profile failed to load (zsh, exit 1)",
  );
  const disconnect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect this computer",
  )!;
  await act(async () => disconnect.click());
  expect(fake.disconnect).toHaveBeenCalledOnce();
  expect(fake.clear).toHaveBeenCalledOnce();
  expect(fake.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
    fake.clear.mock.invocationCallOrder[0]!,
  );
});

it("in local mode lists the folders this app granted, with Add folder and Remove, and no standing explainer", async () => {
  fake.status.mockResolvedValue({
    configured: false,
    connected: true,
    roots: [],
    health: { platform: "darwin", roots: [], claude: {}, codex: {} },
  });
  let folders: string[] = [];
  const addRoot = vi.fn(async () => {
    folders = ["/fixture/projects"];
    return "/fixture/projects";
  });
  const removeRoot = vi.fn(async () => {
    folders = [];
  });
  window.ardurbotDesktop = {
    platform: "darwin",
    host: {
      state: async () => ({ configured: false, local: true, roots: folders }),
      setup: vi.fn(),
      addRoot,
      removeRoot,
      clear: vi.fn(),
    },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  const container = await render();
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  expect(button("Set up")).toBeUndefined();
  expect(button("Disconnect this computer")).toBeUndefined();
  expect(container.querySelector("li")).toBeNull();
  // The only sentence is the warning that belongs to Add folder; nothing explains standing here.
  expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual([WARNING]);
  expect(container.textContent).not.toMatch(/Bots can read|approvals|advisory/);

  await act(async () => button("Add folder")!.click());
  expect(addRoot).toHaveBeenCalledOnce();
  expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "/fixture/projectsRemove",
  ]);
  await act(async () => button("Remove")!.click());
  expect(removeRoot).toHaveBeenCalledExactlyOnceWith("/fixture/projects");
  expect(container.querySelector("li")).toBeNull();
});

it("marks a folder that is gone as not available, and still offers Remove", async () => {
  fake.status.mockResolvedValue({
    configured: false,
    connected: true,
    roots: [],
    health: { platform: "darwin", roots: [], claude: {}, codex: {} },
  });
  const removeRoot = vi.fn(async () => undefined);
  window.ardurbotDesktop = {
    platform: "darwin",
    host: {
      state: async () => ({
        configured: false,
        local: true,
        roots: ["/fixture/drive", "/fixture/projects"],
        unavailable: ["/fixture/drive"],
      }),
      setup: vi.fn(),
      addRoot: vi.fn(),
      removeRoot,
      clear: vi.fn(),
    },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  const container = await render();
  expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "/fixture/driveThis folder is not available.Remove",
    "/fixture/projectsRemove",
  ]);
  const remove = container.querySelector("li button") as HTMLButtonElement;
  await act(async () => remove.click());
  expect(removeRoot).toHaveBeenCalledExactlyOnceWith("/fixture/drive");
});

it("says nothing about local folders when paired with a server", async () => {
  fake.status.mockResolvedValue({ configured: true, connected: true, health: null, roots: [] });
  window.ardurbotDesktop = {
    platform: "linux",
    host: {
      state: async () => ({ configured: true, roots: [] }),
      setup: vi.fn(),
      addRoot: vi.fn(),
      removeRoot: vi.fn(),
      clear: vi.fn(),
    },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  const container = await render();
  expect(container.textContent).toContain("Add folder");
  expect(container.textContent).not.toContain("Bots can read and change files");
  expect(container.textContent).not.toContain("a command stops after five minutes");
});

function localDesktop() {
  window.ardurbotDesktop = {
    platform: "darwin",
    host: {
      state: async () => ({ configured: false, local: true, roots: [] }),
      setup: vi.fn(),
      addRoot: vi.fn(),
      removeRoot: vi.fn(),
      clear: vi.fn(),
    },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
}
const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((button) => button.textContent);

it("in local mode shows this computer's capacity, not a host service to set up", async () => {
  localDesktop();
  fake.status.mockReturnValue(new Promise(() => undefined));
  const loading = await render();
  expect(loading.textContent).not.toContain("Host service");
  expect(buttons(loading)).not.toContain("Set up");

  fake.status.mockResolvedValue({
    configured: false,
    connected: true,
    roots: [],
    health: {
      platform: "darwin",
      roots: [],
      load: 0,
      capacity: {
        cpuCount: 8,
        cpuLoad1m: 1.5,
        memoryTotal: 16 * 1024 ** 3,
        memoryFree: 6 * 1024 ** 3,
        diskFree: 200 * 1024 ** 3,
        sampledAt: "2026-09-26T00:00:00.000Z",
        source: "host",
      },
      claude: { version: "2.1.259" },
      codex: {},
    },
  });
  const container = await render();
  expect(container.querySelector("h4")?.textContent).toBe("This Mac");
  expect(container.textContent).toContain("6.0 GB free · 8 CPU · Load 1.5 · Disk 200.0 GB");
  expect(container.textContent).toContain("claude 2.1.259");
  expect(container.textContent).not.toContain("Host service");
  expect(buttons(container)).toEqual(["Add folder"]);
});

it("in local mode never offers Set up or Disconnect, even when this account cannot inspect the host", async () => {
  localDesktop();
  fake.status.mockResolvedValue({ configured: true, connected: false, health: null, roots: [] });
  const container = await render();
  expect(container.textContent).not.toMatch(/Host service|Not set up|Not running/);
  expect(buttons(container)).toEqual(["Add folder"]);
});

it("puts the local access warning on Add folder and nowhere else", async () => {
  localDesktop();
  fake.status.mockResolvedValue({ configured: false, connected: true, health: null, roots: [] });
  const container = await render();
  const add = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Add folder",
  )!;
  const describedBy = add.getAttribute("aria-describedby");
  expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(WARNING);
  expect(container.textContent?.split(WARNING)).toHaveLength(2);

  // A browser has no Add folder, so it has no warning either.
  delete window.ardurbotDesktop;
  fake.status.mockResolvedValue({ configured: true, connected: true, health: null, roots: [] });
  const browser = await render();
  expect(buttons(browser)).not.toContain("Add folder");
  expect(browser.textContent).not.toContain(WARNING);
});
