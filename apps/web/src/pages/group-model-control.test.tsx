// @vitest-environment jsdom
import type { Bot, GroupMember } from "@ardurbot/contracts";
import { modelPinOptionKey } from "@ardurbot/core";
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
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: () => null,
}));
vi.mock("./shell/runtime-settings", () => ({ RuntimeSettings: () => null }));
vi.mock("../components/ShowAllModels", () => ({ ShowAllModels: () => null }));

import { GroupModelControl } from "./group-model-control";
import { BotModelChip } from "./shell/bot-model-chip";

const bot = {
  id: "bot",
  name: "Bot",
  runtimeKind: "pi",
  runtimeExperimental: false,
  modelProvider: "test",
  modelId: "model-a",
  modelCredentialId: "credential",
  thinkingLevel: "medium",
} as Bot;
const pin = {
  runtimeKind: "pi" as const,
  provider: "test",
  modelId: "model-a",
  effort: "medium",
  credentialId: "credential",
  revision: 1,
};
const member: GroupMember = {
  botId: "bot",
  memberId: "member",
  name: "Bot",
  color: "#111",
  modelPinRevision: 0,
  runtimePin: null,
  effectiveRuntimePin: { ...pin, revision: 2 },
  effectivePinSource: "bot",
};
const settings = {
  me: { defaultProvider: "test", defaultModel: "model-a" },
  catalog: [
    {
      id: "model-a",
      provider: "test",
      providerName: "Test",
      label: "Model A",
      billing: "",
      auth: "api-key",
      reasoning: true,
      thinkingLevels: ["medium"] as ["medium"],
    },
  ],
  credentials: [
    {
      id: "credential",
      provider: "test",
      label: "Connection",
      hasKey: true,
      isDefault: true,
      modelId: "model-a",
    },
  ],
} as Parameters<typeof GroupModelControl>[0]["settings"];
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

async function render(memberValue: GroupMember | undefined, onSave = vi.fn(async () => undefined)) {
  await act(async () =>
    root.render(
      <GroupModelControl member={memberValue} bot={bot} settings={settings} onSave={onSave} />,
    ),
  );
  return onSave;
}
async function change(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("group model control", () => {
  it("starts inherited, saves an explicit equal choice, and can reset", async () => {
    const save = await render(member);
    const select = container.querySelector("select")!;
    expect(select.value).toBe("");
    await change(select, modelPinOptionKey("test", "model-a", "credential"));
    await act(async () =>
      container
        .querySelector("button:last-child")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(save).toHaveBeenCalledWith(
      member,
      expect.objectContaining({
        provider: "test",
        modelId: "model-a",
        credentialId: "credential",
      }),
    );
    await change(select, "");
    await act(async () =>
      container
        .querySelector("button:last-child")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(save).toHaveBeenLastCalledWith(member, null);
  });

  it("keeps the confirmed choice after a failed save", async () => {
    const save = vi.fn(async () => {
      throw new Error("conflict");
    });
    await render({ ...member, modelPinRevision: 1, runtimePin: pin }, save);
    const select = container.querySelector("select")!;
    await change(select, "");
    await act(async () =>
      container
        .querySelector("button:last-child")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(select.value).toBe(modelPinOptionKey("test", "model-a", "credential"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not save group model.",
    );
  });

  it("disables edits for an unsaved member", async () => {
    const save = await render(undefined);
    expect(container.querySelector("select")?.disabled).toBe(true);
    expect(container.querySelector("button:last-child")?.hasAttribute("disabled")).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("uses the active run's saved pin for the participant badge", async () => {
    await act(async () =>
      root.render(
        <BotModelChip
          bot={bot}
          settings={settings}
          pin={pin}
          nextPin={pin}
          display="using"
          run={{ runtimePin: { ...pin, modelId: "model-old", revision: 0 } }}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="Using model-old"]')).not.toBeNull();
    expect(container.textContent).toContain("Next run");
  });

  it("shows the inherited next choice after clearing an active override", async () => {
    await act(async () =>
      root.render(
        <BotModelChip
          bot={bot}
          settings={settings}
          nextPin={null}
          display="using"
          run={{ runtimePin: { ...pin, modelId: "model-old", revision: 0 } }}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="Using model-old"]')).not.toBeNull();
    expect(container.textContent).toContain("Next run");
    expect(container.textContent).toContain("model-a");
  });

  it("keeps the change chip on the saved bot choice after an older run fails", async () => {
    await act(async () =>
      root.render(
        <BotModelChip
          bot={{ ...bot, modelId: "model-b" }}
          settings={settings}
          run={{ runtimePin: { ...pin, modelId: "model-a" } }}
          onClick={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("model-b");
    expect(container.querySelector("button")?.getAttribute("aria-label")).not.toContain("model-a");
  });
});
