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

import { ComputerProfile } from "./ComputerProfilesSettings";

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

it("moves a connectionless computer to This Mac only while that choice is on", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (thisMac: boolean) =>
    root.render(
      <ComputerProfile
        botId="bot"
        name="Builder"
        status={status}
        connections={[]}
        thisMac={thisMac}
        onChanged={async () => {}}
      />,
    );
  await act(async () => render(false));
  expect(
    [...element.querySelectorAll("option")].some((option) => option.textContent === "This Mac"),
  ).toBe(false);
  await act(async () => render(true));
  const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
  expect([...connection.options].map((option) => option.textContent)).toEqual([
    "Deployment default",
    "This Mac",
  ]);
  await act(async () => {
    connection.value = "host";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (name: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  await act(async () => button("Apply").click());
  await act(async () => button("Continue").click());
  expect(api.configure).toHaveBeenCalledWith({
    botId: "bot",
    imageProfile: "base",
    connectionId: null,
    thisMac: true,
    confirmed: true,
  });
  expect(api.engine).not.toHaveBeenCalledWith({ connectionId: "host" });
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
        status={{ ...status }}
        connections={[]}
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
