// @vitest-environment jsdom

import type { ComputerStatus } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  engine: vi.fn(async () => ({ name: "docker", rootless: false })),
  configure: vi.fn(async () => ({})),
}));
vi.mock("../lib/rpc", () => ({ rpc: { computer: api } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = (props: ComponentProps<"button">) => <button {...props} />;
  return {
    Button,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    AlertDialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogCancel: Button,
    AlertDialogAction: Button,
  };
});

import { ComputerProfile, deploymentDefaultEngine } from "./ComputerProfilesSettings";

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});
const status: ComputerStatus = {
  botId: "bot",
  computerId: "computer",
  kind: "docker",
  imageProfile: "base",
  connectionId: null,
  mode: "team",
  state: "stopped",
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: false,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: "saved",
  busyBotName: null,
  canUpdate: true,
};
it("does not request recreation until the profile confirmation is accepted", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[]}
        onChanged={async () => {}}
      />,
    ),
  );
  const select = element.querySelector<HTMLSelectElement>('[aria-label="Image profile"]')!;
  await act(async () => {
    select.value = "developer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  await act(async () => button("Apply").click());
  expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "This replaces the computer's files. Continue?",
  );
  expect(api.configure).not.toHaveBeenCalled();
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "developer",
    connectionId: null,
    confirmed: true,
  });
  await act(async () => root.unmount());
});
it("shows unavailable controls from Kubernetes capability flags", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{
          ...status,
          kind: "kubernetes",
          capabilities: { graphical: false, interactiveTerminal: false },
        }}
        connections={[]}
        onChanged={async () => {}}
      />,
    ),
  );
  expect(element.textContent).toContain("Screen and terminal: Not available on this computer");
  await act(async () => root.unmount());
});

it("keeps a connectionless computer on its engine and does not offer deployment default", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[]}
        onChanged={async () => {}}
      />,
    ),
  );
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect(connection.disabled).toBe(true);
  expect([...connection.options].map((option) => option.textContent)).toEqual(["Docker"]);
  expect(element.textContent).toContain("Engine: Docker");
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.textContent).toContain(
    "Add a connection under Settings, Connections, to move this computer to another machine.",
  );
  expect(api.engine).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("shows a desktop computer as this computer when This Mac is off and hides image profiles", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, kind: "desktop" }}
        connections={[]}
        onChanged={async () => {}}
      />,
    ),
  );
  expect(element.textContent).toMatch(/This Mac|This computer/);
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.textContent).not.toContain("Engine: Docker");
  expect(element.textContent).toContain(
    "Add a connection under Settings, Connections, to move this computer to another machine.",
  );
  expect(api.engine).not.toHaveBeenCalled();
  expect(element.querySelector('[aria-label="Image profile"]')).toBeNull();
  await act(async () => root.unmount());
});

it("moves a connectionless computer to a saved connection and explains when none exist", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[
          { id: "engine", name: "Other machine", settings: { engine: "docker" } as never },
        ]}
        onChanged={async () => {}}
      />,
    ),
  );
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect(connection.disabled).toBe(false);
  expect([...connection.options].map((option) => option.textContent)).toEqual([
    "Docker",
    "Other machine",
  ]);
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.textContent).not.toContain("This Mac");
  expect(element.textContent).not.toContain("Moving this computer between engines");
  await act(async () => {
    connection.value = "engine";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "base",
    connectionId: "engine",
    confirmed: true,
  });
  api.configure.mockClear();
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[]}
        onChanged={async () => {}}
      />,
    ),
  );
  const empty = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect(empty.disabled).toBe(true);
  expect([...empty.options].map((option) => option.textContent)).toEqual(["Docker"]);
  expect(element.textContent).toContain(
    "Add a connection under Settings, Connections, to move this computer to another machine.",
  );
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.textContent).not.toContain("This Mac");
  await act(async () => root.unmount());
});

it("treats This Mac as the deployment default only when that engine is selected", () => {
  expect(deploymentDefaultEngine({ sandboxProvider: "docker", computerHost: "this-mac" })).toBe(
    "this-mac",
  );
  expect(deploymentDefaultEngine({ sandboxProvider: "desktop", computerHost: null })).toBe(
    "this-mac",
  );
  expect(deploymentDefaultEngine({ sandboxProvider: "docker", computerHost: null })).toBe("docker");
  expect(deploymentDefaultEngine({ sandboxProvider: "docker", computerHost: "docker" })).toBe(
    "docker",
  );
  expect(deploymentDefaultEngine({ sandboxProvider: "kubernetes", computerHost: null })).toBe(
    "other",
  );
});

it("labels a desktop computer This Mac on darwin and This computer on linux", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, kind: "desktop" }}
        connections={[{ id: "ssh", name: "Office", settings: { engine: "ssh" } as never }]}
        onChanged={async () => {}}
      />,
    );
  window.ardurbotDesktop = { platform: "darwin" } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => render());
  const options = () =>
    [...element.querySelectorAll<HTMLOptionElement>('[aria-label="Connection"] option')].map(
      (option) => option.textContent,
    );
  expect(element.textContent).toContain("Engine: This Mac");
  expect(options()).toEqual(["This Mac", "Office"]);
  expect(element.textContent).not.toContain("This computer");
  window.ardurbotDesktop = { platform: "linux" } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => render());
  expect(element.textContent).toContain("Engine: This computer");
  expect(options()).toEqual(["This computer", "Office"]);
  expect(element.textContent).not.toContain("This Mac");
  window.ardurbotDesktop = { platform: "MacIntel" } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => render());
  expect(element.textContent).toContain("Engine: This Mac");
  expect(options()[0]).toBe("This Mac");
  delete window.ardurbotDesktop;
  await act(async () => root.unmount());
});

it("offers Deployment default (Docker) only when Docker is the deployment default", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  const ssh = { ...status, kind: "ssh" as const, connectionId: "office" };
  const connections = [
    { id: "office", name: "Office", settings: { engine: "ssh" } as never },
    { id: "lab", name: "Lab", settings: { engine: "ssh" } as never },
  ];
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={ssh}
        connections={connections}
        deploymentDefault="this-mac"
        onChanged={async () => {}}
      />,
    ),
  );
  const hidden = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect([...hidden.options].map((option) => option.textContent)).toEqual(["Office", "Lab"]);
  expect(hidden.value).toBe("office");
  expect(element.textContent).not.toContain("Deployment default");
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={ssh}
        connections={connections}
        deploymentDefault="docker"
        onChanged={async () => {}}
      />,
    ),
  );
  const shown = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect([...shown.options].map((option) => option.textContent)).toEqual([
    "Deployment default (Docker)",
    "Office",
    "Lab",
  ]);
  await act(async () => {
    shown.value = "";
    shown.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "base",
    connectionId: null,
    confirmed: true,
  });
  await act(async () => root.unmount());
});

it("still moves a connected computer to another saved connection or the deployment default", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, connectionId: "engine" }}
        connections={[
          { id: "engine", name: "Local", settings: { engine: "docker" } as never },
          { id: "remote", name: "Remote", settings: { engine: "podman" } as never },
        ]}
        onChanged={async () => {}}
      />,
    ),
  );
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect([...connection.options].map((option) => option.textContent)).toEqual([
    "Deployment default (Docker)",
    "Local",
    "Remote",
  ]);
  expect(element.textContent).not.toContain("Moving this computer between engines");
  await act(async () => {
    connection.value = "remote";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "base",
    connectionId: "remote",
    confirmed: true,
  });
  await act(async () => root.unmount());
});

it("shows the saved connection names and names both machines in the move dialog", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  const options = () =>
    [...element.querySelectorAll<HTMLOptionElement>('[aria-label="Connection"] option')].map(
      (option) => option.textContent,
    );
  const home = { ...status, kind: "ssh" as const, connectionId: "home" };
  const connections = [
    { id: "home", name: "Home", settings: { engine: "ssh" } as never },
    { id: "office", name: "Office", settings: { engine: "ssh" } as never },
  ];
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={home}
        connections={connections}
        deploymentDefault="this-mac"
        onChanged={async () => {}}
      />,
    ),
  );
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect(connection.value).toBe("home");
  expect(options()).toEqual(["Home", "Office"]);
  for (const kind of ["ssh", "Docker", "Kubernetes", "Podman", "E2B", "Daytona", "Box"])
    expect(options()).not.toContain(kind);
  await act(async () => {
    connection.value = "office";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "This moves the computer from Home to Office and replaces its files. Continue?",
  );
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[{ id: "office", name: "Office", settings: { engine: "ssh" } as never }]}
        deploymentDefault="this-mac"
        onChanged={async () => {}}
      />,
    ),
  );
  const connectionless = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  await act(async () => {
    connectionless.value = "office";
    connectionless.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "This moves the computer from this engine to Office and replaces its files. Continue?",
  );
  await act(async () => root.unmount());
});

it("hides image profiles on a desktop computer and still sends one for Docker", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, kind: "desktop" }}
        connections={[{ id: "office", name: "Office", settings: { engine: "docker" } as never }]}
        onChanged={async () => {}}
      />,
    ),
  );
  expect(element.querySelector('[aria-label="Image profile"]')).toBeNull();
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  await act(async () => {
    connection.value = "office";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    connectionId: "office",
    confirmed: true,
  });
  api.configure.mockClear();
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[]}
        onChanged={async () => {}}
      />,
    ),
  );
  const profile = element.querySelector<HTMLSelectElement>('[aria-label="Image profile"]')!;
  expect(profile).not.toBeNull();
  await act(async () => {
    profile.value = "developer";
    profile.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "developer",
    connectionId: null,
    confirmed: true,
  });
  await act(async () => root.unmount());
});

it("re-renders host refusals with This computer on linux and This Mac on darwin", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  const render = (platform: string) => {
    window.ardurbotDesktop = { platform } as NonNullable<Window["ardurbotDesktop"]>;
    return root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, connectionId: "home" }}
        connections={[
          { id: "home", name: "Home", settings: { engine: "ssh" } as never },
          { id: "office", name: "Office", settings: { engine: "ssh" } as never },
        ]}
        deploymentDefault="this-mac"
        onChanged={async () => {}}
      />,
    );
  };
  const refuse = async (message: string) => {
    api.configure.mockRejectedValueOnce(new Error(message));
    const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
    await act(async () => {
      connection.value = "office";
      connection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Apply").click());
    await act(async () => button("Continue").click());
  };
  try {
    await act(async () => render("linux"));
    await refuse(
      "Moving this computer onto This computer is not available yet. Choose a saved connection or keep the current engine.",
    );
    expect(element.textContent).toContain(
      "Moving this computer onto This computer is not available yet. Choose a saved connection or keep the current engine.",
    );
    expect(element.textContent).not.toContain("This Mac");
    await act(async () => render("linux"));
    await refuse(
      "This computer is not available. Choose a saved connection or keep the current engine.",
    );
    expect(element.textContent).toContain(
      "This computer is not available. Choose a saved connection or keep the current engine.",
    );
    await act(async () => render("darwin"));
    await refuse(
      "Moving this computer onto This Mac is not available yet. Choose a saved connection or keep the current engine.",
    );
    expect(element.textContent).toContain(
      "Moving this computer onto This Mac is not available yet. Choose a saved connection or keep the current engine.",
    );
    await act(async () => render("darwin"));
    await refuse(
      "This Mac is not available. Choose a saved connection or keep the current engine.",
    );
    expect(element.textContent).toContain(
      "This Mac is not available. Choose a saved connection or keep the current engine.",
    );
    expect(element.textContent).not.toContain("This computer is not available");
  } finally {
    delete window.ardurbotDesktop;
    await act(async () => root.unmount());
  }
});

it("keeps a stopped engine quiet until Retry and clears its reason after recovery", async () => {
  vi.useFakeTimers();
  const message =
    "Docker is not running or not reachable at /fixture/docker.sock. Start Docker Desktop and try again.";
  api.engine.mockRejectedValueOnce(new Error(message));
  const element = document.createElement("div");
  const root = createRoot(element);
  const render = () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, connectionId: "engine" }}
        connections={[{ id: "engine", name: "Local", settings: { engine: "docker" } as never }]}
        onChanged={async () => {}}
      />,
    );
  try {
    await act(async () => render());
    expect(element.textContent).toContain(message);
    for (let i = 0; i < 6; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        render();
      });
    expect(api.engine).toHaveBeenCalledOnce();
    await act(async () =>
      [...element.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    expect(api.engine).toHaveBeenCalledTimes(2);
    expect(element.textContent).not.toContain(message);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
