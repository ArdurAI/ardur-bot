// @vitest-environment jsdom
import type { OllamaStatus } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OllamaConnection } from "../components/ollama-connection";

vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));

it("renders connection, version and discovered model names without editable or pull controls", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const status: OllamaStatus = {
    baseUrl: "http://host.docker.internal:11434",
    credentialId: "connection",
    canPull: true,
    version: "test-version",
    models: [
      {
        id: "qwen3:8b",
        parameterSize: "8.2B",
        reasoning: true,
        acceptsImages: false,
        supportsThinkingOff: true,
      },
    ],
  };
  await act(async () => root.render(createElement(OllamaConnection, { status })));
  expect(node.textContent).toContain(status.baseUrl);
  expect(node.textContent).toContain("test-version");
  expect(node.textContent).toContain("qwen3:8b · 8.2B");
  expect(node.querySelectorAll("button,input,select,textarea")).toHaveLength(0);
  await act(async () =>
    root.render(createElement(OllamaConnection, { status: { ...status, models: [] } })),
  );
  expect(node.textContent).toContain("No models installed. Pull one to start.");
  await act(async () =>
    root.render(
      createElement(OllamaConnection, {
        status: { ...status, issue: "Ollama is not running. Start it and try again." },
      }),
    ),
  );
  expect(node.textContent).toContain("Ollama is not running. Start it and try again.");
  await act(async () => root.unmount());
});
