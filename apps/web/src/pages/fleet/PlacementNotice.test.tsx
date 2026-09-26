// @vitest-environment jsdom
import type { Run } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PlacementNotice } from "./PlacementNotice";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));

const run = (
  placement: Partial<NonNullable<Run["placement"]>>,
): Pick<Run, "status" | "placement"> => ({
  status: "waiting_input",
  placement: {
    targetId: "target",
    connectionId: null,
    reason: "it had the most free memory",
    fromTargetId: "from",
    decidedAt: new Date().toISOString(),
    status: "pending",
    ...placement,
  } as Run["placement"],
});

async function render(props: Parameters<typeof PlacementNotice>[0]) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<PlacementNotice {...props} />));
  return { node, unmount: async () => act(async () => root.unmount()) };
}

it("names a Docker move by Fleet's own translated label, even without a server hostLabel", async () => {
  // A Docker computer on a Mac with This Mac off moves back to local Docker automatically; the
  // thread snapshot may not carry hostLabel, but targetBuiltin still names it correctly.
  const { node, unmount } = await render({
    run: run({ targetBuiltin: "local-docker", targetName: "local-docker" }),
    hostLabel: "This Mac",
    onOpen: () => {},
  });
  expect(node.textContent).toContain("Docker on this Mac");
  expect(node.textContent).not.toContain("local-docker");
  await unmount();
  node.remove();
});

it("falls back to the server's target name when there is no built-in kind", async () => {
  const { node, unmount } = await render({
    run: run({ targetName: "office-mac-studio" }),
    hostLabel: "This Mac",
    onOpen: () => {},
  });
  expect(node.textContent).toContain("office-mac-studio");
  await unmount();
  node.remove();
});

it("renders nothing once the run is no longer waiting on the pending move", async () => {
  const { node, unmount } = await render({
    run: { status: "queued", placement: null },
    onOpen: () => {},
  });
  expect(node.textContent).toBe("");
  await unmount();
  node.remove();
});
