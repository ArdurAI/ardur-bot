// @vitest-environment jsdom
import type { Bot, GroupMember, ProductEvent, ThreadSnapshot } from "@ardurbot/contracts";
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
vi.mock("../components/ShowAllModels", () => ({ ShowAllModels: () => null }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    runtimes: {
      availability: vi.fn(async () => ({
        runtimeKind: "antigravity",
        available: true,
        models: [{ id: "claude-sonnet-4-6", label: "Sonnet", efforts: [] }],
      })),
    },
  },
}));

import { activeMemberRun, reduceThreadSnapshot } from "../lib/thread-events";
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

async function render(
  memberValue: GroupMember | undefined,
  onSave = vi.fn(async () => undefined),
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

describe("group model control", () => {
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
    await render({ ...member, runtimePin: pin }, vi.fn(), { ...bot, runtimeExperimental: true });
    await change(container.querySelector('select[id$="-runtime"]')!, "hermes");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Hermes does not yet support this connection.",
    );
    const saveButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(true);
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

    await change(modelSelect, "");
    expect(modelSelect.value).toBe("");

    const saveButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save model",
    )!;
    expect(saveButton.disabled).toBe(false);
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

  it("reloads a conflicting member so the next save uses the fresh revision", async () => {
    const stale = { ...member, modelPinRevision: 1, runtimePin: pin };
    const fresh = { ...stale, modelPinRevision: 2 };
    const save = vi.fn(async (value: GroupMember) => {
      if (value.modelPinRevision !== 2) {
        throw Object.assign(new Error("Server conflict detail"), {
          code: "CONFLICT",
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

  it("restores inheritance when a conflict reload finds a cleared override", async () => {
    const stale = { ...member, modelPinRevision: 1, runtimePin: pin };
    const fresh = { ...member, modelPinRevision: 2, runtimePin: null };
    const save = vi.fn(async () => {
      throw Object.assign(new Error("This member's model changed. Reload the group."), {
        code: "CONFLICT",
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
    expect(container.querySelector("select")?.value).toBe("");
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

  it("waits for a live run's admitted pin before showing Using", async () => {
    const snapshot: ThreadSnapshot = {
      groupId: "room",
      threadId: "thread",
      cursor: 0,
      messages: [],
      olderCursor: null,
      run: null,
      activeRuns: [],
    };
    const start = {
      id: "event",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      seq: 1,
      type: "run.started",
      runId: "run",
      createdAt: "2026-09-01T00:00:00Z",
      payload: {},
    } as ProductEvent;
    const nextPin = { ...pin, modelId: "new-choice" };
    const renderBadge = async (current: ThreadSnapshot | null) =>
      act(async () =>
        root.render(
          <BotModelChip
            bot={bot}
            settings={settings}
            pin={nextPin}
            nextPin={nextPin}
            display="using"
            run={activeMemberRun(current?.activeRuns ?? [], "bot")}
          />,
        ),
      );

    const pending = reduceThreadSnapshot(snapshot, start);
    await renderBadge(pending);
    expect(container.querySelector('[aria-label="Using new-choice"]')).toBeNull();
    expect(container.textContent).toContain("Next run");

    const admitted = reduceThreadSnapshot(pending!, {
      ...start,
      id: "admitted",
      seq: 2,
      payload: { runtimePin: pin },
    });
    await renderBadge(admitted);
    expect(container.querySelector('[aria-label="Using model-a"]')).not.toBeNull();
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
});
