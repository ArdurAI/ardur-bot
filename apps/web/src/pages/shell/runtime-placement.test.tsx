// @vitest-environment jsdom
import type { ComputerStatus } from "@ardurbot/contracts";
import { RuntimeKindSchema, runtimeSupportsLocation } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  configure: vi.fn(async () => ({})),
  engine: vi.fn(async () => ({ name: "docker" })),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { computer: api } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const button = (props: ComponentProps<"button">) => <button {...props} />;
  return {
    Button: button,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: box,
    AlertDialogHeader: box,
    AlertDialogTitle: box,
    AlertDialogDescription: box,
    AlertDialogFooter: box,
    AlertDialogCancel: button,
    AlertDialogAction: button,
  };
});

import { ComputerProfile } from "../ComputerProfilesSettings";
import { RuntimeSummary } from "./runtime-summary";

const status = {
  botId: "bot",
  kind: "desktop",
  connectionId: "docker",
  mode: "team",
  state: "stopped",
  imageProfile: "base",
} as ComputerStatus;
const connections = (["docker", "podman", "kubernetes", "ssh"] as const).map((engine) => ({
  id: engine,
  name: engine,
  settings: { engine } as never,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it.each(RuntimeKindSchema.options)(
  "%s location choices are derived from the contracts table",
  async (runtimeKind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ComputerProfile
            choicesOnly
            botId="bot"
            name="Builder"
            status={status}
            connections={connections}
            runtimeKind={runtimeKind}
            hostConnected
            deploymentDefault="docker"
            onChanged={async () => {}}
          />,
        ),
      );
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
      const values = [...select.options].map((option) => option.value);
      expect(values).toContain("host-computer");
      for (const connection of connections.filter((entry) => entry.id !== status.connectionId))
        expect(values.includes(connection.id)).toBe(
          runtimeSupportsLocation(runtimeKind, {
            kind: "desktop",
            connectionId: connection.id,
            connectionSettings: connection.settings,
          }),
        );
      expect(values.includes("deployment-default")).toBe(
        runtimeSupportsLocation(runtimeKind, { kind: "docker" }),
      );
      expect(api.configure).not.toHaveBeenCalled();
      if (runtimeKind !== "pi")
        expect(container.textContent).toContain("Other locations are unavailable");
      await act(async () => {
        select.value = "host-computer";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.textContent).toContain(
        "Runs as you; can use your files and signed-in tools",
      );
      const button = (text: string) =>
        [...container.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
      await act(async () => button("Apply").click());
      expect(api.configure).not.toHaveBeenCalled();
      await act(async () => button("Continue").click());
      expect(api.configure).toHaveBeenCalledExactlyOnceWith({
        botId: "bot",
        destination: "host",
        confirmed: true,
      });
    } finally {
      await act(async () => root.unmount());
    }
  },
);
it("does not offer the host when disconnected, or submit an unsupported current location", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ComputerProfile
          choicesOnly
          botId="bot"
          name="Builder"
          status={status}
          connections={connections}
          runtimeKind="hermes"
          hostConnected={false}
          onChanged={async () => {}}
        />,
      ),
    );
    expect([...container.querySelectorAll("option")].map((entry) => entry.value)).toEqual([
      "docker",
    ]);
    expect(container.textContent).toContain("Connect the host service to choose This computer.");
    expect(
      [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Apply")
        ?.disabled,
    ).toBe(true);
    expect(api.configure).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
it.each(["docker", "podman", "kubernetes", "ssh"] as const)(
  "the Team card uses the %s connection, not the legacy desktop kind",
  async (engine) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RuntimeSummary
            status={status}
            locationName="Saved connection"
            connectionSettings={{ engine }}
          />,
        ),
      );
      expect(container.textContent).toContain(engine === "ssh" ? "Remote computer" : "Container");
      expect(container.textContent).toContain("Saved connection");
      expect(container.textContent).not.toContain("This computer");
      expect(container.textContent).not.toContain("Runs as you");
    } finally {
      await act(async () => root.unmount());
    }
  },
);
