import { decodeTerminalFrame, encodeTerminalFrame, TERMINAL_FRAME_BYTES } from "@ardurbot/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { terminalInput } from "./input.js";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export type TerminalLabels = {
  connecting: string;
  ended: string;
  newSession: string;
  reconnect: string;
  opening: string;
  find: string;
  next: string;
  previous: string;
  terminal: string;
};
export type TerminalTicket = { sessionId: string; ticket: string; path: string };
export interface TerminalProps {
  ticket(sessionId?: string): Promise<TerminalTicket>;
  labels: TerminalLabels;
  close(sessionId: string): Promise<unknown>;
}

/** Imported only when the computer's Terminal tab is selected. */
export default function ComputerTerminal({ ticket, labels, close }: TerminalProps) {
  const container = useRef<HTMLDivElement>(null);
  const currentSession = useRef<string | undefined>(undefined);
  const reconnect = useRef<() => void>(() => {});
  const closeRef = useRef(close);
  closeRef.current = close;
  const search = useRef<SearchAddon | null>(null);
  const query = useRef("");
  const [state, setState] = useState<"opening" | "connecting" | "ready" | "ended">("opening");
  const [attempt, setAttempt] = useState(0);
  const ticketRef = useRef(ticket);
  ticketRef.current = ticket;
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false,
      socket: WebSocket | undefined,
      sessionId: string | undefined,
      ack = 0,
      received = 0,
      inputSeq = 0,
      ready = false;
    let retry: ReturnType<typeof setTimeout> | undefined,
      resize: ReturnType<typeof setTimeout> | undefined,
      lostAt = 0;
    const terminal = new Terminal({
      scrollback: 10_000,
      allowProposedApi: true,
      allowTransparency: false,
      screenReaderMode: true,
      convertEol: false,
      windowOptions: {},
      linkHandler: { activate: () => {} },
      theme: terminalTheme(host),
    });
    // Consume dangerous terminal-driven actions without forwarding them to browser APIs.
    const blockers = [0, 1, 2, 8, 52].map((code) =>
      terminal.parser.registerOscHandler(code, () => true),
    );
    const fit = new FitAddon();
    const finder = new SearchAddon();
    search.current = finder;
    terminal.loadAddon(fit);
    terminal.loadAddon(finder);
    terminal.open(host);
    terminal.textarea?.setAttribute("aria-label", labels.terminal);
    const send = (data: string, binary = false) => {
      if (!ready || !socket || socket.readyState !== WebSocket.OPEN) return;
      const bytes = terminalInput(data, binary);
      // Input is never queued across a disconnect, including uncertain writes.
      if (socket.bufferedAmount > 64 * 1024) {
        socket.close();
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += TERMINAL_FRAME_BYTES) {
        if (socket.bufferedAmount > 64 * 1024) {
          socket.close();
          return;
        }
        socket.send(
          encodeTerminalFrame(
            ++inputSeq,
            bytes.subarray(offset, offset + TERMINAL_FRAME_BYTES),
          ).slice().buffer,
        );
      }
    };
    const input = terminal.onData((data: string) => send(data));
    const binary = terminal.onBinary((data: string) => send(data, true));
    const fitNow = () => {
      if (disposed || !host.clientWidth || !host.clientHeight) return;
      fit.fit();
      if (ready && socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: Math.min(500, Math.max(2, terminal.cols)),
            rows: Math.min(300, Math.max(1, terminal.rows)),
          }),
        );
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(resize);
      resize = setTimeout(fitNow, 50);
    });
    observer.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme(host);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const connect = async () => {
      ready = false;
      terminal.options.disableStdin = true;
      setState(sessionId ? "connecting" : "opening");
      try {
        const grant = await ticketRef.current(sessionId);
        if (disposed) {
          void closeRef.current(grant.sessionId).catch(() => {});
          return;
        }
        sessionId = grant.sessionId;
        currentSession.current = sessionId;
        const url = new URL(grant.path, window.location.origin);
        if (url.origin !== window.location.origin) throw new Error("Invalid terminal origin.");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const next = new WebSocket(url);
        socket = next;
        next.binaryType = "arraybuffer";
        next.onopen = () =>
          next.send(JSON.stringify({ type: "connect", ticket: grant.ticket, ack }));
        next.onmessage = (event) => {
          if (disposed || socket !== next) return;
          try {
            if (typeof event.data === "string") {
              const value = JSON.parse(event.data);
              if (value.type === "ready") {
                inputSeq = value.inputSeq;
                ready = true;
                lostAt = 0;
                terminal.options.disableStdin = false;
                setState("ready");
                fitNow();
                terminal.focus();
              }
              return;
            }
            const frame = decodeTerminalFrame(new Uint8Array(event.data));
            if (frame.seq <= received) return;
            if (frame.seq !== received + 1) throw new Error("Replay gap.");
            received = frame.seq;
            terminal.write(frame.bytes, () => {
              ack = frame.seq;
              if (!disposed && socket === next && next.readyState === WebSocket.OPEN)
                next.send(JSON.stringify({ type: "ack", seq: ack }));
            });
          } catch {
            ready = false;
            next.onclose = null;
            next.close();
            setState("ended");
          }
        };
        next.onclose = () => {
          ready = false;
          terminal.options.disableStdin = true;
          if (disposed || socket !== next) return;
          lostAt ||= Date.now();
          if (Date.now() - lostAt >= 30_000) {
            setState("ended");
            return;
          }
          setState("connecting");
          retry = setTimeout(() => {
            void connect();
          }, 1_000);
        };
        next.onerror = () => next.close();
      } catch {
        if (!disposed) setState("ended");
      }
    };
    reconnect.current = () => {
      clearTimeout(retry);
      if (!ready && socket?.readyState !== WebSocket.CONNECTING) void connect();
    };
    void connect();
    fitNow();
    const heartbeat = setInterval(() => {
      if (ready && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ping" }));
    }, 10_000);
    return () => {
      disposed = true;
      ready = false;
      if (sessionId) void closeRef.current(sessionId).catch(() => {});
      clearInterval(heartbeat);
      clearTimeout(retry);
      clearTimeout(resize);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "close" }));
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      binary.dispose();
      for (const blocker of blockers) blocker.dispose();
      terminal.dispose();
      search.current = null;
    };
  }, [attempt, labels.terminal]);
  return (
    <section
      data-terminal-root
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label={labels.terminal}
    >
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Input
          className="max-w-xs"
          aria-label={labels.find}
          placeholder={labels.find}
          onChange={(event) => {
            query.current = event.target.value;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") search.current?.findNext(query.current);
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => search.current?.findPrevious(query.current)}
        >
          {labels.previous}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => search.current?.findNext(query.current)}>
          {labels.next}
        </Button>
      </div>
      {state !== "ready" ? (
        <div role="status" className="flex items-center gap-3 p-3 text-sm text-muted-foreground">
          <span>
            {state === "ended"
              ? labels.ended
              : state === "opening"
                ? labels.opening
                : labels.connecting}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={state === "opening"}
            onClick={() => {
              if (state === "connecting") {
                reconnect.current();
                return;
              }
              void (async () => {
                if (currentSession.current) await closeRef.current(currentSession.current);
                currentSession.current = undefined;
                setAttempt((value) => value + 1);
              })().catch(() => setState("ended"));
            }}
          >
            {state === "connecting" ? labels.reconnect : labels.newSession}
          </Button>
        </div>
      ) : null}
      <div ref={container} className="ardur-terminal min-h-0 flex-1 p-2" />
    </section>
  );
}

function terminalTheme(host: HTMLElement): ITheme {
  const color = (token: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--${token})`;
    host.append(probe);
    // Canvas accepts computed CSS colors; tokens stay the single source of truth.
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  const foreground = color("foreground"),
    background = color("background");
  return {
    foreground,
    background,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: color("muted"),
    black: background,
    brightBlack: color("muted-foreground"),
    white: foreground,
    brightWhite: foreground,
    red: color("destructive"),
    brightRed: color("destructive"),
    green: color("success"),
    brightGreen: color("success"),
    yellow: color("warning"),
    brightYellow: color("warning"),
    blue: foreground,
    brightBlue: foreground,
    magenta: foreground,
    brightMagenta: foreground,
    cyan: foreground,
    brightCyan: foreground,
  };
}
