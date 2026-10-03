// @vitest-environment jsdom
import type { HermesRuntimeConfigV2 } from "@ardurbot/contracts/runtime-config";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { previewMock, validatePinMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  validatePinMock: vi.fn(),
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
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    models: { validatePin: (...args: unknown[]) => validatePinMock(...args) },
    runtimeConfig: {
      preview: (...args: unknown[]) => previewMock(...args),
    },
  },
}));

import { RuntimeConfigPanel } from "./runtime-config-panel";

const successPreview = {
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
};

beforeEach(() => {
  validatePinMock.mockReset();
  validatePinMock.mockResolvedValue({ ok: true });
  previewMock.mockReset();
  previewMock.mockResolvedValue(successPreview);
});

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

function ControlledHarness({ onError }: { onError: (error: string | null) => void }) {
  const [value, setValue] = useState<HermesRuntimeConfigV2 | null>(null);
  return (
    <RuntimeConfigPanel
      value={value}
      onChange={setValue}
      onError={onError}
      onOpenLearning={() => {}}
    />
  );
}

async function openAdvanced() {
  const details = container.querySelector("details")!;
  expect(details).not.toBeNull();
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await vi.waitFor(() => {
    expect(container.querySelector("textarea")).not.toBeNull();
  });
  return { details, textarea: container.querySelector("textarea")! };
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

  it("disables short-panel inputs with a hint while the Advanced JSON is invalid", async () => {
    const onError = vi.fn();
    await act(async () => {
      root.render(<ControlledHarness onError={onError} />);
    });
    const { textarea } = await openAdvanced();
    const [callsInput, timeInput, contextInput] = Array.from(
      container.querySelectorAll("input"),
    ) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

    expect(callsInput.disabled).toBe(false);

    await changeTextarea(textarea, "{ not valid json");

    // While the JSON is invalid the short panel cannot be edited, and says why.
    expect(callsInput.disabled).toBe(true);
    expect(timeInput.disabled).toBe(true);
    expect(contextInput.disabled).toBe(true);
    expect(container.textContent).toContain("Fix the configuration JSON to edit these settings.");

    // Fixing the JSON re-enables the inputs with the parsed values; no edit is lost.
    await changeTextarea(
      textarea,
      JSON.stringify({
        version: 2,
        runtimeKind: "hermes",
        limits: { maxProviderRequests: 32, timeoutMs: 60_000 },
      }),
    );

    expect(callsInput.disabled).toBe(false);
    expect(timeInput.disabled).toBe(false);
    expect(contextInput.disabled).toBe(false);
    expect(container.textContent).not.toContain(
      "Fix the configuration JSON to edit these settings.",
    );
    expect(callsInput.value).toBe("32");
    expect(timeInput.value).toBe("60");
  });

  it("keeps the Advanced error visible and Save blocked while the section is closed", async () => {
    const onError = vi.fn();
    await act(async () => {
      root.render(<ControlledHarness onError={onError} />);
    });
    const { details, textarea } = await openAdvanced();

    await changeTextarea(textarea, "{ not valid json");
    expect(onError).toHaveBeenLastCalledWith("Enter valid JSON.");

    // Closing the section must not hide the reason Save stays disabled.
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(onError).toHaveBeenLastCalledWith("Enter valid JSON.");
    expect(container.querySelector('[data-testid="runtime-config-panel-error"]')?.textContent).toBe(
      "Enter valid JSON.",
    );

    // Reopen and fix: the error clears and Save is allowed again.
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await changeTextarea(textarea, JSON.stringify({ version: 2, runtimeKind: "hermes" }));
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(container.querySelector('[data-testid="runtime-config-panel-error"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("links each short-panel error to its input for assistive technology", async () => {
    await render();
    const [callsInput, timeInput, contextInput] = Array.from(
      container.querySelectorAll("input"),
    ) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

    const describedByText = (input: HTMLInputElement) => {
      const descId = input.getAttribute("aria-describedby");
      return descId ? document.getElementById(descId)?.textContent : null;
    };

    // Valid fields carry no aria error attributes.
    for (const input of [callsInput, timeInput, contextInput]) {
      expect(input.getAttribute("aria-invalid")).toBeNull();
      expect(input.getAttribute("aria-describedby")).toBeNull();
    }

    await changeInput(callsInput, "0");
    expect(callsInput.getAttribute("aria-invalid")).toBe("true");
    expect(describedByText(callsInput)).toBe("Use a whole number from 1 to 64.");
    expect(timeInput.getAttribute("aria-invalid")).toBeNull();
    expect(timeInput.getAttribute("aria-describedby")).toBeNull();

    await changeInput(callsInput, "16");
    expect(callsInput.getAttribute("aria-invalid")).toBeNull();
    expect(callsInput.getAttribute("aria-describedby")).toBeNull();

    await changeInput(timeInput, "1.5");
    expect(timeInput.getAttribute("aria-invalid")).toBe("true");
    expect(describedByText(timeInput)).toBe("Use whole seconds.");

    await changeInput(timeInput, "180");
    expect(timeInput.getAttribute("aria-invalid")).toBeNull();
    await changeInput(contextInput, "65");
    expect(contextInput.getAttribute("aria-invalid")).toBe("true");
    expect(describedByText(contextInput)).toBe("Use a whole number from 4 to 64.");
  });

  it("clears a rejected preview after a short-panel edit replaces the text", async () => {
    // The server rejects the model key, so Save stays disabled; a later
    // short-panel edit replaces the editor text with a normalized value and
    // must not keep that stale error.
    validatePinMock.mockReset();
    validatePinMock.mockResolvedValue({ ok: true });
    previewMock.mockReset();
    previewMock.mockResolvedValueOnce({
      preview: undefined,
      issues: [{ code: "managed-model", path: "model", reasonId: "managed-model" }],
    });
    previewMock.mockResolvedValue(successPreview);

    const onError = vi.fn();
    await act(async () => {
      root.render(<ControlledHarness onError={onError} />);
    });
    const { textarea } = await openAdvanced();

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Ardur sets the model and thinking level. Change them in bot settings.",
      );
    });
    expect(onError).toHaveBeenLastCalledWith(
      "Ardur sets the model and thinking level. Change them in bot settings.",
    );

    // The JSON parses, so the short-panel fields stay editable; Save is blocked
    // only by the reported error.
    const callsInput = container.querySelectorAll("input")[0]! as HTMLInputElement;
    expect(callsInput.disabled).toBe(false);

    previewMock.mockClear();
    await changeInput(callsInput, "24");

    await vi.waitFor(() => {
      expect(JSON.parse(textarea.value).limits.maxProviderRequests).toBe(24);
    });
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(container.textContent).not.toContain(
      "Ardur sets the model and thinking level. Change them in bot settings.",
    );

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalled();
    });
    const lastCall = previewMock.mock.calls.at(-1)![0] as {
      runtimeConfig: { limits: { maxProviderRequests: number } };
    };
    expect(lastCall.runtimeConfig.limits.maxProviderRequests).toBe(24);
  });

  // A non-null onError keeps the bot-settings Save button disabled.
  describe("short-panel bounds", () => {
    const fieldErrorText = (input: HTMLInputElement) => {
      const descId = input.getAttribute("aria-describedby");
      return descId ? document.getElementById(descId)?.textContent : null;
    };

    it("model calls per turn rejects non-integer and out-of-range values and recovers", async () => {
      const { onError } = await render();
      const callsInput = container.querySelectorAll("input")[0]!;

      await changeInput(callsInput, "2.5");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");
      expect(fieldErrorText(callsInput)).toBe("Use a whole number from 1 to 64.");

      await changeInput(callsInput, "0");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");
      await changeInput(callsInput, "65");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");

      await changeInput(callsInput, "8");
      expect(onError).toHaveBeenLastCalledWith(null);
      expect(callsInput.getAttribute("aria-invalid")).toBeNull();
      expect(callsInput.getAttribute("aria-describedby")).toBeNull();
    });

    it("time limit rejects non-integer and out-of-range values and recovers", async () => {
      const { onError } = await render();
      const timeInput = container.querySelectorAll("input")[1]!;

      await changeInput(timeInput, "1.5");
      expect(onError).toHaveBeenLastCalledWith("Use whole seconds.");
      expect(fieldErrorText(timeInput)).toBe("Use whole seconds.");

      await changeInput(timeInput, "0");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 600.");
      expect(fieldErrorText(timeInput)).toBe("Use a whole number from 1 to 600.");
      await changeInput(timeInput, "601");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 600.");

      await changeInput(timeInput, "60");
      expect(onError).toHaveBeenLastCalledWith(null);
      expect(timeInput.getAttribute("aria-invalid")).toBeNull();
      expect(timeInput.getAttribute("aria-describedby")).toBeNull();
    });

    it("context limit rejects non-integer and out-of-range values and recovers", async () => {
      const { onError } = await render();
      const contextInput = container.querySelectorAll("input")[2]!;

      await changeInput(contextInput, "5.5");
      expect(onError).toHaveBeenLastCalledWith("Use whole KiB.");
      expect(fieldErrorText(contextInput)).toBe("Use whole KiB.");

      await changeInput(contextInput, "3");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 4 to 64.");
      expect(fieldErrorText(contextInput)).toBe("Use a whole number from 4 to 64.");
      await changeInput(contextInput, "65");
      expect(onError).toHaveBeenLastCalledWith("Use a whole number from 4 to 64.");

      await changeInput(contextInput, "32");
      expect(onError).toHaveBeenLastCalledWith(null);
      expect(contextInput.getAttribute("aria-invalid")).toBeNull();
      expect(contextInput.getAttribute("aria-describedby")).toBeNull();
    });
  });
});

it("shows the server's pin refusal before Advanced is opened", async () => {
  const sentence =
    "Hermes needs a context limit of at least 64K tokens. Set it for this connection in Settings → Models.";
  validatePinMock.mockRejectedValue({ code: "BAD_REQUEST", message: sentence });
  const onError = vi.fn();
  await act(async () => {
    root.render(
      <RuntimeConfigPanel
        value={null}
        onChange={() => {}}
        onError={onError}
        pin={{
          runtimeKind: "hermes",
          provider: "openai-compatible",
          modelId: "fixture-model",
          credentialId: "connection",
          effort: "off",
        }}
      />,
    );
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(sentence);
  expect(onError).toHaveBeenLastCalledWith(sentence);
  expect(previewMock).not.toHaveBeenCalled();
  await act(async () => {
    root.render(
      <RuntimeConfigPanel
        value={null}
        onChange={() => {}}
        onError={onError}
        pin={{
          runtimeKind: "hermes",
          provider: "openai-compatible",
          modelId: "other-model",
          credentialId: "connection",
          effort: "off",
        }}
      />,
    );
  });
  expect(validatePinMock).toHaveBeenCalledTimes(2);
});

it("ignores a stale pin refusal after the picker changes", async () => {
  let refuse!: (reason: unknown) => void;
  validatePinMock.mockReturnValueOnce(
    new Promise((_, reject) => {
      refuse = reject;
    }),
  );
  const onError = vi.fn();
  const selected = {
    runtimeKind: "hermes" as const,
    provider: "openai-compatible",
    modelId: "old",
    credentialId: "connection",
    effort: "off",
  };
  await act(async () => {
    root.render(
      <RuntimeConfigPanel value={null} onChange={() => {}} onError={onError} pin={selected} />,
    );
  });
  await act(async () => {
    root.render(
      <RuntimeConfigPanel
        value={null}
        onChange={() => {}}
        onError={onError}
        pin={{ ...selected, modelId: "new" }}
      />,
    );
  });
  await act(async () => {
    refuse({ code: "BAD_REQUEST", message: "Old refusal" });
  });
  expect(container.textContent).not.toContain("Old refusal");
  expect(onError).toHaveBeenLastCalledWith(null);
});
