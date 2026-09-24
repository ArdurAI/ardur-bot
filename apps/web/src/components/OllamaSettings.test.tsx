// @vitest-environment jsdom
import type { OllamaStatus } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OllamaSettings } from "./OllamaSettings";

const api = vi.hoisted(() => ({
  ollama: vi.fn(),
  testOllama: vi.fn(),
  connect: vi.fn(),
  setDefault: vi.fn(),
  pullOllama: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { models: api } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
vi.mock("./ai/primitives", () => ({
  LoadingState: ({ label }: { label: string }) => <span>{label}</span>,
}));

const state: OllamaStatus = { baseUrl: "http://127.0.0.1:11434", models: [], canPull: true };
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const changed = vi.fn(async () => undefined);
beforeEach(() => {
  vi.resetAllMocks();
  api.ollama.mockResolvedValue(state);
  api.testOllama.mockResolvedValue({ ...state, version: "test-version" });
  api.connect.mockResolvedValue({ id: "connection" });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
const button = (text: string) =>
  [...node.querySelectorAll("button")].find((entry) => entry.textContent === text)!;

it("tests the detected URL, reports empty tags and saves a keyless connection before pulling", async () => {
  await act(async () => root.render(<OllamaSettings onChanged={changed} />));
  expect(node.querySelector("input")?.value).toBe(state.baseUrl);
  expect(button("Save").disabled).toBe(true);
  await act(async () => button("Test").click());
  expect(node.textContent).toContain("Ollama test-version");
  expect(node.textContent).toContain("No models installed. Pull one to start.");
  await act(async () => button("Save").click());
  expect(api.connect).toHaveBeenCalledWith(
    { provider: "ollama", baseUrl: state.baseUrl, modelId: undefined },
    expect.anything(),
  );
  expect(node.textContent).toContain("Pull model");
  expect(changed).toHaveBeenCalledOnce();
});

it("shows plain connection refused copy", async () => {
  api.testOllama.mockResolvedValue({
    ...state,
    issue: "Ollama is not running. Start it and try again.",
  });
  await act(async () => root.render(<OllamaSettings onChanged={changed} />));
  await act(async () => button("Test").click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(
    "Ollama is not running. Start it and try again.",
  );
  expect(button("Save").disabled).toBe(true);
});

it("shows discovered names and parameter sizes without pull controls for a non-owner", async () => {
  api.ollama.mockResolvedValue({
    ...state,
    canPull: false,
    version: "test-version",
    credentialId: "connection",
    models: [
      {
        id: "qwen3:8b",
        parameterSize: "8.2B",
        reasoning: true,
        acceptsImages: false,
        supportsThinkingOff: true,
      },
    ],
  });
  await act(async () => root.render(<OllamaSettings onChanged={changed} />));
  expect(node.textContent).toContain("qwen3:8b · 8.2B");
  expect(node.textContent).not.toContain("Pull model");
  expect(node.querySelector('input[type="password"]')).toBeNull();
});

it("renders streamed counters and cancels the active pull", async () => {
  api.ollama.mockResolvedValue({ ...state, version: "test-version", credentialId: "connection" });
  let pullSignal: AbortSignal | undefined;
  api.pullOllama.mockImplementation(async (_input, { signal }: { signal: AbortSignal }) => {
    pullSignal = signal;
    return (async function* () {
      yield { status: "pulling layer", completed: 50, total: 100 };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    })();
  });
  await act(async () => root.render(<OllamaSettings onChanged={changed} />));
  await act(async () => button("Pull").click());
  expect(node.textContent).toContain("pulling layer · 50%");
  await act(async () => button("Cancel").click());
  expect(pullSignal?.aborted).toBe(true);
  expect(node.textContent).not.toContain("pulling layer");
  expect(changed).not.toHaveBeenCalled();
});
