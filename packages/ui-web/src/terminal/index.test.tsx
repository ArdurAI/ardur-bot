// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalLabels, TerminalTicket } from "./index.js";
import ComputerTerminal from "./index.js";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
const labels: TerminalLabels = {
  terminal: "Terminal",
  opening: "Opening",
  connecting: "Connecting",
  ended: "Session ended",
  newSession: "New terminal",
  reconnect: "Reconnect",
  find: "Find",
  next: "Next",
  previous: "Previous",
};
afterEach(() => vi.unstubAllGlobals());
it("opens once through StrictMode setup/cleanup and closes a late grant before another admission", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      close() {}
    },
  );
  let resolve!: (ticket: TerminalTicket) => void;
  const ticket = vi.fn(
    () =>
      new Promise<TerminalTicket>((done) => {
        resolve = done;
      }),
  );
  const close = vi.fn(async () => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <ComputerTerminal ticket={ticket} close={close} labels={labels} />
        </StrictMode>,
      ),
    );
    expect(ticket).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    await act(async () =>
      resolve({ sessionId: "first", ticket: "ticket", path: "/api/terminal/socket" }),
    );
    expect(close).toHaveBeenCalledExactlyOnceWith("first");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("waits for an abandoned admission to close before admitting the replacement terminal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      close() {}
    },
  );
  let grant!: (value: TerminalTicket) => void;
  let closed!: () => void;
  const ticket = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<TerminalTicket>((resolve) => {
          grant = resolve;
        }),
    )
    .mockResolvedValue({
      sessionId: "replacement",
      ticket: "ticket",
      path: "/api/terminal/socket",
    });
  const close = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<ComputerTerminal ticket={ticket} close={close} labels={labels} />),
    );
    await act(async () =>
      root.render(
        <ComputerTerminal
          ticket={ticket}
          close={close}
          labels={{ ...labels, terminal: "Translated terminal" }}
        />,
      ),
    );
    expect(ticket).toHaveBeenCalledOnce();
    await act(async () =>
      grant({ sessionId: "abandoned", ticket: "ticket", path: "/api/terminal/socket" }),
    );
    expect(close).toHaveBeenCalledExactlyOnceWith("abandoned");
    expect(ticket).toHaveBeenCalledOnce();
    await act(async () => closed());
    expect(ticket).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("shows the admission reason when a terminal cannot open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const ticket = vi
    .fn()
    .mockRejectedValue(new Error("Take control of the computer, then open a terminal."));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<ComputerTerminal ticket={ticket} close={async () => {}} labels={labels} />),
    );
    expect(host.textContent).toContain("Take control of the computer, then open a terminal.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
