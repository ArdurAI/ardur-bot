// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalLabels, TerminalTicket } from "./index.js";
import ComputerTerminal from "./index.js";

const renderer = vi.hoisted(() => ({
  fit: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  input: (_data: string) => {},
  activate: (_event: MouseEvent, _text: string) => {},
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: { linkHandler: { activate: (event: MouseEvent, text: string) => void } }) {
      renderer.activate = options.linkHandler.activate;
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    focus = renderer.focus;
    dispose = renderer.dispose;
    write() {}
    onData(callback: (data: string) => void) {
      renderer.input = callback;
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = renderer.fit;
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("fits after reveal without remounting or stealing focus while hidden", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let socket: { onmessage: (event: { data: string }) => void } | undefined;
  const send = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      send = send;
      constructor() {
        socket = this as unknown as typeof socket;
      }
      close() {}
    },
  );
  const ticket = vi.fn(async () => ({
    sessionId: "shell",
    ticket: "ticket",
    path: "/api/terminal/socket",
  }));
  const close = vi.fn(async () => {});
  const openLink = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ComputerTerminal
          ticket={ticket}
          close={close}
          labels={labels}
          visible={false}
          openLink={openLink}
        />,
      ),
    );
    const terminalHost = host.querySelector(".ardur-terminal")!;
    Object.defineProperties(terminalHost, {
      clientWidth: { value: 600 },
      clientHeight: { value: 300 },
    });
    await act(async () =>
      socket?.onmessage({ data: JSON.stringify({ type: "ready", inputSeq: 0 }) }),
    );
    expect(renderer.focus).not.toHaveBeenCalled();
    send.mockClear();
    renderer.input("echo hidden\n");
    expect(send).not.toHaveBeenCalled();
    renderer.fit.mockClear();
    await act(async () =>
      root.render(
        <ComputerTerminal
          ticket={ticket}
          close={close}
          labels={labels}
          visible
          openLink={openLink}
        />,
      ),
    );
    expect(renderer.fit).toHaveBeenCalledOnce();
    expect(
      send.mock.calls.some(
        ([value]) => typeof value === "string" && JSON.parse(value).type === "resize",
      ),
    ).toBe(true);
    expect(ticket).toHaveBeenCalledOnce();
    expect(openLink).not.toHaveBeenCalled();
    const click = { isTrusted: true, button: 0, preventDefault() {} } as MouseEvent;
    renderer.activate(click, "javascript:alert(1)");
    renderer.activate(click, "https://user:secret@example.test");
    renderer.activate({ ...click, isTrusted: false } as MouseEvent, "https://example.test");
    expect(openLink).not.toHaveBeenCalled();
    renderer.activate(click, "https://example.test");
    expect(openLink).toHaveBeenCalledExactlyOnceWith("https://example.test");
    expect(close).not.toHaveBeenCalled();
    expect(renderer.dispose).not.toHaveBeenCalled();
    send.mockClear();
    renderer.input("echo live\n");
    expect(send).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  expect(close).toHaveBeenCalledExactlyOnceWith("shell");
  send.mockClear();
  renderer.input("echo stopped\n");
  expect(send).not.toHaveBeenCalled();
});
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
