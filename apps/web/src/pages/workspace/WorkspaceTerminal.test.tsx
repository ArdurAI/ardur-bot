// @vitest-environment jsdom
import type { Bot, ComputerStatus } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  available: vi.fn(async () => ({ available: true })),
  release: vi.fn(async () => ({})),
  session: vi.fn((_props: { botId: string; computerId: string }) => null as ReactNode),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    terminal: { available: calls.available },
    computer: { release: calls.release },
  },
}));
vi.mock("../shell/terminal-session", () => ({ default: calls.session }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { WorkspaceTerminal } from "./WorkspaceTerminal";

const bot = { id: "bot", name: "Helper" } as Bot;

const computer = (over: Partial<ComputerStatus> = {}): ComputerStatus => ({
  botId: "bot",
  computerId: "computer",
  mode: "team",
  kind: "docker",
  state: "running",
  capabilities: { graphical: true, interactiveTerminal: true },
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: false,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: null,
  canUpdate: false,
  ...over,
});

type Props = Parameters<typeof WorkspaceTerminal>[0];

function baseProps(over: Partial<Props> = {}): Props {
  return {
    bot,
    computer: computer(),
    visible: true,
    working: false,
    onTakeControl: async () => {},
    onStop: async () => {},
    onStart: async () => {},
    onReleased: () => {},
    ...over,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(props: Props) {
  await act(async () => root.render(<WorkspaceTerminal {...props} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceTerminal", () => {
  it("connects the shared session only once available, running and under user control", async () => {
    await render(baseProps({ computer: computer({ controlHolder: "user", controlBotId: "bot" }) }));
    expect(calls.session).toHaveBeenCalledTimes(1);
    expect(calls.session.mock.calls[0]![0]).toMatchObject({
      botId: "bot",
      computerId: "computer",
    });
    expect(container.textContent).toContain("Release");
  });

  it("refuses to open a session without the control grant", async () => {
    const onTakeControl = vi.fn(async () => {});
    await render(baseProps({ onTakeControl, computer: computer({ controlHolder: "bot" }) }));
    expect(calls.session).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Take control to open a terminal");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Take control");
    await act(async () => button!.click());
    expect(onTakeControl).toHaveBeenCalledTimes(1);
    expect(calls.session).not.toHaveBeenCalled();
  });

  it("shows the reason when taking control is refused", async () => {
    const onTakeControl = vi.fn(async () => {
      throw new Error("The bot is working on this computer");
    });
    await render(baseProps({ onTakeControl }));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("The bot is working on this computer");
    expect(calls.session).not.toHaveBeenCalled();
  });

  it("offers Stop while the bot is working instead of connecting", async () => {
    const onStop = vi.fn(async () => {});
    await render(baseProps({ working: true, onStop }));
    expect(calls.session).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The bot is working — wait or stop it");
    await act(async () => container.querySelector("button")!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("offers to start a stopped computer without taking control", async () => {
    const onStart = vi.fn(async () => {});
    await render(baseProps({ computer: computer({ state: "stopped" }), onStart }));
    expect(calls.session).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Start computer to open a terminal");
    await act(async () => container.querySelector("button")!.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("explains when the computer has no terminal", async () => {
    await render(
      baseProps({
        computer: computer({ capabilities: { graphical: true, interactiveTerminal: false } }),
      }),
    );
    expect(calls.available).not.toHaveBeenCalled();
    expect(calls.session).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Terminal is not available on this computer");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps the session hidden while the tab is not selected", async () => {
    await render(
      baseProps({
        visible: false,
        computer: computer({ controlHolder: "user", controlBotId: "bot" }),
      }),
    );
    expect(calls.session).not.toHaveBeenCalled();
  });

  it("releases the control it took when the tab is left", async () => {
    const onTakeControl = vi.fn(async () => {});
    const props = baseProps({ onTakeControl });
    await render(props);
    await act(async () => container.querySelector("button")!.click());
    expect(onTakeControl).toHaveBeenCalledTimes(1);
    // The refresh after takeover arrives: the user now holds control.
    await render({
      ...props,
      computer: computer({ controlHolder: "user", controlBotId: "bot" }),
    });
    expect(calls.session).toHaveBeenCalledTimes(1);
    await render({
      ...props,
      computer: computer({ controlHolder: "user", controlBotId: "bot" }),
      visible: false,
    });
    expect(calls.release).toHaveBeenCalledWith({ botId: "bot" });
  });

  it("releases control from the Release action and reports it", async () => {
    const onReleased = vi.fn();
    await render(
      baseProps({
        onReleased,
        computer: computer({ controlHolder: "user", controlBotId: "bot" }),
      }),
    );
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Release",
    );
    await act(async () => button!.click());
    expect(calls.release).toHaveBeenCalledWith({ botId: "bot" });
    expect(onReleased).toHaveBeenCalledTimes(1);
  });
});
