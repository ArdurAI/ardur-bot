// @vitest-environment jsdom

import type { RuntimeAvailability } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  availability: vi.fn(),
  installHermes: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { runtimes: { availability: api.availability, installHermes: api.installHermes } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: () => null,
}));

import { RuntimeSettings } from "./runtime-settings";

function hermes(
  install?: RuntimeAvailability["install"],
  reason = "Hermes is not installed on this computer.",
): RuntimeAvailability {
  const available = install?.state === "ready";
  return {
    runtimeKind: "hermes",
    available,
    models: [],
    ...(available ? {} : { reason }),
    ...(install ? { install } : {}),
  };
}

describe("Install Hermes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.availability.mockReset();
    api.installHermes.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function renderHermes() {
    await act(async () => {
      root.render(
        <RuntimeSettings
          kind="hermes"
          onKind={vi.fn()}
          modelKey=""
          onModel={vi.fn()}
          effort=""
          onEffort={vi.fn()}
          experimental
          onExperimental={vi.fn()}
        />,
      );
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  }

  it("shows Install Hermes when this computer can install it", async () => {
    api.availability.mockResolvedValue(hermes({ state: "absent" }));
    await renderHermes();
    const install = button("Install Hermes");
    expect(install).toBeTruthy();
    expect(install?.getAttribute("type")).toBe("button");
    install?.focus();
    expect(document.activeElement).toBe(install);
    expect(container.textContent).toContain(
      "Downloads Hermes 0.21.0 from GitHub and about 200 MB of Python packages.",
    );
    expect(container.textContent).toContain("Hermes is not installed on this computer.");
  });

  it("keeps the install button off a paired computer that only reports the reason", async () => {
    api.availability.mockResolvedValue(
      hermes(undefined, "Hermes is not installed on this computer."),
    );
    await renderHermes();
    expect(container.textContent).toContain("Hermes is not installed on this computer.");
    expect(button("Install Hermes")).toBeUndefined();
    expect(button("Try again")).toBeUndefined();
  });

  it("offers Install Hermes when the managed install fails its safety check", async () => {
    api.availability.mockResolvedValue(
      hermes({ state: "absent" }, "The Hermes install on this computer failed its safety check."),
    );
    await renderHermes();
    expect(container.textContent).toContain(
      "The Hermes install on this computer failed its safety check.",
    );
    expect(button("Install Hermes")).toBeTruthy();
  });

  it("keeps the button off an operator's own install that fails its safety check", async () => {
    api.availability.mockResolvedValue(
      hermes(undefined, "The Hermes install on this computer failed its safety check."),
    );
    await renderHermes();
    expect(container.textContent).toContain(
      "The Hermes install on this computer failed its safety check.",
    );
    expect(button("Install Hermes")).toBeUndefined();
    expect(button("Try again")).toBeUndefined();
  });

  it("shows the install phase in plain words", async () => {
    api.availability.mockResolvedValue(hermes({ state: "installing", phase: "checking" }));
    await renderHermes();
    const status = container.querySelector("[role='status'][aria-live='polite']");
    expect(status?.textContent).toBe("Checking the download");
    expect(container.textContent).not.toContain("Hermes is not installed on this computer.");
    expect(button("Install Hermes")).toBeUndefined();
  });

  it("shows progress after Install Hermes and polls through to ready", async () => {
    api.installHermes.mockResolvedValue({ ok: true });
    api.availability
      .mockResolvedValueOnce(hermes({ state: "absent" }))
      .mockResolvedValueOnce(hermes({ state: "installing", phase: "packages" }))
      .mockResolvedValueOnce(hermes({ state: "installing", phase: "finishing" }))
      .mockResolvedValue(hermes({ state: "ready" }));
    vi.useFakeTimers();
    await renderHermes();
    expect(button("Install Hermes")).toBeTruthy();
    await act(async () => {
      button("Install Hermes")?.click();
    });
    expect(api.installHermes).toHaveBeenCalledExactlyOnceWith({});
    expect(container.textContent).toContain("Installing packages");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.textContent).toContain("Finishing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.textContent).toContain("Ready. The bot can use Hermes.");
    expect(button("Install Hermes")).toBeUndefined();
    expect(button("Try again")).toBeUndefined();
  });

  it("stops waiting when no install status appears within ninety seconds", async () => {
    api.installHermes.mockResolvedValue({ ok: true });
    api.availability.mockResolvedValue(hermes({ state: "absent" }));
    vi.useFakeTimers();
    await renderHermes();
    await act(async () => {
      button("Install Hermes")?.click();
    });
    expect(api.installHermes).toHaveBeenCalledExactlyOnceWith({});
    expect(container.textContent).toContain("Downloading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(89_000);
    });
    expect(container.textContent).toContain("Downloading");
    expect(button("Try again")).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toBe("Couldn't install Hermes. Try again.");
    expect(container.textContent).not.toContain("Downloading");
    const retry = button("Try again");
    expect(retry?.getAttribute("aria-describedby")).toBe(alert?.id);
  });

  it("announces a failure and retries from the linked button", async () => {
    api.installHermes
      .mockRejectedValueOnce(new Error("ECONNREFUSED secret-token"))
      .mockResolvedValueOnce({ ok: true });
    api.availability
      .mockResolvedValueOnce(hermes({ state: "absent" }))
      .mockResolvedValueOnce(hermes({ state: "absent" }))
      .mockResolvedValue(hermes({ state: "ready" }));
    await renderHermes();
    await act(async () => {
      button("Install Hermes")?.click();
    });
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toBe("Couldn't install Hermes. Try again.");
    expect(container.textContent).not.toContain("secret-token");
    expect(container.textContent).not.toContain("ECONNREFUSED");
    const retry = button("Try again");
    expect(retry?.getAttribute("aria-describedby")).toBe(alert?.id);
    expect(retry?.getAttribute("aria-errormessage")).toBe(alert?.id);
    expect(retry?.getAttribute("aria-invalid")).toBe("true");
    retry?.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => {
      retry?.click();
    });
    expect(api.installHermes).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Ready. The bot can use Hermes.");
  });
});
