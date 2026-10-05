// @vitest-environment jsdom
import type { Bot, ComputerStatus } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  available: vi.fn(async () => ({ available: true })),
  release: vi.fn(async () => ({})),
  close: vi.fn(async () => ({})),
  session: vi.fn(
    (_props: {
      botId: string;
      computerId: string;
      visible?: boolean;
      onSession?(id: string): void;
    }) => null as ReactNode,
  ),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    terminal: { available: calls.available, close: calls.close },
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
  await act(async () =>
    root.render(
      <MemoryRouter>
        <WorkspaceTerminal {...props} />
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceTerminal", () => {
  it("keeps four sessions under one grant and confirms only the final close", async () => {
    calls.session.mockReturnValue(null);
    await import("./TerminalCollection");
    await render(baseProps({ computer: computer({ controlHolder: "user", controlBotId: "bot" }) }));
    const add = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "New terminal",
      )!;
    for (const id of ["shell-one", "shell-two", "shell-three", "shell-four"]) {
      const session = calls.session.mock.calls.findLast(([props]) => props.visible)![0];
      await act(async () => session.onSession!(id));
      if (id !== "shell-four") await act(async () => add().click());
    }
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(add().disabled).toBe(true);
    expect(add().title).toBe("Four terminals are already open.");
    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Close terminal"]')[1]!.click(),
    );
    expect(calls.close).toHaveBeenCalledExactlyOnceWith({
      botId: "bot",
      computerId: "computer",
      sessionId: "shell-two",
    });
    expect(calls.release).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    for (const _ of [0, 1])
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')!.click(),
      );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')!.click(),
    );
    expect(window.confirm).toHaveBeenCalledWith("End this terminal?");
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
  });
  it("keeps authority and Release reachable outside the hidden tab", async () => {
    const controlsHost = document.createElement("div");
    document.body.append(controlsHost);
    try {
      const props = baseProps({
        controlsHost,
        computer: computer({ controlHolder: "user", controlBotId: "bot" }),
      });
      await render(props);
      await render({ ...props, visible: false });
      expect(controlsHost.textContent).toContain("You control the computer");
      expect(controlsHost.textContent).toContain("Release");
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      await act(async () => controlsHost.querySelector("button")!.click());
      expect(calls.release).not.toHaveBeenCalled();
      await act(async () => controlsHost.querySelector("button")!.click());
      expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
      expect(controlsHost.textContent).not.toContain("You control the computer");
    } finally {
      controlsHost.remove();
    }
  });

  it("guards explicit close and clears the guard when the computer stops", async () => {
    const registerCloseGuard = vi.fn();
    const props = baseProps({
      registerCloseGuard,
      computer: computer({ controlHolder: "user", controlBotId: "bot" }),
    });
    await render(props);
    const guard = registerCloseGuard.mock.lastCall?.[0] as () => boolean;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    expect(guard()).toBe(false);
    expect(guard()).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith("End this terminal?");
    await render({
      ...props,
      computer: computer({ state: "stopped", controlHolder: "user", controlBotId: "bot" }),
    });
    expect(registerCloseGuard.mock.lastCall?.[0]).toBeNull();
    expect(container.textContent).not.toContain("You control the computer");
  });

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

  it("retains the shell identity and acquired control across hide and reveal", async () => {
    const mounted = vi.fn();
    const closed = vi.fn();
    function Session() {
      useEffect(() => {
        mounted();
        return closed;
      }, []);
      return <div data-session>scrollback</div>;
    }
    calls.session.mockImplementation(Session);
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
    expect(calls.release).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    await render({ ...props, computer: computer({ controlHolder: "user", controlBotId: "bot" }) });
    expect(mounted).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-session]")?.textContent).toBe("scrollback");
    await act(async () => root.unmount());
    expect(closed).toHaveBeenCalledOnce();
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
    calls.session.mockImplementation(() => null);
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
    expect(window.confirm).toHaveBeenCalledWith("End this terminal?");
  });
});
