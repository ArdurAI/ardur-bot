// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  shortcut: null as ((action: "voice" | "dictation") => void) | null,
  final: null as ((text: string) => void) | null,
  snapshot: { status: "idle", transcript: "" },
  subscribers: new Set<(value: { status: string; transcript: string }) => void>(),
  listen: vi.fn(),
  stop: vi.fn(),
  submit: vi.fn(),
  off: vi.fn(),
  quickBot: vi.fn(async () => null as string | null),
  close: vi.fn(async () => undefined),
  send: vi.fn(async (_input: unknown, _options: unknown) => ({ runId: "run" })),
  voice: vi.fn(async () => ({ transcribe: true })),
}));
vi.mock("./bridge", () => ({ systemBridge: () => bridge }));
const bridge = {
  quickBot: fake.quickBot,
  closeQuick: fake.close,
  onShortcut: (listener: (action: "voice" | "dictation") => void) => {
    fake.shortcut = listener;
    return fake.off;
  },
};
vi.mock("../../lib/rpc", () => ({
  selectedSpaceId: () => "space",
  rpc: {
    me: async () => ({ userId: "user", spaceId: "space" }),
    bots: { list: async () => [{ id: "bot", name: "Coordinator" }] },
    threads: { send: fake.send },
    voice: { status: fake.voice },
  },
}));
vi.mock("../../lib/dictation", () => ({
  dictation: {
    get state() {
      return fake.snapshot;
    },
    subscribe: (listener: (value: { status: string; transcript: string }) => void) => {
      fake.subscribers.add(listener);
      return () => fake.subscribers.delete(listener);
    },
    listen: fake.listen,
    stop: fake.stop,
    submitHold: fake.submit,
  },
}));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: translate }) }));
function translate(parts: TemplateStringsArray, ...values: unknown[]) {
  return parts.reduce((s, part, i) => s + part + (values[i] ?? ""), "");
}
vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { QuickComposer } from "./QuickComposer";
import { SystemDictation } from "./SystemDictation";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.snapshot = { status: "idle", transcript: "" };
  fake.listen.mockImplementation(async ({ onFinal }) => {
    fake.final = onFinal;
    fake.snapshot = { status: "listening", transcript: "" };
    for (const listener of fake.subscribers) listener(fake.snapshot);
  });
  fake.submit.mockImplementation(() => {
    fake.snapshot = { status: "idle", transcript: "" };
    for (const listener of fake.subscribers) listener(fake.snapshot);
    fake.final?.("Spoken words");
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function render(children: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(cleanup);
  await act(async () => root.render(children));
  return container;
}
it("sends quick access to the chosen bot's normal thread, retaining its nonce after a failed send", async () => {
  const c = await render(<QuickComposer signedIn />);
  const select = c.querySelector("select")!,
    textarea = c.querySelector("textarea")!;
  await act(async () => {
    select.value = "bot";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "A task",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  fake.send.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => c.querySelector("button")!.click());
  expect(fake.send).toHaveBeenCalledWith(
    { botId: "bot", text: "A task", clientNonce: expect.any(String) },
    { context: { spaceId: "space" } },
  );
  expect(textarea.value).toBe("A task");
  expect(fake.close).not.toHaveBeenCalled();
  const nonce = fake.send.mock.calls[0]![0];
  await act(async () => c.querySelector("button")!.click());
  expect(fake.send.mock.calls[1]![0]).toEqual(nonce);
  expect(fake.quickBot).toHaveBeenCalledWith({ userId: "user", spaceId: "space" }, "bot");
  expect(fake.close).toHaveBeenCalledOnce();
});
function Draft() {
  const [draft, setDraft] = useState("Existing");
  const textarea = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea ref={textarea} value={draft} readOnly />
      <SystemDictation textarea={textarea} setDraft={setDraft} />
    </>
  );
}
it("starts and stops existing voice input, appending only to the active draft", async () => {
  const c = await render(<Draft />);
  await act(async () => fake.shortcut!("voice"));
  expect(fake.listen).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "hold", transcribe: true }),
  );
  expect(c.textContent).toContain("Listening…");
  await act(async () => fake.shortcut!("voice"));
  expect(fake.submit).toHaveBeenCalledOnce();
  expect(c.querySelector("textarea")!.value).toBe("Existing Spoken words");
});
it("requires the chat input for in-window dictation and cancels the microphone on unmount", async () => {
  const c = await render(<Draft />);
  await act(async () => fake.shortcut!("dictation"));
  expect(fake.listen).not.toHaveBeenCalled();
  c.querySelector("textarea")!.focus();
  await act(async () => fake.shortcut!("dictation"));
  expect(fake.listen).toHaveBeenCalledOnce();
  await cleanups.pop()!();
  expect(fake.stop).toHaveBeenCalledWith("cancel");
  expect(fake.off).toHaveBeenCalledOnce();
});
