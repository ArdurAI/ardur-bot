// @vitest-environment jsdom
import type { ComputerStatus } from "@ardurbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  available: vi.fn(async () => ({ available: true })),
  release: vi.fn(async () => ({})),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    terminal: { available: calls.available },
    computer: { release: calls.release },
  },
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

import { terminalSupported, useTerminalController } from "./terminal-controller";

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

type Props = Parameters<typeof useTerminalController>[0];

function baseProps(over: Partial<Props> = {}): Props {
  return {
    botId: "bot",
    computerId: "computer",
    computer: computer(),
    working: false,
    hasControl: false,
    onTakeControl: async () => {},
    onStop: async () => {},
    releaseOnLeave: true,
    ...over,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let state: ReturnType<typeof useTerminalController> | undefined;

function Harness({ props }: { props: Props }) {
  state = useTerminalController(props);
  return null;
}

async function render(props: Props) {
  await act(async () => root.render(<Harness props={props} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("terminalSupported", () => {
  it("follows the server capability summary before the kind table", () => {
    expect(terminalSupported(computer())).toBe(true);
    expect(
      terminalSupported(
        computer({ capabilities: { graphical: true, interactiveTerminal: false } }),
      ),
    ).toBe(false);
    // Older servers omit capabilities: fall back to the kind table.
    expect(terminalSupported(computer({ capabilities: undefined, kind: "ssh" }))).toBe(true);
    expect(terminalSupported(computer({ capabilities: undefined, kind: "kubernetes" }))).toBe(
      false,
    );
    expect(terminalSupported(null)).toBe(false);
  });
});

describe("useTerminalController", () => {
  it("preserves an acquired grant while hidden when the pane opts in", async () => {
    const props = baseProps({ keepControlWhileHidden: true });
    await render(props);
    await act(async () => state?.runAction());
    await render({ ...props, hasControl: true, visible: false });
    expect(calls.release).not.toHaveBeenCalled();
    expect(state?.ready).toBe(true);
    await act(async () => root.unmount());
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
  });

  it("returns a dismissed takeover even if the pane is shown again before it finishes", async () => {
    let finish = () => {};
    const props = baseProps({
      keepControlWhileHidden: true,
      onTakeControl: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await render(props);
    await act(async () => state?.runAction());
    await render({ ...props, visible: false });
    await render(props);
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
  });

  it("does not release twice when closed during an explicit release", async () => {
    let finish = () => {};
    const props = baseProps();
    await render(props);
    await act(async () => state?.runAction());
    calls.release.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          finish = () => resolve({});
        }),
    );
    await act(async () => state?.release());
    await act(async () => root.unmount());
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
  });

  it("returns a takeover that finishes while the retained surface is hidden", async () => {
    let finish = () => {};
    const props = baseProps({
      onTakeControl: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await render(props);
    await act(async () => state?.runAction());
    await render({ ...props, visible: false });
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
  });

  it("does not connect to a stopped computer even with a stale control grant", async () => {
    await render(
      baseProps({
        hasControl: true,
        computer: computer({ state: "stopped" }),
        onStart: async () => {},
      }),
    );
    expect(state?.ready).toBe(false);
  });

  it("does not retarget a pending takeover after a same-bot computer switch", async () => {
    let finish = () => {};
    const onReleasedA = vi.fn();
    const onReleasedB = vi.fn();
    const props = baseProps({
      onReleased: onReleasedA,
      onTakeControl: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await render(props);
    await act(async () => state?.runAction());
    await render({
      ...props,
      computerId: "computer-b",
      computer: computer({ computerId: "computer-b" }),
      onReleased: onReleasedB,
    });
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
    expect(onReleasedA).toHaveBeenCalledOnce();
    expect(onReleasedB).not.toHaveBeenCalled();
    calls.release.mockClear();
    await act(async () => root.unmount());
    expect(calls.release).not.toHaveBeenCalled();
  });

  it("does not revive an old takeover after switching away and back", async () => {
    let finish = () => {};
    const props = baseProps({
      keepControlWhileHidden: true,
      onTakeControl: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await render(props);
    await act(async () => state?.runAction());
    await render({ ...props, botId: "bot-b" });
    await render(props);
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledExactlyOnceWith({ botId: "bot" });
    calls.release.mockClear();
    await act(async () => root.unmount());
    expect(calls.release).not.toHaveBeenCalled();
  });

  it("keeps a release completion bound to the original surface", async () => {
    let finish = () => {};
    calls.release.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          finish = () => resolve({});
        }),
    );
    const onReleasedA = vi.fn();
    const onReleasedB = vi.fn();
    await render(baseProps({ hasControl: true, onReleased: onReleasedA }));
    await act(async () => state?.release());
    await render(baseProps({ botId: "bot-b", onReleased: onReleasedB }));
    await act(async () => finish());
    expect(onReleasedA).toHaveBeenCalledOnce();
    expect(onReleasedB).not.toHaveBeenCalled();
  });

  it("skips the availability probe when the kind does not support a terminal", async () => {
    await render(baseProps({ supported: false }));
    expect(calls.available).not.toHaveBeenCalled();
    expect(state?.state).toBe("unavailable");
    expect(state?.ready).toBe(false);
    expect(state?.actionLabel).toBeNull();
  });

  it("becomes ready once the terminal is available and the user holds control", async () => {
    await render(baseProps({ hasControl: true }));
    expect(calls.available).toHaveBeenCalledWith({ botId: "bot", computerId: "computer" });
    expect(state?.state).toBe("ready");
    expect(state?.ready).toBe(true);
  });

  it("refuses to connect without control and takes control explicitly", async () => {
    const onTakeControl = vi.fn(async () => {});
    await render(baseProps({ onTakeControl }));
    expect(state?.ready).toBe(false);
    expect(state?.state).toBe("take-control");
    expect(state?.actionLabel).toBe("Take control");
    await act(async () => state?.runAction());
    expect(onTakeControl).toHaveBeenCalledTimes(1);
  });

  it("releases on leave only the control it acquired", async () => {
    const onTakeControl = vi.fn(async () => {});
    const props = baseProps({ onTakeControl });
    await render(props);
    await act(async () => state?.runAction());
    // Leaving the surface releases the acquired grant.
    await act(async () => root.render(<Harness props={{ ...props, visible: false }} />));
    expect(calls.release).toHaveBeenCalledWith({ botId: "bot" });
  });

  it("does not release on leave when the control was held before it arrived", async () => {
    const props = baseProps({ hasControl: true });
    await render(props);
    expect(state?.ready).toBe(true);
    await act(async () => root.render(<Harness props={{ ...props, visible: false }} />));
    expect(calls.release).not.toHaveBeenCalled();
  });

  it("releases an acquired grant on unmount", async () => {
    const onTakeControl = vi.fn(async () => {});
    await render(baseProps({ onTakeControl }));
    await act(async () => state?.runAction());
    await act(async () => root.unmount());
    expect(calls.release).toHaveBeenCalledWith({ botId: "bot" });
  });

  it("keeps control on unmount when the surface opted out of releasing", async () => {
    const onTakeControl = vi.fn(async () => {});
    await render(baseProps({ onTakeControl, releaseOnLeave: false }));
    await act(async () => state?.runAction());
    await act(async () => root.unmount());
    expect(calls.release).not.toHaveBeenCalled();
  });

  it("hands control straight back when the surface leaves mid-takeover", async () => {
    let finish = () => {};
    const onTakeControl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render(baseProps({ onTakeControl }));
    await act(async () => state?.runAction());
    await act(async () => root.unmount());
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledWith({ botId: "bot" });
  });

  it("hands control straight back when the pane switches bots mid-takeover", async () => {
    let finish = () => {};
    const onTakeControl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const propsA = baseProps({ botId: "bot-a", onTakeControl });
    await render(propsA);
    await act(async () => state?.runAction());
    const propsB = baseProps({ botId: "bot-b", onTakeControl });
    await act(async () => root.render(<Harness props={propsB} />));
    await act(async () => finish());
    expect(calls.release).toHaveBeenCalledWith({ botId: "bot-a" });
    calls.release.mockClear();
    await act(async () => root.unmount());
    expect(calls.release).not.toHaveBeenCalled();
  });

  it("shows the refusal reason when taking control fails", async () => {
    const onTakeControl = vi.fn(async () => {
      throw new Error("The bot is working on this computer");
    });
    await render(baseProps({ onTakeControl }));
    await act(async () => state?.runAction());
    expect(state?.ready).toBe(false);
    expect(state?.error).toBe("The bot is working on this computer");
  });

  it("stops the bot's work instead of taking control while it is working", async () => {
    const onTakeControl = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    await render(baseProps({ working: true, onTakeControl, onStop }));
    expect(state?.state).toBe("working");
    expect(state?.actionLabel).toBe("Stop");
    expect(state?.ready).toBe(false);
    await act(async () => state?.runAction());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onTakeControl).not.toHaveBeenCalled();
  });

  it("lets the bot's takeover request through while it is working", async () => {
    await render(baseProps({ working: true, computer: computer({ takeoverRequested: true }) }));
    expect(state?.state).toBe("take-control");
  });

  it("offers to start a stopped computer without taking control", async () => {
    const onStart = vi.fn(async () => {});
    const onTakeControl = vi.fn(async () => {});
    await render(baseProps({ computer: computer({ state: "stopped" }), onStart, onTakeControl }));
    expect(state?.state).toBe("start");
    expect(state?.status).toBe("Start computer to open a terminal");
    expect(state?.actionLabel).toBe("Start computer");
    await act(async () => state?.runAction());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onTakeControl).not.toHaveBeenCalled();
  });

  it("keeps the take-control prompt for a stopped computer without a start action", async () => {
    await render(baseProps({ computer: computer({ state: "stopped" }) }));
    expect(state?.state).toBe("take-control");
  });

  it("labels the action Open when taking control boots the computer first", async () => {
    await render(baseProps({ computer: computer({ state: "stopped" }), bootWithTakeover: true }));
    expect(state?.state).toBe("take-control");
    expect(state?.actionLabel).toBe("Open");
  });

  it("rechecks availability when the computer changes", async () => {
    const props = baseProps();
    await render(props);
    expect(calls.available).toHaveBeenCalledTimes(1);
    const next = computer({ computerId: "computer-2" });
    await act(async () =>
      root.render(<Harness props={{ ...props, computerId: "computer-2", computer: next }} />),
    );
    expect(calls.available).toHaveBeenCalledWith({ botId: "bot", computerId: "computer-2" });
  });
});
