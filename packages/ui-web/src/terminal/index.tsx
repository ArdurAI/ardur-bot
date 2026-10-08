import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  parseTerminalReplaySize,
  TERMINAL_FRAME_BYTES,
  terminalWebLink,
  validateTerminalSize,
} from "@ardurbot/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { terminalInput } from "./input.js";
import { terminalLinkProvider } from "./links.js";
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
  openLink?: string;
  expired?: string;
  earlierUnavailable?: string;
};
export type TerminalTicket = { sessionId: string; ticket: string; path: string };
export interface TerminalProps {
  ticket(sessionId?: string): Promise<TerminalTicket>;
  labels: TerminalLabels;
  close(sessionId: string): Promise<unknown>;
  visible?: boolean;
  openLink?(url: string): void;
  onSession?(id: string): void;
  initialSession?: string;
  initialSize?: { cols: number; rows: number };
  shouldDetach?(): boolean;
  onSize?(size: { cols: number; rows: number }): void;
}

/** Imported only when the computer's Terminal tab is selected. */
export default function ComputerTerminal({
  ticket,
  labels,
  close,
  visible = true,
  openLink,
  onSession,
  initialSession,
  initialSize,
  shouldDetach,
  onSize,
}: TerminalProps) {
  const container = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const currentSession = useRef<string | undefined>(undefined);
  const reconnect = useRef<() => void>(() => {});
  const refit = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const closeRef = useRef(close);
  closeRef.current = close;
  const search = useRef<SearchAddon | null>(null);
  const query = useRef("");
  const [state, setState] = useState<"opening" | "connecting" | "ready" | "ended">("opening");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const activateLink = useRef<(event: MouseEvent, url: string) => void>(() => {});
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const detachRef = useRef(shouldDetach);
  detachRef.current = shouldDetach;
  const sizeRef = useRef(onSize);
  sizeRef.current = onSize;
  const admission = useRef<Promise<unknown>>(Promise.resolve());
  const ticketRef = useRef(ticket);
  ticketRef.current = ticket;
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const closeSession = closeRef.current;
    const requestTicket = ticketRef.current;
    const serialize = <T,>(work: () => Promise<T>) => {
      const next = admission.current.catch(() => undefined).then(work);
      admission.current = next.catch(() => undefined);
      return next;
    };
    let connecting = false;
    let disposed = false,
      socket: WebSocket | undefined,
      sessionId: string | undefined = attempt === 0 ? initialSession : undefined,
      ack = 0,
      received = 0,
      inputSeq = 0,
      ready = false;
    let admitted = false;
    let fresh = true,
      replaying = false;
    let rendering = Promise.resolve();
    let retry: ReturnType<typeof setTimeout> | undefined,
      resize: ReturnType<typeof setTimeout> | undefined,
      lostAt = 0;
    const terminal = new Terminal({
      ...(initialSize ? { cols: initialSize.cols, rows: initialSize.rows } : {}),
      scrollback: 10_000,
      allowProposedApi: true,
      allowTransparency: false,
      screenReaderMode: true,
      convertEol: false,
      windowOptions: {},
      linkHandler: { activate: (event, text) => activateLink.current(event, text) },
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
    xterm.current = terminal;
    setLink(null);
    setTruncated(false);
    activateLink.current = (event, text) => {
      const url = terminalWebLink(text);
      if (
        disposed ||
        !ready ||
        !visibleRef.current ||
        !event.isTrusted ||
        event.button !== 0 ||
        !url
      )
        return;
      event.preventDefault();
      terminal.focus();
      openLinkRef.current?.(url);
    };
    const links = terminal.registerLinkProvider(
      terminalLinkProvider(
        () => terminal.buffer.active,
        (event, text) => activateLink.current(event, text),
        (_event, text) => setLink(terminalWebLink(text)),
      ),
    );
    terminal.textarea?.setAttribute("aria-label", labels.terminal);
    const send = (data: string, binary = false) => {
      if (!ready || !visibleRef.current || !socket || socket.readyState !== WebSocket.OPEN) return;
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
      if (disposed || replaying || !visibleRef.current || !host.clientWidth || !host.clientHeight)
        return;
      fit.fit();
      const size = {
        cols: Math.min(500, Math.max(2, terminal.cols)),
        rows: Math.min(300, Math.max(1, terminal.rows)),
      };
      sizeRef.current?.(size);
      if (ready && socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: Math.min(500, Math.max(2, terminal.cols)),
            rows: Math.min(300, Math.max(1, terminal.rows)),
          }),
        );
    };
    refit.current = fitNow;
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
      if (disposed || connecting) return;
      connecting = true;
      setError(null);
      ready = false;
      terminal.options.disableStdin = true;
      setState(sessionId ? "connecting" : "opening");
      try {
        const grant = await serialize(async () => {
          if (disposed) return;
          const granted = await requestTicket(sessionId);
          if (disposed) {
            if (!detachRef.current?.()) await closeSession(granted.sessionId);
            return;
          }
          sessionId = granted.sessionId;
          admitted = true;
          return granted;
        });
        if (!grant || disposed) return;
        sessionId = grant.sessionId;
        currentSession.current = sessionId;
        onSessionRef.current?.(sessionId);
        const url = new URL(grant.path, window.location.origin);
        if (url.origin !== window.location.origin) throw new Error("Invalid terminal origin.");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const next = new WebSocket(url);
        socket = next;
        next.binaryType = "arraybuffer";
        next.onopen = () =>
          next.send(
            JSON.stringify({
              type: "connect",
              ticket: grant.ticket,
              ack,
              version: 2,
              reset: fresh,
            }),
          );
        next.onmessage = (event) => {
          rendering = rendering.then(async () => {
            if (disposed || socket !== next) return;
            try {
              if (typeof event.data === "string") {
                const value = JSON.parse(event.data);
                if (value.type === "ready") {
                  if (
                    !Number.isSafeInteger(value.inputSeq) ||
                    value.inputSeq < 0 ||
                    value.inputSeq > 0xffffffff
                  )
                    throw new Error("Invalid terminal replay.");
                  inputSeq = value.inputSeq;
                  replaying = value.version === 2;
                  if (replaying) {
                    validateTerminalSize(value.cols, value.rows);
                    if (
                      !Number.isSafeInteger(value.from) ||
                      value.from < 1 ||
                      value.from > 0x100000000 ||
                      typeof value.truncated !== "boolean" ||
                      typeof value.reset !== "boolean"
                    )
                      throw new Error("Invalid terminal replay.");
                    if (value.reset) {
                      received = value.from - 1;
                      ack = received;
                    }
                    terminal.resize(value.cols, value.rows);
                    setTruncated((current) => current || value.truncated);
                  }
                  fresh = false;
                  ready = !replaying;
                  lostAt = 0;
                  terminal.options.disableStdin = replaying;
                  if (!replaying) {
                    setState("ready");
                    fitNow();
                    if (visibleRef.current) terminal.focus();
                  }
                } else if (value.type === "replay-size") {
                  const size = parseTerminalReplaySize(value);
                  if (size.seq > received + 1) throw new Error("Replay gap.");
                  if (size.seq === received + 1) terminal.resize(size.cols, size.rows);
                } else if (value.type === "replay-end") {
                  if (
                    value.version !== 2 ||
                    !Number.isSafeInteger(value.seq) ||
                    value.seq !== received
                  )
                    throw new Error("Replay gap.");
                  replaying = false;
                  ready = true;
                  terminal.options.disableStdin = false;
                  setState("ready");
                  fitNow();
                  if (visibleRef.current) terminal.focus();
                }
                return;
              }
              const frame = decodeTerminalFrame(new Uint8Array(event.data));
              if (frame.seq <= received) {
                if (frame.seq <= ack && next.readyState === WebSocket.OPEN)
                  next.send(JSON.stringify({ type: "ack", seq: frame.seq }));
                return;
              }
              if (frame.seq !== received + 1) throw new Error("Replay gap.");
              received = frame.seq;
              await new Promise<void>((resolve) => terminal.write(frame.bytes, resolve));
              ack = frame.seq;
              if (!disposed && socket === next && next.readyState === WebSocket.OPEN)
                next.send(JSON.stringify({ type: "ack", seq: ack }));
            } catch {
              ready = false;
              next.onclose = null;
              next.close();
              setState("ended");
            }
          });
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
      } catch (cause) {
        if (!disposed) {
          setError(
            initialSession && fresh && labelsRef.current.expired
              ? labelsRef.current.expired
              : cause instanceof Error
                ? cause.message
                : null,
          );
          setState("ended");
        }
      } finally {
        connecting = false;
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
      const detach = detachRef.current?.() === true;
      // A restored id is not owned until admission; StrictMode cleanup must not end it.
      if (sessionId && admitted && !detach)
        void serialize(() => closeSession(sessionId!)).catch(() => {});
      clearInterval(heartbeat);
      clearTimeout(retry);
      clearTimeout(resize);
      if (!detach && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "close" }));
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      binary.dispose();
      links.dispose();
      for (const blocker of blockers) blocker.dispose();
      terminal.dispose();
      if (xterm.current === terminal) xterm.current = null;
      search.current = null;
      refit.current = () => {};
    };
  }, [attempt]);
  useEffect(() => {
    xterm.current?.textarea?.setAttribute("aria-label", labels.terminal);
  }, [labels.terminal]);
  useEffect(() => {
    if (visible) refit.current();
  }, [visible]);
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
        {link && openLink && labels.openLink ? (
          <Button
            size="sm"
            variant="ghost"
            title={link}
            disabled={state !== "ready"}
            onClick={(event) => activateLink.current(event.nativeEvent, link)}
          >
            {labels.openLink}
          </Button>
        ) : null}
      </div>
      {truncated && labels.earlierUnavailable ? (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          {labels.earlierUnavailable}
        </p>
      ) : null}
      {state !== "ready" ? (
        <div role="status" className="flex items-center gap-3 p-3 text-sm text-muted-foreground">
          <span>
            {state === "ended"
              ? (error ?? labels.ended)
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
