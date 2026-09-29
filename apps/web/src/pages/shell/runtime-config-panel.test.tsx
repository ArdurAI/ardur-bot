// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    runtimeConfig: {
      preview: vi.fn(async () => ({
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
      })),
    },
  },
}));

import { RuntimeConfigPanel } from "./runtime-config-panel";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: Partial<Parameters<typeof RuntimeConfigPanel>[0]> = {}) {
  const onChange = props.onChange ?? vi.fn();
  const onError = props.onError ?? vi.fn();
  const onOpenLearning = props.onOpenLearning ?? vi.fn();

  await act(async () => {
    root.render(
      <RuntimeConfigPanel
        value={props.value ?? null}
        onChange={onChange}
        onError={onError}
        onOpenLearning={onOpenLearning}
        {...props}
      />,
    );
  });

  return { onChange, onError, onOpenLearning };
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("RuntimeConfigPanel", () => {
  it("renders short panel with default values and labels", async () => {
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Model calls per turn");
    expect(text).toContain("Time limit (seconds)");
    expect(text).toContain("Context limit (KiB)");
    expect(text).toContain("Learning");
    expect(text).toContain("Advanced");

    const inputs = container.querySelectorAll("input");
    expect(inputs).toHaveLength(3);
    expect(inputs[0]!.value).toBe("16");
    expect(inputs[1]!.value).toBe("180");
    expect(inputs[2]!.value).toBe("16");
  });

  it("updates calls limit and calls onChange", async () => {
    const { onChange, onError } = await render();
    const callsInput = container.querySelectorAll("input")[0]!;

    await changeInput(callsInput, "32");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ maxProviderRequests: 32 }),
      }),
    );
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("updates time limit in seconds and converts to milliseconds", async () => {
    const { onChange, onError } = await render();
    const timeInput = container.querySelectorAll("input")[1]!;

    await changeInput(timeInput, "60");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ timeoutMs: 60_000 }),
      }),
    );
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("updates context limit in KiB and converts to bytes", async () => {
    const { onChange, onError } = await render();
    const contextInput = container.querySelectorAll("input")[2]!;

    await changeInput(contextInput, "32");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ maxInputBytes: 32_768 }),
      }),
    );
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("validates bounds and granularity for all fields", async () => {
    const { onError } = await render();
    const [callsInput, timeInput, contextInput] = Array.from(
      container.querySelectorAll("input"),
    ) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

    // Calls bounds
    await changeInput(callsInput, "0");
    expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Use a whole number from 1 to 64.",
    );

    await changeInput(callsInput, "65");
    expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");

    // Time whole seconds and bounds
    await changeInput(callsInput, "16"); // restore calls
    await changeInput(timeInput, "1.5");
    expect(onError).toHaveBeenLastCalledWith("Use whole seconds.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Use whole seconds.");

    await changeInput(timeInput, "700");
    expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 600.");

    // Context whole KiB and bounds
    await changeInput(timeInput, "180"); // restore time
    await changeInput(contextInput, "2");
    expect(onError).toHaveBeenLastCalledWith("Use a whole number from 4 to 64.");

    await changeInput(contextInput, "5.5");
    expect(onError).toHaveBeenLastCalledWith("Use whole KiB.");
  });

  it("retains per-field errors when editing another valid field", async () => {
    const { onError } = await render();
    const [callsInput, timeInput] = Array.from(container.querySelectorAll("input")) as [
      HTMLInputElement,
      HTMLInputElement,
    ];

    // Put calls into error
    await changeInput(callsInput, "0");
    expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");

    // Edit time with a valid value - calls error must persist!
    await changeInput(timeInput, "120");
    expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Use a whole number from 1 to 64.",
    );
  });

  it("invokes onOpenLearning when Learning button is clicked", async () => {
    const { onOpenLearning } = await render();
    const learningButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Learning",
    );
    expect(learningButton).toBeDefined();

    await act(async () => learningButton!.click());
    expect(onOpenLearning).toHaveBeenCalledTimes(1);
  });

  it("opens Advanced disclosure and lazy loads RuntimeConfigAdvanced", async () => {
    await render();
    const details = container.querySelector("details");
    expect(details).not.toBeNull();

    await act(async () => {
      details!.open = true;
      details!.dispatchEvent(new Event("toggle"));
    });

    await vi.waitFor(() => {
      const advancedText = container.textContent ?? "";
      expect(advancedText).toContain("Configuration (JSON)");
      expect(advancedText).toContain("Effective configuration");
    });
  });
});
