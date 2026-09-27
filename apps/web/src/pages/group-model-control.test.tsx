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
        throw Object.assign(new Error("This member's model changed. Reload the group."), {
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
      "This member's model changed. Reload the group.",
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
