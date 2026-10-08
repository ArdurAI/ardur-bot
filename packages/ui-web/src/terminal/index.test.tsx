// @vitest-environment jsdom

import { encodeTerminalFrame } from "@ardurbot/core";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalLabels, TerminalTicket } from "./index.js";
import ComputerTerminal from "./index.js";

const renderer = vi.hoisted(() => ({
  fit: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  resize: vi.fn(),
  write: vi.fn((_bytes: Uint8Array, done: () => void) => done()),
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
    cols = 80;
    rows = 24;
    resize = renderer.resize;
    write = renderer.write;
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
it.each([undefined, "restored"])(
  "opens %s once through StrictMode setup/cleanup and closes a late grant before another admission",
  async (initialSession) => {
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
            <ComputerTerminal
              ticket={ticket}
              close={close}
              labels={labels}
              initialSession={initialSession}
            />
          </StrictMode>,
        ),
      );
      expect(ticket).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      await act(async () =>
        resolve({ sessionId: "first", ticket: "ticket", path: "/api/terminal/socket" }),
      );
      expect(close).toHaveBeenCalledExactlyOnceWith("first");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);

it("keeps one admission when the terminal's translated label changes", async () => {
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
  const close = vi.fn(async () => {});
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
    expect(close).not.toHaveBeenCalled();
    expect(ticket).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(close).toHaveBeenCalledExactlyOnceWith("abandoned");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("reauthorizes a stored session, orders replay sizes before writes and detaches on reload", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let socket!: { onopen(): void; onmessage(event: { data: string | ArrayBufferLike }): void };
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
    sessionId: "retained",
    ticket: "fresh-ticket",
    path: "/api/terminal/socket",
  }));
  const close = vi.fn(async () => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ComputerTerminal
          ticket={ticket}
          close={close}
          labels={{ ...labels, earlierUnavailable: "Earlier output is unavailable" }}
          initialSession="retained"
          initialSize={{ cols: 80, rows: 24 }}
          shouldDetach={() => true}
        />,
      ),
    );
    expect(ticket).toHaveBeenCalledExactlyOnceWith("retained");
    socket.onopen();
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({
      type: "connect",
      ticket: "fresh-ticket",
      ack: 0,
      version: 2,
      reset: true,
    });
    await act(async () => {
      socket.onmessage({
        data: JSON.stringify({
          type: "ready",
          version: 2,
          inputSeq: 0,
          from: 2,
          reset: true,
          truncated: true,
          cols: 80,
          rows: 24,
        }),
      });
      socket.onmessage({
        data: JSON.stringify({ type: "replay-size", version: 2, seq: 2, cols: 40, rows: 12 }),
      });
      socket.onmessage({
        data: encodeTerminalFrame(2, new TextEncoder().encode("wrapped output\r\n")).buffer,
      });
      socket.onmessage({ data: JSON.stringify({ type: "replay-end", version: 2, seq: 2 }) });
    });
    expect(renderer.resize.mock.calls).toEqual([
      [80, 24],
      [40, 12],
    ]);
    expect(renderer.write).toHaveBeenCalledOnce();
    await act(async () =>
      socket.onmessage({
        data: encodeTerminalFrame(2, new TextEncoder().encode("wrapped output\r\n")).buffer,
      }),
    );
    expect(renderer.write).toHaveBeenCalledOnce();
    expect(renderer.resize.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      renderer.write.mock.invocationCallOrder[0]!,
    );
    expect(host.textContent).toContain("Earlier output is unavailable");
    expect(
      send.mock.calls.some(
        ([value]) =>
          typeof value === "string" &&
          JSON.parse(value).type === "ack" &&
          JSON.parse(value).seq === 2,
      ),
    ).toBe(true);
    await act(async () => root.unmount());
    expect(close).not.toHaveBeenCalled();
    expect(
      send.mock.calls.some(
        ([value]) => typeof value === "string" && JSON.parse(value).type === "close",
      ),
    ).toBe(false);
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
