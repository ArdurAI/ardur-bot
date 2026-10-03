// @vitest-environment jsdom
import type { HermesRuntimeConfigV2 } from "@ardurbot/contracts/runtime-config";
import type { ReactNode } from "react";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { RuntimeConfigAdvanced } from "../components/runtime-config-advanced";
import { RuntimeConfigPanel } from "../components/runtime-config-panel";
import { rpc } from "./api";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    foreground: "#111",
    mutedForeground: "#666",
    border: "#ccc",
    destructive: "#d00",
  }),
}));
vi.mock("react-native", () => ({
  Platform: { select: (options: Record<string, string>) => options.ios },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
      },
      children,
    ),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  View: ({
    children,
    style,
    ...rest
  }: {
    children: ReactNode;
    style?: unknown;
    [key: string]: unknown;
  }) => createElement("div", { style, ...rest }, children),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    multiline,
    keyboardType,
    editable,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel?: string;
    multiline?: boolean;
    keyboardType?: string;
    editable?: boolean;
  }) =>
    createElement("textarea", {
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      "aria-label": accessibilityLabel,
      "data-multiline": multiline ? "true" : undefined,
      "data-keyboard": keyboardType,
      disabled: editable === false,
    }),
}));

const defaults: HermesRuntimeConfigV2 = {
  version: 2,
  runtimeKind: "hermes",
  limits: { maxProviderRequests: 16, timeoutMs: 180_000 },
  context: { maxInputBytes: 16_384, overflow: "trim" },
  harness: { agent: { api_max_retries: 1 } },
};

const previewResponse = {
  preview: {
    settings: defaults,
    managed: {
      model: "fixture",
      thinkingLevel: "high",
      connection: "openai-compatible",
      credentials: "broker-grant",
      tools: "ardur-catalog",
      approvals: "ardur-policy",
      paths: "ephemeral-owned-home",
      network: "managed-relay",
      nativeChildren: false,
      nativeCompression: false,
    },
  },
  issues: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

function field(node: HTMLElement, label: string): HTMLTextAreaElement {
  return node.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;
}

function pressable(node: HTMLElement, label: string): HTMLButtonElement {
  return node.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
}

function byText(node: HTMLElement, text: string): HTMLButtonElement {
  return [...node.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement;
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
  .set!;

async function typeInto(input: HTMLTextAreaElement, text: string) {
  await act(async () => {
    nativeValueSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderPanel(initial: HermesRuntimeConfigV2 | null = null) {
  const onChange = vi.fn();
  const onError = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(RuntimeConfigPanel, {
        value: initial,
        onChange,
        onError,
        pin: null,
      }),
    ),
  );
  return {
    node,
    root,
    onChange,
    onError,
    input: (label: string) =>
      node.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement,
    change: async (input: HTMLTextAreaElement, text: string) => {
      await typeInto(input, text);
    },
  };
}

/** Mirrors bot-settings: the draft lives in the parent and Save follows onError. */
function ControlledPanel({ onError }: { onError: (error: string | null) => void }) {
  const [value, setValue] = useState<HermesRuntimeConfigV2 | null>(null);
  return createElement(RuntimeConfigPanel, {
    value,
    onChange: setValue,
    onError,
    pin: null,
  });
}

async function renderControlledPanel(onError: (error: string | null) => void) {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(ControlledPanel, { onError })));
  return { node, root };
}

it("shows the three numeric fields with numeric keyboards and no errors", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const { node, root, onError } = await renderPanel();
  const calls = field(node, "Model calls per turn");
  const time = field(node, "Time limit (seconds)");
  const context = field(node, "Context limit (KiB)");
  expect(calls.getAttribute("data-keyboard")).toBe("number-pad");
  expect(time.getAttribute("data-keyboard")).toBe("number-pad");
  expect(context.getAttribute("data-keyboard")).toBe("number-pad");
  expect(calls.value).toBe("16");
  expect(time.value).toBe("180");
  expect(context.value).toBe("16");
  expect(onError).not.toHaveBeenCalledWith(expect.any(String));
  await act(async () => root.unmount());
});

it("reports the shared range errors per field without clearing the others", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const { node, root, change, onError } = await renderPanel();
  const calls = field(node, "Model calls per turn");
  const time = field(node, "Time limit (seconds)");
  const context = field(node, "Context limit (KiB)");

  await change(calls, "0");
  expect(node.textContent).toContain("Use a whole number from 1 to 64.");
  expect(onError).toHaveBeenLastCalledWith("Use a whole number from 1 to 64.");

  await change(time, "abc");
  expect(node.textContent).toContain("Use whole seconds.");
  // The calls error stays; per-field errors are independent.
  expect(node.textContent).toContain("Use a whole number from 1 to 64.");

  await change(context, "5.5");
  expect(node.textContent).toContain("Use whole KiB.");

  await change(calls, "8");
  expect(node.textContent).not.toContain("Use a whole number from 1 to 64.");
  await change(time, "700");
  expect(node.textContent).toContain("Use a whole number from 1 to 600.");
  await change(context, "4");
  expect(node.textContent).not.toContain("Use whole KiB.");
  await act(async () => root.unmount());
});

it("emits the expanded document for valid edits", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const { node, root, change, onChange } = await renderPanel();
  const calls = field(node, "Model calls per turn");
  await change(calls, "32");
  const last = onChange.mock.calls.at(-1)![0] as HermesRuntimeConfigV2;
  expect(last.limits.maxProviderRequests).toBe(32);
  expect(last.version).toBe(2);
  expect(last.context.overflow).toBe("trim");
  await act(async () => root.unmount());
});

it("opens Advanced, serializes the draft, previews it, and renders managed rows", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const { node, root } = await renderPanel(defaults);
  const toggle = pressable(node, "Advanced");
  await act(async () => toggle.click());
  const editor = field(node, "Configuration (JSON)");
  expect(editor.value).toBe(JSON.stringify(defaults, null, 2));
  await act(async () => {});
  expect(rpc).toHaveBeenCalledWith(
    "runtimeConfig/preview",
    expect.objectContaining({ runtimeKind: "hermes" }),
  );
  expect(node.textContent).toContain("Effective configuration");
  expect(node.textContent).toContain("Your settings");
  expect(node.textContent).toContain("Ardur manages");
  expect(node.textContent).toContain("Unavailable with Hermes.");
  await act(async () => root.unmount());
});

it("shows the shared invalid-JSON error and disables saving via the panel error", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const { node, root, change, onError } = await renderPanel(defaults);
  const toggle = pressable(node, "Advanced");
  await act(async () => toggle.click());
  const editor = field(node, "Configuration (JSON)");
  await change(editor, "{ not json");
  expect(node.textContent).toContain("Enter valid JSON.");
  expect(onError).toHaveBeenCalledWith("Enter valid JSON.");
  // Closing the section keeps the visible error so Save stays explainable.
  await act(async () => toggle.click());
  expect(node.textContent).toContain("Enter valid JSON.");
  // The graphical fields are disabled while the draft is invalid.
  const calls = field(node, "Model calls per turn");
  expect((calls as unknown as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => root.unmount());
});

it("reports managed and forbidden keys with the shared messages", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const { node, root, change } = await renderPanel(defaults);
  const toggle = pressable(node, "Advanced");
  await act(async () => toggle.click());
  const editor = field(node, "Configuration (JSON)");

  await change(
    editor,
    JSON.stringify({
      ...defaults,
      model: "gpt-x",
    }),
  );
  expect(node.textContent).toContain(
    "Ardur sets the model and thinking level. Change them in bot settings.",
  );

  await change(
    editor,
    JSON.stringify({
      ...defaults,
      credentials: "secret",
    }),
  );
  expect(node.textContent).toContain("Use Ardur Connections for provider settings.");

  await change(
    editor,
    JSON.stringify({
      ...defaults,
      compression: { enabled: true },
    }),
  );
  expect(node.textContent).toContain("Native compression is not available with Hermes.");

  await change(editor, JSON.stringify({ ...defaults, mystery: 1 }));
  expect(node.textContent).toContain("This field is not supported.");
  await act(async () => root.unmount());
});

it("keeps invalid text in the editor and does not call onChange for it", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const onChange = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(RuntimeConfigAdvanced, {
        value: defaults,
        pin: null,
        onChange,
        onError: vi.fn(),
        onReset: vi.fn(),
      }),
    ),
  );
  const editor = field(node, "Configuration (JSON)");
  await typeInto(editor, "{oops");
  expect(editor.value).toBe("{oops");
  expect(onChange).not.toHaveBeenCalled();
  // Fixing the text resumes normal updates.
  await typeInto(editor, JSON.stringify(defaults));
  expect(onChange).toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("resets the draft to the published defaults", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const onReset = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(RuntimeConfigAdvanced, {
        value: {
          ...defaults,
          limits: { maxProviderRequests: 64, timeoutMs: 600_000 },
        },
        pin: null,
        onChange: vi.fn(),
        onError: vi.fn(),
        onReset,
      }),
    ),
  );
  const reset = node.querySelector("button") as unknown as HTMLButtonElement;
  await act(async () => reset.click());
  expect(onReset).toHaveBeenCalled();
  const editor = field(node, "Configuration (JSON)");
  expect(JSON.parse(editor.value)).toEqual(defaults);
  await act(async () => root.unmount());
});

it("shows the preview failure message and retries", async () => {
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(RuntimeConfigAdvanced, {
        value: defaults,
        pin: null,
        onChange: vi.fn(),
        onError: vi.fn(),
        onReset: vi.fn(),
      }),
    ),
  );
  await act(async () => {});
  expect(node.textContent).toContain("Could not preview the configuration. Try again.");
  vi.mocked(rpc).mockResolvedValueOnce(previewResponse);
  const retry = byText(node, "Try again");
  await act(async () => retry.click());
  await act(async () => {});
  expect(node.textContent).not.toContain("Could not preview the configuration. Try again.");
  await act(async () => root.unmount());
});

it("ignores a stale preview response that resolves after a newer request", async () => {
  let resolveFirst: (value: unknown) => void = () => undefined;
  vi.mocked(rpc).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  vi.mocked(rpc).mockResolvedValueOnce({
    ...previewResponse,
    preview: {
      ...previewResponse.preview,
      settings: { ...defaults, limits: { maxProviderRequests: 7, timeoutMs: 180_000 } },
    },
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(RuntimeConfigAdvanced, {
        value: defaults,
        pin: null,
        onChange: vi.fn(),
        onError: vi.fn(),
        onReset: vi.fn(),
      }),
    ),
  );
  // Second request (pin change would trigger this in production; call directly).
  const editor = field(node, "Configuration (JSON)");
  await typeInto(editor, JSON.stringify(defaults));
  await act(async () => resolveFirst(previewResponse));
  await act(async () => {});
  // The newer response (7) wins; the stale one (16 default) is discarded.
  expect(node.textContent).toContain("7");
  await act(async () => root.unmount());
});

it("surfaces server issue messages from the preview endpoint", async () => {
  vi.mocked(rpc).mockResolvedValue({
    preview: undefined,
    issues: [{ code: "managed-tools", path: "tools", reasonId: "managed-tools" }],
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  const onError = vi.fn();
  await act(async () =>
    root.render(
      createElement(RuntimeConfigAdvanced, {
        value: defaults,
        pin: null,
        onChange: vi.fn(),
        onError,
        onReset: vi.fn(),
      }),
    ),
  );
  await act(async () => {});
  expect(node.textContent).toContain(
    "Use Ardur settings for tools, integrations, MCP servers, skills, and plugins.",
  );
  await act(async () => root.unmount());
});

it("keeps invalid Advanced text and state across a close and reopen", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const onError = vi.fn();
  const { node, root } = await renderControlledPanel(onError);
  const toggle = pressable(node, "Advanced");
  await act(async () => toggle.click());
  let editor = field(node, "Configuration (JSON)");
  expect(editor.value).toBe(JSON.stringify(defaults, null, 2));

  await typeInto(editor, "{");
  expect(editor.value).toBe("{");
  expect(onError).toHaveBeenLastCalledWith("Enter valid JSON.");
  const calls = field(node, "Model calls per turn");
  expect(calls.disabled).toBe(true);

  // Close: the invalid text is destroyed today; the panel keeps its flag.
  await act(async () => toggle.click());
  expect(onError).toHaveBeenLastCalledWith("Enter valid JSON.");
  expect(node.textContent).toContain("Enter valid JSON.");
  expect(node.textContent).toContain("Fix the configuration JSON to edit these settings.");
  expect(field(node, "Model calls per turn").disabled).toBe(true);

  // Reopen: the same invalid text and state must still be there.
  await act(async () => toggle.click());
  editor = field(node, "Configuration (JSON)");
  expect(editor.value).toBe("{");
  expect(editor.disabled).toBe(false);
  expect(node.textContent).toContain("Enter valid JSON.");
  expect(field(node, "Model calls per turn").disabled).toBe(true);
  expect(onError).toHaveBeenLastCalledWith("Enter valid JSON.");

  // Fixing the JSON unlocks the form.
  await typeInto(editor, JSON.stringify(defaults));
  expect(onError).toHaveBeenLastCalledWith(null);
  expect(node.textContent).not.toContain("Enter valid JSON.");
  expect(node.textContent).not.toContain("Fix the configuration JSON to edit these settings.");
  expect(field(node, "Model calls per turn").disabled).toBe(false);
  await act(async () => root.unmount());
});

it("shows the Advanced error in the panel while it is closed and invalid", async () => {
  vi.mocked(rpc).mockResolvedValue(previewResponse);
  const onError = vi.fn();
  const { node, root } = await renderControlledPanel(onError);
  const toggle = pressable(node, "Advanced");
  await act(async () => toggle.click());
  const editor = field(node, "Configuration (JSON)");

  await typeInto(editor, "{");
  await act(async () => toggle.click());
  expect(onError).toHaveBeenLastCalledWith("Enter valid JSON.");
  expect(node.textContent).toContain("Enter valid JSON.");
  expect(field(node, "Model calls per turn").disabled).toBe(true);
  await act(async () => root.unmount());
});

it("clears a stale server-preview error after a short-panel edit", async () => {
  // The server rejects the model key on the first preview; a later short-panel
  // edit replaces the editor text, so the stale error must not keep Save off.
  const serverRejected = {
    preview: undefined,
    issues: [{ code: "managed-model", path: "model", reasonId: "managed-model" }],
  };
  vi.mocked(rpc).mockResolvedValueOnce(serverRejected).mockResolvedValue(previewResponse);
  const onError = vi.fn();
  const { node, root } = await renderControlledPanel(onError);
  const toggle = pressable(node, "Advanced");
  await act(async () => toggle.click());

  await act(async () => {});
  expect(node.textContent).toContain(
    "Ardur sets the model and thinking level. Change them in bot settings.",
  );
  expect(onError).toHaveBeenLastCalledWith(
    "Ardur sets the model and thinking level. Change them in bot settings.",
  );
  // Save is blocked by the reported error; the JSON itself parses, so the
  // short-panel fields stay editable.

  // Close Advanced, then edit the short panel: the parent sends a normalized
  // value, the editor text is replaced, the stale error clears and a fresh
  // preview runs for the new value.
  await act(async () => toggle.click());
  const callsClosed = field(node, "Model calls per turn");
  expect(callsClosed.disabled).toBe(false);
  await typeInto(callsClosed, "24");
  expect(onError).toHaveBeenLastCalledWith(null);
  expect(node.textContent).not.toContain(
    "Ardur sets the model and thinking level. Change them in bot settings.",
  );

  // Reopening shows the normalized text from the short-panel edit.
  await act(async () => toggle.click());
  expect(JSON.parse(field(node, "Configuration (JSON)").value).limits.maxProviderRequests).toBe(24);
  expect(node.textContent).not.toContain(
    "Ardur sets the model and thinking level. Change them in bot settings.",
  );
  expect(field(node, "Model calls per turn").disabled).toBe(false);

  const previewCalls = vi
    .mocked(rpc)
    .mock.calls.filter((call) => call[0] === "runtimeConfig/preview");
  expect(previewCalls.length).toBeGreaterThanOrEqual(2);
  const lastPayload = previewCalls.at(-1)![1] as {
    runtimeConfig: { limits: { maxProviderRequests: number } };
  };
  expect(lastPayload.runtimeConfig.limits.maxProviderRequests).toBe(24);
  await act(async () => root.unmount());
});

it("shows the server's Hermes pin refusal in the short phone panel", async () => {
  const sentence =
    "Hermes needs a context limit of at least 64K tokens. Set it for this connection in Settings → Models.";
  vi.mocked(rpc).mockRejectedValueOnce({ code: "BAD_REQUEST", message: sentence });
  const node = document.createElement("div");
  const root = createRoot(node);
  const onError = vi.fn();
  await act(async () => {
    root.render(
      createElement(RuntimeConfigPanel, {
        value: null,
        onChange: () => {},
        onError,
        pin: {
          runtimeKind: "hermes",
          provider: "openai-compatible",
          modelId: "fixture-model",
          credentialId: "connection",
          effort: "off",
        },
      }),
    );
  });
  expect(node.textContent).toContain(sentence);
  expect(onError).toHaveBeenLastCalledWith(sentence);
  expect(rpc).toHaveBeenCalledWith(
    "models/validatePin",
    expect.objectContaining({ modelId: "fixture-model" }),
  );
  await act(async () => root.unmount());
});
