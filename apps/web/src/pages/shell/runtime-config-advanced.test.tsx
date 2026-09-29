// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { previewMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    runtimeConfig: {
      preview: (...args: unknown[]) => previewMock(...args),
    },
  },
}));

import { HERMES_RUNTIME_V2_DEFAULTS } from "@ardurbot/contracts/runtime-config";
import { RuntimeConfigAdvanced } from "./runtime-config-advanced";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  previewMock.mockReset();
  previewMock.mockResolvedValue({
    preview: {
      settings: {
        version: 2,
        runtimeKind: "hermes",
        limits: { maxProviderRequests: 16, timeoutMs: 180_000 },
        context: { maxInputBytes: 16_384, overflow: "trim" },
        harness: { agent: { api_max_retries: 1 } },
      },
      managed: {
        model: "claude-sonnet-4-6",
        thinkingLevel: "medium",
        connection: "test-connection",
        tools: "standard",
      },
    },
    issues: [],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: Partial<Parameters<typeof RuntimeConfigAdvanced>[0]> = {}) {
  type Props = Parameters<typeof RuntimeConfigAdvanced>[0];
  const onChange = (props.onChange ?? vi.fn()) as Props["onChange"] & Mock;
  const onError = (props.onError ?? vi.fn()) as Props["onError"] & Mock;
  const onReset = (props.onReset ?? vi.fn()) as Props["onReset"] & Mock;

  await act(async () => {
    root.render(
      <RuntimeConfigAdvanced
        value={props.value ?? HERMES_RUNTIME_V2_DEFAULTS}
        onChange={onChange}
        onError={onError}
        onReset={onReset}
        {...props}
      />,
    );
  });

  return { onChange, onError, onReset };
}

async function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("RuntimeConfigAdvanced", () => {
  it("renders editor with initial formatted configuration and previews", async () => {
    await render();

    const textarea = container.querySelector("textarea")!;
    expect(textarea).not.toBeNull();
    expect(textarea.getAttribute("aria-label")).toBe("Configuration (JSON)");
    expect(textarea.value).toContain('"version": 2');
    expect(textarea.value).toContain('"runtimeKind": "hermes"');

    const text = container.textContent ?? "";
    expect(text).toContain("Model, thinking, connections, tools, and permissions come from Ardur.");
    expect(text).toContain("Reset to defaults");
    expect(text).toContain("Effective configuration");
    expect(text).toContain("Your settings");
    expect(text).toContain("Ardur manages");
    expect(text).toContain("Unavailable with Hermes.");
    expect(text).toContain("Off");
  });

  it("updates and normalizes valid JSON", async () => {
    const { onChange, onError } = await render();
    const textarea = container.querySelector("textarea")!;

    const validJson = JSON.stringify({
      version: 2,
      runtimeKind: "hermes",
      limits: { maxProviderRequests: 32, timeoutMs: 60_000 },
    });

    await changeTextarea(textarea, validJson);

    expect(onError).toHaveBeenCalledWith(null);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        runtimeKind: "hermes",
        limits: expect.objectContaining({ maxProviderRequests: 32, timeoutMs: 60_000 }),
      }),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("handles invalid JSON syntax", async () => {
    const { onError, onChange } = await render();
    const textarea = container.querySelector("textarea")!;

    onChange.mockClear();
    await changeTextarea(textarea, "{ not valid json");

    expect(onError).toHaveBeenCalledWith("Enter valid JSON.");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter valid JSON.");
  });

  it("detects duplicate keys", async () => {
    const { onError, onChange } = await render();
    const textarea = container.querySelector("textarea")!;

    onChange.mockClear();
    await changeTextarea(
      textarea,
      '{"version": 2, "runtimeKind": "hermes", "limits": {}, "limits": {}}',
    );

    expect(onError).toHaveBeenCalledWith("Remove the duplicate field.");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Remove the duplicate field.",
    );
  });

  it("detects document exceeding 16 KiB", async () => {
    const { onError, onChange } = await render();
    const textarea = container.querySelector("textarea")!;

    const padding = " ".repeat(17 * 1024);
    const oversizedJson = `{"version": 2, "runtimeKind": "hermes"${padding}}`;

    onChange.mockClear();
    await changeTextarea(textarea, oversizedJson);

    expect(onError).toHaveBeenCalledWith("Configuration must be 16 KiB or smaller.");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Configuration must be 16 KiB or smaller.",
    );
  });

  it("detects unsupported version", async () => {
    const { onError, onChange } = await render();
    const textarea = container.querySelector("textarea")!;

    onChange.mockClear();
    await changeTextarea(textarea, JSON.stringify({ version: 99, runtimeKind: "hermes" }));

    expect(onError).toHaveBeenCalledWith("This configuration version is not supported.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports nesting beyond the depth limit without echoing input", async () => {
    const { onError, onChange } = await render();
    const textarea = container.querySelector("textarea")!;

    let deep = "{}";
    for (let index = 0; index < 12; index += 1) deep = `{"a":${deep}}`;
    onChange.mockClear();
    await changeTextarea(textarea, deep);

    expect(onError).toHaveBeenCalledWith("This configuration is too complex.");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This configuration is too complex.",
    );
  });

  it("rejects prototype keys with the generic unsupported-field message", async () => {
    const { onError, onChange } = await render();
    const textarea = container.querySelector("textarea")!;

    onChange.mockClear();
    await changeTextarea(
      textarea,
      '{"version": 2, "runtimeKind": "hermes", "__proto__": {"polluted": true}}',
    );

    expect(onError).toHaveBeenCalledWith("This field is not supported.");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This field is not supported.",
    );
  });

  it.each([
    {
      field: "model",
      json: { version: 2, runtimeKind: "hermes", model: "gpt-4" },
      expected: "Ardur sets the model and thinking level. Change them in bot settings.",
    },
    {
      field: "api_key",
      json: { version: 2, runtimeKind: "hermes", api_key: "secret" },
      expected: "Use Ardur Connections for provider settings.",
    },
    {
      field: "tools",
      json: { version: 2, runtimeKind: "hermes", tools: [] },
      expected: "Use Ardur settings for tools, integrations, MCP servers, skills, and plugins.",
    },
    {
      field: "env",
      json: { version: 2, runtimeKind: "hermes", env: { SECRET: "x" } },
      expected: "Ardur manages paths, hooks, permissions, and network access.",
    },
    {
      field: "packages",
      json: { version: 2, runtimeKind: "hermes", packages: ["pip"] },
      expected: "Runtime settings cannot install or load code.",
    },
    {
      field: "memory",
      json: { version: 2, runtimeKind: "hermes", memory: {} },
      expected: "Use Ardur Learning settings.",
    },
    {
      field: "subagents",
      json: { version: 2, runtimeKind: "hermes", subagents: [] },
      expected: "Native child agents are not available with Hermes.",
    },
    {
      field: "compression",
      json: { version: 2, runtimeKind: "hermes", compression: {} },
      expected: "Native compression is not available with Hermes.",
    },
  ])("detects forbidden key $field and shows exact message", async ({ json, expected }) => {
    const { onError } = await render();
    const textarea = container.querySelector("textarea")!;

    await changeTextarea(textarea, JSON.stringify(json));
    expect(onError).toHaveBeenCalledWith(expected);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
  });

  it("resets to defaults when clicking Reset to defaults", async () => {
    const { onReset } = await render();
    const textarea = container.querySelector("textarea")!;

    await changeTextarea(textarea, "{ invalid json");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const resetButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reset to defaults",
    );
    expect(resetButton).toBeDefined();

    await act(async () => resetButton!.click());
    expect(onReset).toHaveBeenCalled();
    expect(textarea.value).toContain('"version": 2');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("handles preview failure and retry", async () => {
    previewMock.mockRejectedValueOnce(new Error("Network error"));
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Could not preview the configuration. Try again.");

    const retryButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again",
    );
    expect(retryButton).toBeDefined();

    previewMock.mockResolvedValueOnce({
      preview: {
        settings: {
          version: 2,
          runtimeKind: "hermes",
          limits: { maxProviderRequests: 16, timeoutMs: 180_000 },
          context: { maxInputBytes: 16_384, overflow: "trim" },
          harness: { agent: { api_max_retries: 1 } },
        },
        managed: null,
      },
      issues: [],
    });

    await act(async () => retryButton!.click());
    expect(previewMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Could not preview the configuration. Try again.");
  });
});
