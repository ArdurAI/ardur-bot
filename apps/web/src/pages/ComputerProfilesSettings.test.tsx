// @vitest-environment jsdom

import type { ComputerStatus } from "@ardurbot/contracts";
import { HOST_MOVE_UNAVAILABLE_MESSAGE } from "@ardurbot/contracts";
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
  expect(element.querySelector('[aria-label="Connection"]')).toBeNull();
  expect(element.textContent).toContain("Engine: Docker");
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.textContent).not.toContain("Add a computer");
  // Local Docker still answers the engine check, so a stopped engine can say so.
  expect(api.engine).toHaveBeenCalledExactlyOnceWith({ connectionId: null });
  await act(async () => root.unmount());
});

it("shows a desktop computer with the host label from the API and hides image profiles", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, kind: "desktop", hostLabel: "This computer" }}
        connections={[]}
        deploymentDefault={null}
        onChanged={async () => {}}
      />,
    ),
  );
  expect(element.textContent).toContain("Engine: This computer");
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.querySelector('[aria-label="Connection"]')).toBeNull();
  expect(api.engine).not.toHaveBeenCalled();
  expect(element.querySelector('[aria-label="Image profile"]')).toBeNull();
  await act(async () => root.unmount());
});

it("moves a connectionless computer to a saved connection and hides the control without one", async () => {
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
  expect(element.querySelector('[aria-label="Connection"]')).toBeNull();
  expect(element.textContent).not.toContain("Deployment default");
  expect(element.textContent).not.toContain("This Mac");
  await act(async () => root.unmount());
});

it("names the engine new computers start on, and none while that is the host", () => {
  expect(
    deploymentDefaultEngine({ sandboxProvider: "docker", computerHost: "this-mac" }),
  ).toBeNull();
  expect(deploymentDefaultEngine({ sandboxProvider: "desktop", computerHost: null })).toBeNull();
  expect(deploymentDefaultEngine({ sandboxProvider: "docker", computerHost: null })).toBe("docker");
  expect(deploymentDefaultEngine({ sandboxProvider: "docker", computerHost: "docker" })).toBe(
    "docker",
  );
  expect(deploymentDefaultEngine({ sandboxProvider: "e2b", computerHost: null })).toBe("e2b");
  expect(deploymentDefaultEngine({ sandboxProvider: "kubernetes", computerHost: null })).toBe(
    "kubernetes",
  );
});

it("labels a desktop computer with the host label the API returns, not the browser's platform", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (hostLabel: ComputerStatus["hostLabel"]) =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, kind: "desktop", hostLabel }}
        connections={[{ id: "ssh", name: "Office", settings: { engine: "ssh" } as never }]}
        deploymentDefault={null}
        onChanged={async () => {}}
      />,
    );
  window.ardurbotDesktop = { platform: "linux" } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => render("This Mac"));
  const options = () =>
    [...element.querySelectorAll<HTMLOptionElement>('[aria-label="Connection"] option')].map(
      (option) => option.textContent,
    );
  expect(element.textContent).toContain("Engine: This Mac");
  expect(options()).toEqual(["This Mac", "Office"]);
  expect(element.textContent).not.toContain("This computer");
  window.ardurbotDesktop = { platform: "darwin" } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => render("This computer"));
  expect(element.textContent).toContain("Engine: This computer");
  expect(options()).toEqual(["This computer", "Office"]);
  expect(element.textContent).not.toContain("This Mac");
  delete window.ardurbotDesktop;
  await act(async () => root.unmount());
});

it("offers the deployment default by its engine name unless that is the host", async () => {
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
  const render = (deploymentDefault: string | null) =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={ssh}
        connections={connections}
        deploymentDefault={deploymentDefault}
        onChanged={async () => {}}
      />,
    );
  const select = () => element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  const options = () => [...select().options].map((option) => option.textContent);
  await act(async () => render(null));
  expect(options()).toEqual(["Office", "Lab"]);
  expect(select().value).toBe("office");
  expect(element.textContent).not.toContain("Deployment default");
  await act(async () => render("docker"));
  expect(options()).toEqual(["Office", "Deployment default (Docker)", "Lab"]);
  await act(async () => render("e2b"));
  expect(options()).toEqual(["Office", "Deployment default (E2B)", "Lab"]);
  await act(async () => {
    select().value = [...select().options].find(
      (option) => option.textContent === "Deployment default (E2B)",
    )!.value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "This moves the computer from Office to Deployment default (E2B) and replaces its files. Continue?",
  );
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "base",
    connectionId: null,
    confirmed: true,
  });
  await act(async () => root.unmount());
});

it("moves a connectionless Docker computer to an E2B deployment default and names Docker", async () => {
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
        connections={[]}
        deploymentDefault="e2b"
        onChanged={async () => {}}
      />,
    ),
  );
  const select = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect([...select.options].map((option) => option.textContent)).toEqual([
    "Docker",
    "Deployment default (E2B)",
  ]);
  await act(async () => {
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(element.textContent).toContain("Engine: E2B");
  // Only the Docker engine it runs on was checked; E2B is named, not probed.
  expect(api.engine).toHaveBeenCalledExactlyOnceWith({ connectionId: null });
  await act(async () => button("Apply").click());
  expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "This moves the computer from Docker to Deployment default (E2B) and replaces its files. Continue?",
  );
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "base",
    connectionId: null,
    confirmed: true,
  });
  api.configure.mockClear();
  // A computer already on the deployment's engine is not offered it, and a host default never is.
  for (const [kind, deploymentDefault] of [
    ["e2b", "e2b"],
    ["docker", null],
    ["docker", "e2b-emulator"],
  ] as const) {
    await act(async () =>
      root.render(
        <ComputerProfile
          botId="bot"
          name="Builder"
          status={{ ...status, kind }}
          connections={[]}
          deploymentDefault={deploymentDefault}
          onChanged={async () => {}}
        />,
      ),
    );
    expect(element.querySelector('[aria-label="Connection"]')).toBeNull();
  }
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
    "Local",
    "Deployment default (Docker)",
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
        deploymentDefault={null}
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
        deploymentDefault={null}
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
    "This moves the computer from Docker to Office and replaces its files. Continue?",
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
    confirmed: true,
  });
  await act(async () => root.unmount());
});

it("shows the host refusal as its own sentence instead of the generic failure", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  api.configure.mockRejectedValueOnce(new Error(HOST_MOVE_UNAVAILABLE_MESSAGE));
  await act(async () =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={{ ...status, connectionId: "home" }}
        connections={[
          { id: "home", name: "Home", settings: { engine: "ssh" } as never },
          { id: "office", name: "Office", settings: { engine: "ssh" } as never },
        ]}
        deploymentDefault={null}
        onChanged={async () => {}}
      />,
    ),
  );
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  await act(async () => {
    connection.value = "office";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(element.querySelector('[role="alert"]')?.textContent).toBe(
    "Moving a computer onto the machine running Ardur Bot is not available yet. Choose a saved connection or keep the current engine.",
  );
  await act(async () => root.unmount());
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
