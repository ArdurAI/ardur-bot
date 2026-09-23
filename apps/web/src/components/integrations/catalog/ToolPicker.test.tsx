// @vitest-environment jsdom
import type {
  IntegrationDescriptor,
  IntegrationManifest,
  SpaceToolPolicies,
} from "@ardurbot/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPicker } from "./ToolPicker";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

const descriptor: IntegrationDescriptor = {
  id: "synthetic",
  name: "Synthetic",
  vendor: "synthetic",
  available: true,
  transport: "remote-http",
  authKind: "oauth",
  requiredInputs: [],
  docsUrl: "https://example.test/docs",
  verifiedAt: "2026-09-23",
  serverVersion: null,
  placement: "backend",
  riskClass: "collaboration",
  defaultAllowedTools: [],
  toolPolicies: {},
};
const manifest: IntegrationManifest = {
  capturedAt: "2026-09-23T00:00:00.000Z",
  serverVersion: null,
  account: null,
  tools: [
    { id: "synthetic_read", description: "Read an item", inputSchemaDigest: "a".repeat(64) },
    { id: "synthetic_write", description: "Write an item", inputSchemaDigest: "b".repeat(64) },
    {
      id: "synthetic_get_and_delete",
      description: "Read and delete",
      inputSchemaDigest: "c".repeat(64),
    },
  ],
};
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
  vi.unstubAllGlobals();
});
const readToggle = () =>
  container.querySelector<HTMLButtonElement>('[aria-label="Approval for synthetic_read"]')!;

describe("ToolPicker read approval controls", () => {
  it("defaults reads to Ask first, toggles both ways, and never offers Allow for writes", async () => {
    const changed = vi.fn();
    function Picker() {
      const [policies, setPolicies] = useState<SpaceToolPolicies>({});
      return (
        <ToolPicker
          manifest={manifest}
          descriptor={descriptor}
          selected={manifest.tools.map((tool) => tool.id)}
          onChange={() => {}}
          spaceToolPolicies={policies}
          onPolicyChange={(value) => {
            changed(value);
            setPolicies(value);
          }}
        />
      );
    }
    await act(async () => root.render(<Picker />));
    expect(readToggle().textContent).toBe("Ask first");
    expect(readToggle().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll('[aria-label^="Approval for"]')).toHaveLength(1);
    expect(container.textContent?.match(/asks first/g)).toHaveLength(2);
    expect(container.textContent).toContain(
      "Reads can run without asking once you allow them. Writes always ask.",
    );
    await act(async () => readToggle().click());
    expect(changed).toHaveBeenLastCalledWith({ synthetic_read: "allow" });
    expect(readToggle().textContent).toBe("Allow");
    expect(readToggle().getAttribute("aria-pressed")).toBe("true");
    await act(async () => readToggle().click());
    expect(changed).toHaveBeenLastCalledWith({ synthetic_read: "ask-first" });
  });
  it.each(["unselected", "busy", "disabled", "reviewed"])(
    "disables the toggle for %s tools and shows the effective policy",
    async (reason) => {
      const changed = vi.fn();
      const toolPolicies: IntegrationDescriptor["toolPolicies"] =
        reason === "reviewed"
          ? { synthetic_read: { approval: "allow", risk: "reviewed-read" } }
          : reason === "disabled"
            ? { synthetic_read: { approval: "disabled", risk: "unknown" } }
            : {};
      await act(async () =>
        root.render(
          <ToolPicker
            manifest={manifest}
            descriptor={{ ...descriptor, toolPolicies }}
            selected={reason === "unselected" ? [] : ["synthetic_read"]}
            onChange={() => {}}
            disabled={reason === "busy"}
            spaceToolPolicies={{ synthetic_read: "ask-first" }}
            onPolicyChange={changed}
          />,
        ),
      );
      expect(readToggle().disabled).toBe(true);
      expect(readToggle().textContent).toBe(reason === "reviewed" ? "Allow" : "Ask first");
      await act(async () => readToggle().click());
      expect(changed).not.toHaveBeenCalled();
    },
  );
  it("keeps custom MCP grant selection separate from trusted catalog policies", async () => {
    const changed = vi.fn();
    await act(async () =>
      root.render(<ToolPicker manifest={manifest} selected={[]} onChange={changed} />),
    );
    expect(container.querySelectorAll('[aria-label^="Approval for"]')).toHaveLength(0);
    const read = container.querySelector<HTMLButtonElement>(
      '[role="checkbox"][aria-label="synthetic_read"]',
    )!;
    await act(async () => read.click());
    expect(changed).toHaveBeenCalledWith(["synthetic_read"]);
    expect(container.textContent).not.toContain("Reads can run without asking");
  });
});
