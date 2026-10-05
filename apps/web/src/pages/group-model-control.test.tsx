// @vitest-environment jsdom
import type { Bot, GroupMember } from "@ardurbot/contracts";
import { modelPinOptionKey } from "@ardurbot/core";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buttonActions = vi.hoisted(() => ({ save: undefined as (() => void) | undefined }));

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
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
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => {
    if (props.className === "mt-2") buttonActions.save = () => props.onClick?.(null as never);
    return <button {...props} />;
  },
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: () => null,
}));
vi.mock("../components/ShowAllModels", () => ({ ShowAllModels: () => null }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    models: { validatePin: vi.fn(async () => ({ ok: true })) },
    runtimes: {
      availability: vi.fn(async () => ({
        runtimeKind: "antigravity",
        available: true,
        models: [{ id: "claude-sonnet-4-6", label: "Sonnet", efforts: [] }],
      })),
    },
  },
}));

import { failureCategoryMessage } from "@ardurbot/contracts";
import { rpc } from "../lib/rpc";
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
  i18n.load("en", {});
  i18n.activate("en");
  vi.mocked(rpc.models.validatePin).mockReset();
  vi.mocked(rpc.models.validatePin).mockResolvedValue({ ok: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(
  memberValue: GroupMember | undefined,
  onSave = vi.fn(async (): Promise<void> => undefined),
  botValue = bot,
) {
  await act(async () =>
    root.render(
      <GroupModelControl member={memberValue} bot={botValue} settings={settings} onSave={onSave} />,
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

function saveButton() {
  return [...container.querySelectorAll("button")].find((button) =>
    ["Save model", "Saving…"].includes(button.textContent ?? ""),
  )!;
}

function expectSaveBlocked(reason: string) {
  const button = saveButton();
  expect(button.disabled).toBe(true);
  const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe(reason);
  expect(description?.getAttribute("role")).toBe("status");
  expect(description?.hidden).toBe(false);
}

function expectSaveReady() {
  expect(saveButton().disabled).toBe(false);
  expect(saveButton().hasAttribute("aria-describedby")).toBe(false);
  expect(container.querySelector('[id$="-save-reason"]')).toBeNull();
}

describe("group model control", () => {
  it("explains a missing Hermes model, then saves the unchanged valid choice", async () => {
    const save = await render(
      member,
      vi.fn(async () => undefined),
      {
        ...bot,
        runtimeExperimental: true,
      },
    );
    await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
    expectSaveBlocked("Choose a model");
    await act(async () => saveButton().click());
    await act(async () => buttonActions.save?.());
    expect(save).not.toHaveBeenCalled();

    await change(
      container.querySelector('select[id$="-model"]')!,
      modelPinOptionKey("test", "model-a", "credential"),
    );
    expectSaveReady();
    await act(async () => saveButton().click());
    expect(save).toHaveBeenCalledWith(member, {
      runtimeKind: "hermes",
      provider: "test",
      modelId: "model-a",
      credentialId: "credential",
      effort: "medium",
    });
  });

  it("explains Experimental off and clears the reason when bot settings allow saving", async () => {
    const save = await render({ ...member, runtimePin: pin });
    await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
    expectSaveBlocked("This choice needs a supported computer and bot settings.");
    await act(async () => saveButton().click());
    await act(async () => buttonActions.save?.());
    expect(save).not.toHaveBeenCalled();
    await render({ ...member, runtimePin: pin }, save, { ...bot, runtimeExperimental: true });
    expectSaveReady();
    expect((container.querySelector('select[id$="-runtime"]') as HTMLSelectElement).value).toBe(
      "hermes",
    );
  });

  it.each([
    "test::model-a",
    "test::",
    "[broken",
    '["test","model-a",1]',
    '["","model-a","credential"]',
    '["test","","credential"]',
    '["test","model-a",""]',
    '[" ","model-a","credential"]',
    '["test"," ","credential"]',
    '["test","model-a"," "]',
  ])("explains an incomplete or malformed choice %s without saving it", async (key) => {
    const save = await render({ ...member, runtimePin: pin });
    const model = container.querySelector('select[id$="-model"]') as HTMLSelectElement;
    const option = document.createElement("option");
    option.value = key;
    model.append(option);
    await change(model, key);
    expectSaveBlocked("Choose a model");
    await act(async () => saveButton().click());
    await act(async () => buttonActions.save?.());
    expect(save).not.toHaveBeenCalled();
    await change(model, modelPinOptionKey("test", "model-a", "credential"));
    expectSaveReady();
  });

  it("uses Saving… for the pending state and prevents a second save", async () => {
    let finish!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render({ ...member, runtimePin: pin }, save);
    await act(async () => saveButton().click());
    expect(saveButton().textContent).toBe("Saving…");
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().hasAttribute("aria-describedby")).toBe(false);
    expect(container.querySelector('[id$="-save-reason"]')).toBeNull();
    await act(async () => saveButton().click());
    await act(async () => buttonActions.save?.());
    expect(save).toHaveBeenCalledOnce();
    await act(async () => finish());
    expectSaveReady();
  });

  it.each([
    [
      "BAD_REQUEST",
      "Hermes needs a context limit of at least 64K tokens. Set it for this connection in Settings → Models.",
    ],
    ["BAD_REQUEST", "This choice needs a supported computer and bot settings."],
    ["FORBIDDEN", "Native runtimes need a single-user host for now — change the pin."],
  ] as const)(
    "shows a server %s refusal and keeps the complete Hermes choice: %s",
    async (code, message) => {
      const save = vi.fn(async () => {
        throw new ORPCError(code, { message });
      });
      await render({ ...member, runtimePin: pin }, save, { ...bot, runtimeExperimental: true });
      await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
      expectSaveReady();
      await act(async () => saveButton().click());
      expect(save).toHaveBeenCalledWith(
        { ...member, runtimePin: pin },
        {
          runtimeKind: "hermes",
          provider: "test",
          modelId: "model-a",
          credentialId: "credential",
          effort: "medium",
        },
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
      expect((container.querySelector('select[id$="-runtime"]') as HTMLSelectElement).value).toBe(
        "hermes",
      );
      expect((container.querySelector('select[id$="-model"]') as HTMLSelectElement).value).toBe(
        modelPinOptionKey("test", "model-a", "credential"),
      );
      expectSaveReady();
    },
  );
  it.each([
    { reasoning: true, effort: "high" },
    { reasoning: false, effort: "off" },
  ])(
    "saves and reads back a Hermes group model with $effort effort",
    async ({ reasoning, effort }) => {
      const compatibleSettings = {
        ...settings!,
        catalog: [
          {
            ...settings!.catalog[0]!,
            provider: "openai-compatible",
            id: "fixture-model",
            reasoning,
            thinkingLevels: reasoning ? ["off", "low", "medium", "high"] : ["off"],
          },
        ],
        credentials: [
          {
            ...settings!.credentials[0]!,
            provider: "openai-compatible",
            modelId: "fixture-model",
            thinkingLevel: effort,
            reasoning,
            thinkingLevels: reasoning ? ["off", "low", "medium", "high"] : ["off"],
          },
        ],
      } as Parameters<typeof GroupModelControl>[0]["settings"];
      const save = vi.fn(async (_member: GroupMember, choice: GroupMember["runtimePin"]) => {
        await act(async () =>
          root.render(
            <GroupModelControl
              member={{ ...member, modelPinRevision: 1, runtimePin: { ...choice!, revision: 1 } }}
              bot={{ ...bot, runtimeExperimental: true }}
              settings={compatibleSettings}
              onSave={save as never}
            />,
          ),
        );
      });
      await act(async () =>
        root.render(
          <GroupModelControl
            member={member}
            bot={{ ...bot, runtimeExperimental: true }}
            settings={compatibleSettings}
            onSave={save as never}
          />,
        ),
      );
      await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
      await change(
        container.querySelector('select[id$="-model"]')!,
        modelPinOptionKey("openai-compatible", "fixture-model", "credential"),
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Save model")!
          .click(),
      );
      expect(save).toHaveBeenCalledWith(
        member,
        expect.objectContaining({ runtimeKind: "hermes", effort }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect((container.querySelector('select[id$="-model"]') as HTMLSelectElement).value).toBe(
        modelPinOptionKey("openai-compatible", "fixture-model", "credential"),
      );
    },
  );

  it("saves a native model without an effort through RuntimeSettings", async () => {
    const save = await render(
      member,
      vi.fn(async () => undefined),
      { ...bot, runtimeExperimental: true },
    );
    const runtime = container.querySelector('select[id$="-runtime"]') as HTMLSelectElement;
    await change(runtime, "antigravity");
    const model = container.querySelector('select[id$="-model"]') as HTMLSelectElement;
    await change(model, "claude-sonnet-4-6");
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(false);
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledWith(member, {
      runtimeKind: "antigravity",
      provider: "antigravity",
      modelId: "claude-sonnet-4-6",
      credentialId: "native:antigravity",
      effort: null,
    });
  });
  it("saves and reads back a Hermes group connection, then keeps it on Pi", async () => {
    const compatibleSettings = {
      ...settings!,
      catalog: [{ ...settings!.catalog[0]!, provider: "openai-compatible" }],
      credentials: [{ ...settings!.credentials[0]!, provider: "openai-compatible" }],
    };
    const save = vi.fn(async (_member: GroupMember, choice: GroupMember["runtimePin"]) => {
      expect(choice?.runtimeKind).toBe("hermes");
      await act(async () =>
        root.render(
          <GroupModelControl
            member={{ ...member, modelPinRevision: 1, runtimePin: { ...choice!, revision: 1 } }}
            bot={{ ...bot, runtimeExperimental: true }}
            settings={compatibleSettings}
            onSave={save as never}
          />,
        ),
      );
    });
    await act(async () =>
      root.render(
        <GroupModelControl
          member={member}
          bot={{ ...bot, runtimeExperimental: true }}
          settings={compatibleSettings}
          onSave={save as never}
        />,
      ),
    );
    await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
    await change(
      container.querySelector('select[id$="-model"]')!,
      modelPinOptionKey("openai-compatible", "model-a", "credential"),
    );
    const saveButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(false);
    await act(async () => saveButton.click());
    expect(
      container.querySelector('select[id$="-model"]')?.getAttribute("value") ??
        (container.querySelector('select[id$="-model"]') as HTMLSelectElement).value,
    ).toBe(modelPinOptionKey("openai-compatible", "model-a", "credential"));
    await change(container.querySelector('select[id$="-runtime"]')!, "pi");
    expect((container.querySelector('select[id$="-model"]') as HTMLSelectElement).value).toBe(
      modelPinOptionKey("openai-compatible", "model-a", "credential"),
    );
  });

  it("explains an incompatible Hermes group connection and blocks saving it", async () => {
    const signInSettings = {
      ...settings!,
      credentials: [{ ...settings!.credentials[0]!, oauth: true }],
    } as Parameters<typeof GroupModelControl>[0]["settings"];
    await act(async () =>
      root.render(
        <GroupModelControl
          member={{ ...member, runtimePin: pin }}
          bot={{ ...bot, runtimeExperimental: true }}
          settings={signInSettings}
          onSave={vi.fn()}
        />,
      ),
    );
    await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Add an API key connection to use this provider with Hermes.",
    );
    // The sign-in connection stays listed but cannot be picked.
    const signInOption = [...container.querySelectorAll('select[id$="-model"] option')].find(
      (item) => item.getAttribute("value")?.includes("test"),
    );
    expect(signInOption).toBeDefined();
    expect((signInOption as HTMLOptionElement).disabled).toBe(true);
    const saveButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(true);
    expectSaveBlocked("Add an API key connection to use this provider with Hermes.");
  });

  it("lists a key-based catalog connection for Hermes without a warning", async () => {
    await render({ ...member, runtimePin: pin }, vi.fn(), { ...bot, runtimeExperimental: true });
    await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
    expect(container.querySelector('[role="status"]')).toBeNull();
    const option = [...container.querySelectorAll('select[id$="-model"] option')].find((item) =>
      item.getAttribute("value")?.includes("test"),
    );
    expect(option).toBeDefined();
    expect((option as HTMLOptionElement).disabled).toBe(false);
    const saveButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(false);
  });

  it("allows clearing a saved Hermes override when Experimental is disabled", async () => {
    const hermesPin = {
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "model-a",
      credentialId: "credential",
      effort: "high",
      revision: 1,
    };
    const compatibleSettings = {
      ...settings!,
      catalog: [{ ...settings!.catalog[0]!, provider: "openai-compatible" }],
      credentials: [{ ...settings!.credentials[0]!, provider: "openai-compatible" }],
    };
    const save = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <GroupModelControl
          member={{ ...member, runtimePin: hermesPin }}
          bot={{ ...bot, runtimeExperimental: false }}
          settings={compatibleSettings}
          onSave={save}
        />,
      ),
    );
    const modelSelect = container.querySelector('select[id$="-model"]') as HTMLSelectElement;
    expect(modelSelect.value).toBe(modelPinOptionKey("openai-compatible", "model-a", "credential"));
    expectSaveBlocked("This choice needs a supported computer and bot settings.");

    await change(modelSelect, "");
    expect(modelSelect.value).toBe("");

    const saveButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(false);
    expectSaveReady();
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ botId: member.botId }), null);
  });

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

  it("keeps the unsaved choice selected after a failed save", async () => {
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
    expect(select.value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not save group model.",
    );
  });

  it("shows the server message next to the control, retains the unsaved choice on save failure, and clears on retry", async () => {
    let attempts = 0;
    const save = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new ORPCError("FORBIDDEN", {
          message: "Native runtimes need a single-user host for now — change the pin.",
        });
      }
      return undefined;
    });
    await render(member, save);
    const select = container.querySelector("select")!;
    expect(select.value).toBe("");
    const newChoice = modelPinOptionKey("test", "model-a", "credential");
    await change(select, newChoice);
    expect(select.value).toBe(newChoice);

    const saveButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Save model",
    )!;
    await act(async () => saveButton.click());

    expect(save).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Native runtimes need a single-user host for now — change the pin.",
    );
    expect(select.value).toBe(newChoice);

    // Retry saving the same unsaved choice
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reloads a conflicting member so the next save uses the fresh revision", async () => {
    const stale = { ...member, modelPinRevision: 1, runtimePin: pin };
    const fresh = { ...stale, modelPinRevision: 2 };
    const save = vi.fn(async (value: GroupMember) => {
      if (value.modelPinRevision !== 2) {
        throw new ORPCError("CONFLICT", {
          message: "This member's model revision cannot advance.",
        });
      }
    });
    const reload = vi.fn(async () => fresh);
    await act(async () =>
      root.render(
        <GroupModelControl
          member={stale}
          bot={bot}
          settings={settings}
          onSave={save}
          onReload={reload}
        />,
      ),
    );
    const select = container.querySelector("select")!;
    await change(select, "");
    await act(async () => container.querySelector<HTMLButtonElement>("button:last-child")!.click());
    expect(reload).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The group model choice was reloaded. Pick again.",
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button:last-child")!.click());
    expect(save).toHaveBeenLastCalledWith(fresh, expect.objectContaining({ modelId: "model-a" }));
  });

  it("reloads the latest choice and asks to pick again after a conflict", async () => {
    const stale = { ...member, modelPinRevision: 1, runtimePin: pin };
    const fresh = { ...member, modelPinRevision: 2, runtimePin: null };
    const save = vi.fn(async () => {
      throw new ORPCError("CONFLICT", {
        message: "This member's model changed. Reload the group.",
      });
    });
    await act(async () =>
      root.render(
        <GroupModelControl
          member={stale}
          bot={bot}
          settings={settings}
          onSave={save}
          onReload={vi.fn(async () => fresh)}
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button:last-child")!.click());
    // Someone else changed this member's model: show the reloaded choice, not the stale one.
    expect(container.querySelector("select")?.value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The group model choice was reloaded. Pick again.",
    );
  });

  it("disables edits for an unsaved member", async () => {
    const save = await render(undefined);
    expect(container.querySelector("select")?.disabled).toBe(true);
    expect(container.querySelector("button:last-child")?.hasAttribute("disabled")).toBe(true);
    expectSaveBlocked("Save the group first.");
    await act(async () => buttonActions.save?.());
    expect(save).not.toHaveBeenCalled();
    await render(member, save);
    expectSaveReady();
  });

  it("names the default connection when a newer matching connection comes first", async () => {
    const inheritedBot = {
      ...bot,
      modelProvider: null,
      modelId: null,
      modelCredentialId: null,
      thinkingLevel: null,
    };
    const defaultConnection = settings!.credentials[0]!;
    const newer = { ...defaultConnection, id: "newer", label: "Newer", isDefault: false };
    await act(async () =>
      root.render(
        <BotModelChip
          bot={inheritedBot}
          settings={{ ...settings!, credentials: [newer, defaultConnection] }}
          display="using"
          run={{ runtimePin: { ...pin, modelId: "model-old" } }}
        />,
      ),
    );
    expect(container.querySelector("details")?.textContent).toContain("Connection");
    expect(container.querySelector("details")?.textContent).not.toContain("Newer");
  });

  it.each(["inherited", "explicit"] as const)(
    "shows a non-reasoning %s choice without a change disclosure",
    async (selection) => {
      const localSettings = {
        ...settings!,
        me: { defaultProvider: "ollama", defaultModel: "local-model" },
        catalog: [
          {
            ...settings!.catalog[0]!,
            provider: "ollama",
            providerName: "Ollama",
            id: "local-model",
            label: "Local model",
            reasoning: false,
            thinkingLevels: [] as [],
          },
        ],
        credentials: [{ ...settings!.credentials[0]!, provider: "ollama", modelId: "local-model" }],
      };
      await act(async () =>
        root.render(
          <BotModelChip
            bot={{
              ...bot,
              modelProvider: selection === "explicit" ? "ollama" : null,
              modelId: selection === "explicit" ? "local-model" : null,
              modelCredentialId: selection === "explicit" ? "credential" : null,
              thinkingLevel: "off",
            }}
            settings={localSettings}
            display="using"
            run={{
              runtimePin: {
                ...pin,
                provider: "ollama",
                modelId: "local-model",
                effort: null,
              },
            }}
          />,
        ),
      );
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Ardur · Ollama · Local model · not applicable",
      );
      expect(container.querySelector("details")).toBeNull();
    },
  );

  it.each([false, true])(
    "does not disclose an unchanged explicit-off group selection with reasoning %s",
    async (reasoning) => {
      const effectiveRuntimePin = {
        ...pin,
        provider: "ollama",
        modelId: "local-model",
        effort: "off",
        revision: 4,
      };
      const groupMember = { ...member, effectiveRuntimePin };
      const localSettings = {
        ...settings!,
        catalog: [
          {
            ...settings!.catalog[0]!,
            provider: "ollama",
            id: "local-model",
            reasoning,
          },
        ],
        credentials: [{ ...settings!.credentials[0]!, provider: "ollama", modelId: "local-model" }],
      };
      await act(async () =>
        root.render(
          <BotModelChip
            bot={{
              ...bot,
              modelProvider: "ollama",
              modelId: "local-model",
              thinkingLevel: "off",
            }}
            settings={localSettings}
            pin={groupMember.effectiveRuntimePin}
            nextPin={groupMember.effectiveRuntimePin}
            display="using"
            run={{
              runtimePin: {
                ...effectiveRuntimePin,
                effort: reasoning ? "none" : null,
              },
            }}
          />,
        ),
      );
      expect(container.querySelector("details")).toBeNull();
    },
  );

  it("does not disclose an admitted explicit-off group run that still stores off", async () => {
    // The stored override keeps "off" for a reasoning-capable local model and the admitted run
    // carries that same value; only the display normalises it.
    const effectiveRuntimePin = {
      ...pin,
      provider: "ollama",
      modelId: "local-model",
      effort: "off",
      revision: 4,
    };
    const localSettings = {
      ...settings!,
      catalog: [
        { ...settings!.catalog[0]!, provider: "ollama", id: "local-model", reasoning: true },
      ],
      credentials: [{ ...settings!.credentials[0]!, provider: "ollama", modelId: "local-model" }],
    };
    await act(async () =>
      root.render(
        <BotModelChip
          bot={{ ...bot, modelProvider: "ollama", modelId: "local-model", thinkingLevel: "off" }}
          settings={localSettings}
          pin={effectiveRuntimePin}
          nextPin={effectiveRuntimePin}
          display="using"
          run={{ runtimePin: { ...effectiveRuntimePin } }}
        />,
      ),
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Next run");
  });

  it("shows a running disabled reasoning choice as off and available", async () => {
    const localSettings = {
      ...settings!,
      me: { defaultProvider: "ollama", defaultModel: "local-model" },
      catalog: [
        {
          ...settings!.catalog[0]!,
          provider: "ollama",
          providerName: "Ollama",
          id: "local-model",
          label: "Local model",
          reasoning: true,
          thinkingLevels: ["off", "low"] as ["off", "low"],
        },
      ],
      credentials: [{ ...settings!.credentials[0]!, provider: "ollama", modelId: "local-model" }],
    };
    await act(async () =>
      root.render(
        <BotModelChip
          bot={{
            ...bot,
            modelProvider: null,
            modelId: null,
            modelCredentialId: null,
            thinkingLevel: "off",
          }}
          settings={localSettings}
          display="using"
          run={{
            runtimePin: { ...pin, provider: "ollama", modelId: "local-model", effort: "none" },
          }}
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Ardur · Ollama · Local model · off",
    );
    expect(container.querySelector("details")).toBeNull();
  });

  it("discloses an inherited effort change with the same model", async () => {
    const inheritedSettings = {
      ...settings!,
      credentials: settings!.credentials.map((item) => ({
        ...item,
        thinkingLevel: "high" as const,
      })),
    };
    await act(async () =>
      root.render(
        <BotModelChip
          bot={{
            ...bot,
            modelProvider: null,
            modelId: null,
            modelCredentialId: null,
            thinkingLevel: null,
          }}
          settings={inheritedSettings}
          nextPin={null}
          display="using"
          run={{ runtimePin: { ...pin, effort: "low" } }}
        />,
      ),
    );
    expect(container.querySelector("details")?.textContent).toContain("high");
  });

  it("discloses an explicit effort change with the same model", async () => {
    await act(async () =>
      root.render(
        <BotModelChip
          bot={bot}
          settings={settings}
          nextPin={{ ...pin, effort: "high" }}
          display="using"
          run={{ runtimePin: pin }}
        />,
      ),
    );
    expect(container.querySelector("details")?.textContent).toContain("high");
  });

  it("discloses provider and connection changes even when the model ID stays the same", async () => {
    await act(async () =>
      root.render(
        <BotModelChip
          bot={bot}
          settings={settings}
          nextPin={{
            ...pin,
            provider: "other-provider",
            credentialId: "other-connection",
            revision: 2,
          }}
          display="using"
          run={{ runtimePin: pin }}
        />,
      ),
    );
    const details = container.querySelector("details")!;
    expect(details.textContent).toContain("other-provider");
    expect(details.textContent).toContain("other-connection");
  });

  it("ignores revision-only changes in the next-run disclosure", async () => {
    await act(async () =>
      root.render(
        <BotModelChip
          bot={bot}
          settings={settings}
          nextPin={{ ...pin, revision: 99 }}
          display="using"
          run={{ runtimePin: pin }}
        />,
      ),
    );
    expect(container.querySelector("details")).toBeNull();
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

  it("displays captured Hermes runtime settings and allows refreshing to bot settings", async () => {
    const groupMember = {
      ...member,
      modelPinRevision: 1,
      runtimePin: {
        runtimeKind: "hermes" as const,
        provider: "openai-compatible",
        modelId: "model-a",
        credentialId: "credential",
        effort: "high",
        revision: 1,
        runtimeConfig: {
          version: 2 as const,
          runtimeKind: "hermes" as const,
          limits: {
            maxProviderRequests: 5,
            timeoutMs: 30_000,
          },
          context: {
            maxInputBytes: 16_384,
            overflow: "trim" as const,
          },
          harness: {
            agent: {
              api_max_retries: 1,
            },
          },
        },
      },
    };
    const hermesBot = {
      ...bot,
      runtimeKind: "hermes" as const,
      modelPinRevision: 3,
      runtimeExperimental: true,
      runtimeConfig: {
        version: 2 as const,
        runtimeKind: "hermes" as const,
        limits: {
          maxProviderRequests: 10,
          timeoutMs: 60_000,
        },
        context: {
          maxInputBytes: 32_768,
          overflow: "trim" as const,
        },
        harness: {
          agent: {
            api_max_retries: 1,
          },
        },
      },
    };
    const save = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <GroupModelControl
          member={groupMember}
          bot={hermesBot}
          settings={settings}
          onSave={save}
        />,
      ),
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Runtime settings");
    expect(text).toContain("Model calls per turn: 5");
    expect(text).toContain("Time limit (seconds): 30");
    expect(text).toContain("Context limit (KiB): 16");
    expect(text).toContain("Captured for this group.");

    const refreshButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Use bot runtime settings",
    );
    expect(refreshButton).toBeDefined();

    await act(async () => refreshButton!.click());
    expect(save).toHaveBeenCalledWith(
      groupMember,
      expect.objectContaining({
        runtimeKind: "hermes",
        provider: "openai-compatible",
        modelId: "model-a",
      }),
      3,
    );
  });

  it("handles conflict when refreshing group runtime settings", async () => {
    const groupMember = {
      ...member,
      modelPinRevision: 1,
      runtimePin: {
        runtimeKind: "hermes" as const,
        provider: "openai-compatible",
        modelId: "model-a",
        credentialId: "credential",
        effort: "high",
        revision: 1,
        runtimeConfig: {
          version: 2 as const,
          runtimeKind: "hermes" as const,
          limits: {
            maxProviderRequests: 5,
            timeoutMs: 30_000,
          },
          context: {
            maxInputBytes: 16_384,
            overflow: "trim" as const,
          },
          harness: {
            agent: {
              api_max_retries: 1,
            },
          },
        },
      },
    };
    const hermesBot = {
      ...bot,
      runtimeKind: "hermes" as const,
      modelPinRevision: 3,
      runtimeExperimental: true,
      runtimeConfig: {
        version: 2 as const,
        runtimeKind: "hermes" as const,
        limits: {
          maxProviderRequests: 10,
          timeoutMs: 60_000,
        },
        context: {
          maxInputBytes: 32_768,
          overflow: "trim" as const,
        },
        harness: {
          agent: {
            api_max_retries: 1,
          },
        },
      },
    };
    const save = vi.fn(async () => {
      throw new ORPCError("CONFLICT", {
        message: "Bot settings changed. Reload before saving.",
      });
    });
    await act(async () =>
      root.render(
        <GroupModelControl
          member={groupMember}
          bot={hermesBot}
          settings={settings}
          onSave={save}
        />,
      ),
    );

    const refreshButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Use bot runtime settings",
    );
    await act(async () => refreshButton!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Bot settings changed. Reload before saving.",
    );
  });
});

it.each([
  "experimental-off",
  "computer-unsupported",
  "destinations-space",
  "connection-missing",
] as const)(
  "group picker blocks Save and explains %s using the server sentence",
  async (category) => {
    const sentence = failureCategoryMessage(category, { runtime: "Codex", bot: "this bot" });
    vi.mocked(rpc.models.validatePin).mockRejectedValue(
      new ORPCError("BAD_REQUEST", { message: sentence }),
    );
    const onSave = await render({ ...member, runtimePin: pin }, undefined, {
      ...bot,
      runtimeExperimental: true,
    });
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(sentence);
    await act(async () => button.click());
    expect(onSave).not.toHaveBeenCalled();
    expect(rpc.models.validatePin).toHaveBeenCalledWith(expect.objectContaining({ botId: bot.id }));
  },
);

it("shows the server reason when Same as bot would inherit settings that cannot run", async () => {
  const sentence = failureCategoryMessage("computer-unsupported", {
    runtime: "Codex",
    bot: "this bot",
  });
  vi.mocked(rpc.models.validatePin).mockRejectedValue(
    new ORPCError("BAD_REQUEST", { message: sentence }),
  );
  await render({ ...member, runtimePin: null });
  expect(rpc.models.validatePin).toHaveBeenCalledWith(
    expect.objectContaining({ botId: bot.id, inheritBotPin: true }),
  );
  expect(container.textContent).toContain(sentence);
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save model",
  )!;
  expect(save.disabled).toBe(true);
});
