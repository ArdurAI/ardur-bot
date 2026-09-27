// @vitest-environment jsdom
import type { LearningProposal, SpaceLearningConfig } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  configure: vi.fn(),
  createGrant: vi.fn(),
  memoryWrite: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  revert: vi.fn(),
  list: vi.fn(),
  inbox: vi.fn().mockResolvedValue({ proposals: [] }),
  settings: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  selectedSpaceId: () => "selected-space",
  rpc: {
    learning: { ...api, list: api.inbox },
    memory: { list: api.list, import: api.memoryWrite, update: api.memoryWrite },
  },
}));
vi.mock("../MemoryHistory", () => ({ MemoryHistory: () => <div>Document history</div> }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en-US" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@ardurbot/ui-web", () => ({
  Skeleton: () => <div role="progressbar" />,
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"button">, "onChange"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { MemoryComposer } from "./MemoryComposer";
import { MemoryGeneration } from "./MemoryGeneration";
import { MEMORY_IMPORT_PROMPT, MemoryImport } from "./MemoryImport";
import { MemoryPage } from "./MemoryPage";
import { MemoryProposals } from "./MemoryProposals";

async function mounted(element: ReactNode, run: (container: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
function button(container: HTMLElement, text: string) {
  const value = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text,
  );
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
}
function input(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
const proposal: LearningProposal = {
  id: "proposal",
  type: "memory",
  scope: { spaceId: "space", userId: "user" },
  target: {},
  proposedContent: "Use concise replies.",
  rationale: "Requested import",
  evidenceIds: ["evidence"],
  diff: "+Use concise replies.",
  status: "pending",
  expiresAt: "2026-10-24T00:00:00.000Z",
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("memory proposal entry points", () => {
  it("copies the export prompt, submits pasted text for proposals, and never writes memory", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const propose = vi.fn().mockResolvedValue([proposal]);
    const onProposals = vi.fn();
    await mounted(
      <MemoryImport propose={propose} onProposals={onProposals} />,
      async (container) => {
        expect(container.querySelector("textarea")).toBeNull();
        await act(async () => button(container, "Start import").click());
        await act(async () => button(container, "Copy prompt").click());
        expect(writeText).toHaveBeenCalledWith(MEMORY_IMPORT_PROMPT);
        await act(async () =>
          input(container.querySelectorAll("textarea")[1]!, "  - Use concise replies.  "),
        );
        await act(async () => button(container, "Review import").click());
        expect(propose).toHaveBeenCalledExactlyOnceWith("- Use concise replies.");
        expect(onProposals).toHaveBeenCalledWith([proposal]);
        expect(api.memoryWrite).not.toHaveBeenCalled();
        expect(api.createGrant).not.toHaveBeenCalled();
      },
    );
  });

  it("keeps a failed import available for retry without exposing the backend error", async () => {
    const propose = vi.fn().mockRejectedValue(new Error("internal fixture failure"));
    await mounted(<MemoryImport propose={propose} onProposals={vi.fn()} />, async (container) => {
      await act(async () => button(container, "Start import").click());
      await act(async () =>
        input(container.querySelectorAll("textarea")[1]!, "- Remember a topic."),
      );
      await act(async () => button(container, "Review import").click());
      expect(container.querySelectorAll("textarea")[1]?.value).toBe("- Remember a topic.");
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not prepare the import. Try again.",
      );
      expect(container.textContent).not.toContain("internal fixture");
    });
  });

  it("sends a memory-edit instruction and returns pending proposals", async () => {
    const propose = vi.fn().mockResolvedValue([proposal]);
    const onProposals = vi.fn();
    await mounted(
      <MemoryComposer propose={propose} onProposals={onProposals} />,
      async (container) => {
        expect(button(container, "Send").disabled).toBe(true);
        await act(async () => input(container.querySelector("textarea")!, "Use concise replies."));
        await act(async () => button(container, "Send").click());
        expect(propose).toHaveBeenCalledExactlyOnceWith("Use concise replies.");
        expect(onProposals).toHaveBeenCalledWith([proposal]);
        expect(container.querySelector("textarea")?.value).toBe("");
        expect(api.memoryWrite).not.toHaveBeenCalled();
        expect(api.createGrant).not.toHaveBeenCalled();
      },
    );
  });
  it.each([
    ["This bot may only run locally — change the pin or the space policy", true],
    [
      "Memory review is not available with Claude Code or Codex yet; import memory or edit a document directly.",
      true,
    ],
    ["private provider failure", false],
  ])("shows only a recognized review refusal: %s", async (message, recognized) => {
    const propose = vi.fn().mockRejectedValue(new Error(message as string));
    await mounted(<MemoryComposer propose={propose} onProposals={vi.fn()} />, async (container) => {
      await act(async () => input(container.querySelector("textarea")!, "Use short answers."));
      await act(async () => button(container, "Send").click());
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        recognized ? message : "Could not request memory changes. Try again.",
      );
      expect(container.querySelector("textarea")?.value).toBe("Use short answers.");
    });
  });
});

describe("memory generation consent", () => {
  const settings: SpaceLearningConfig = {
    enabled: true,
    consolidationEnabled: true,
    insightsEnabled: true,
    canConfigure: true,
    reviewerPin: null,
    destination: null,
    budgets: {
      botDailyTokens: 30000,
      spaceDailyTokens: 150000,
      maxProposals: 3,
      timeoutMs: 30000,
      maxOutputTokens: 2000,
      maxOutputChars: 12000,
    },
  };
  it("changes generation through existing consent settings while preserving adjacent configuration", async () => {
    const updated = { ...settings, enabled: false };
    api.configure.mockResolvedValue(updated);
    const onChange = vi.fn();
    await mounted(
      <MemoryGeneration settings={settings} onChange={onChange} />,
      async (container) => {
        await act(async () =>
          (container.querySelector('[role="switch"]') as HTMLButtonElement).click(),
        );
        expect(api.configure).toHaveBeenCalledExactlyOnceWith(
          {
            enabled: false,
            consolidationEnabled: true,
            reviewerPin: null,
            budgets: settings.budgets,
          },
          { context: { spaceId: "selected-space" } },
        );
        expect(onChange).toHaveBeenCalledWith(updated);
        expect(api.createGrant).not.toHaveBeenCalled();
      },
    );
  });
  it("keeps the switch read-only for other space members", async () => {
    await mounted(
      <MemoryGeneration settings={{ ...settings, canConfigure: false }} onChange={vi.fn()} />,
      async (container) => {
        const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
        expect(toggle.disabled).toBe(true);
        await act(async () => toggle.click());
        expect(api.configure).not.toHaveBeenCalled();
      },
    );
  });
});

describe("inline memory suggestions", () => {
  it("makes removals explicit and opens the diff before approval", async () => {
    await mounted(
      <MemoryProposals
        proposals={[
          {
            ...proposal,
            operation: "memory-edit",
            memoryAction: "delete",
            proposedContent: "",
            diff: "-Use concise replies.",
          },
        ]}
        onChange={vi.fn()}
      />,
      async (container) => {
        expect(container.textContent).toContain("Remove memory");
        expect(container.textContent).toContain("-Use concise replies.");
        expect(container.querySelector("details")?.open).toBe(true);
        expect(api.approve).not.toHaveBeenCalled();
        expect(api.memoryWrite).not.toHaveBeenCalled();
      },
    );
  });
  it("does not apply pending proposals until the human chooses Approve", async () => {
    api.approve.mockResolvedValue({ proposal: { ...proposal, status: "applied" } });
    const onChange = vi.fn();
    await mounted(
      <MemoryProposals proposals={[proposal]} onChange={onChange} />,
      async (container) => {
        expect(container.textContent).toContain(proposal.proposedContent);
        expect(api.approve).not.toHaveBeenCalled();
        await act(async () => button(container, "Approve").click());
        expect(api.approve).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal.id });
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }));
        expect(api.memoryWrite).not.toHaveBeenCalled();
        expect(api.createGrant).not.toHaveBeenCalled();
      },
    );
  });

  it("routes Undo through the existing revert service and surfaces conflicts without writes", async () => {
    api.revert.mockResolvedValue({
      proposal,
      conflict: { before: "before", applied: "applied", current: "current", expectedRevision: 3 },
    });
    await mounted(
      <MemoryProposals proposals={[{ ...proposal, status: "applied" }]} onChange={vi.fn()} />,
      async (container) => {
        await act(async () => button(container, "Undo").click());
        expect(api.revert).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal.id });
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "The memory changed since this suggestion.",
        );
        expect(api.memoryWrite).not.toHaveBeenCalled();
      },
    );
  });

  it("never approves a policy change returned to the memory page", async () => {
    await mounted(
      <MemoryProposals
        proposals={[{ ...proposal, type: "policy-suggestion" }]}
        onChange={vi.fn()}
      />,
      async (container) => {
        expect(container.textContent).toContain("This suggestion cannot be approved here.");
        expect(container.querySelector("button")).toBeNull();
        expect(api.approve).not.toHaveBeenCalled();
      },
    );
  });
});

describe("memory page data", () => {
  const settings: SpaceLearningConfig = {
    enabled: true,
    consolidationEnabled: false,
    insightsEnabled: true,
    canConfigure: false,
    reviewerPin: null,
    destination: null,
    budgets: {
      botDailyTokens: 30000,
      spaceDailyTokens: 150000,
      maxProposals: 3,
      timeoutMs: 30000,
      maxOutputTokens: 2000,
      maxOutputChars: 12000,
    },
  };
  it("reopens pending memory proposals without approving them", async () => {
    api.settings.mockResolvedValue(settings);
    api.list.mockResolvedValue({ items: [], nextCursor: null });
    api.inbox.mockResolvedValueOnce({
      proposals: [proposal, { ...proposal, id: "policy", type: "policy-suggestion" }],
    });
    await mounted(
      <MemoryPage proposeImport={vi.fn()} proposeEdit={vi.fn()} />,
      async (container) => {
        expect(api.inbox).toHaveBeenCalledWith({}, { context: { spaceId: "selected-space" } });
        expect(button(container, "Approve")).toBeDefined();
        expect(container.textContent).toContain(proposal.proposedContent);
        expect(api.approve).not.toHaveBeenCalled();
        expect(api.memoryWrite).not.toHaveBeenCalled();
      },
    );
  });
  it("loads personal documents and paginates within the selected space", async () => {
    api.settings.mockResolvedValue(settings);
    api.list
      .mockResolvedValueOnce({ items: [], nextCursor: "next-page" })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    await mounted(
      <MemoryPage proposeImport={vi.fn()} proposeEdit={vi.fn()} />,
      async (container) => {
        expect(api.list).toHaveBeenCalledWith(
          { scope: "user" },
          { context: { spaceId: "selected-space" } },
        );
        expect(api.settings).toHaveBeenCalledWith(undefined, {
          context: { spaceId: "selected-space" },
        });
        expect(container.textContent).toContain("No profile or preferences saved.");
        await act(async () => button(container, "More memory").click());
        expect(api.list).toHaveBeenLastCalledWith(
          { scope: "user", cursor: "next-page" },
          { context: { spaceId: "selected-space" } },
        );
        expect(container.textContent).not.toContain("More memory");
        expect(api.memoryWrite).not.toHaveBeenCalled();
        expect(api.approve).not.toHaveBeenCalled();
      },
    );
  });

  it("offers a retry without exposing internal errors", async () => {
    api.settings.mockResolvedValue(settings);
    api.list
      .mockRejectedValueOnce(new Error("internal fixture failure"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    await mounted(
      <MemoryPage proposeImport={vi.fn()} proposeEdit={vi.fn()} />,
      async (container) => {
        expect(container.textContent).toContain("Could not load memory.");
        expect(container.textContent).not.toContain("internal fixture");
        await act(async () => button(container, "Retry").click());
        expect(container.textContent).toContain("No topics saved.");
        expect(container.querySelector('[role="alert"]')).toBeNull();
      },
    );
  });
});
