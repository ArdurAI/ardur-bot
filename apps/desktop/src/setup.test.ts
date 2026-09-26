// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(path.join(import.meta.dirname, "setup.html"), "utf8");
const script = readFileSync(path.join(import.meta.dirname, "setup.js"), "utf8");
const localUrl = "http://127.0.0.1:40123";

type Stack = {
  phase: string;
  message: string | null;
  output: string[];
  layerBytes: Record<string, number>;
  imageTag: string;
  offerReset?: boolean;
};

/** Each controller's state shape, and a phase it reports while it is still starting. */
const modes = {
  "local mode": {
    starting: "migrations",
    stack: (phase: string): Stack => ({
      phase,
      message: null,
      output: [],
      layerBytes: {},
      imageTag: "",
    }),
  },
  "legacy Compose": {
    starting: "waiting-healthy",
    stack: (phase: string): Stack => ({
      phase,
      message: null,
      output: ["web-1 | listening"],
      layerBytes: { a235d761c5d1: 412_300_000 },
      imageTag: "v9.9.9",
    }),
  },
};

afterEach(() => {
  delete (window as { ardurbotSetup?: unknown }).ardurbotSetup;
  document.documentElement.innerHTML = "";
});

/** The setup window's real markup and script, with the preload bridge faked. */
function openSetup(input: { stack: Stack; resume?: boolean }) {
  let current = input.stack;
  const listeners: ((state: Stack) => void)[] = [];
  const bridge = {
    platform: "linux",
    state: vi.fn(async () => ({
      defaultLocalUrl: localUrl,
      saved: { mode: "new", serverUrl: localUrl },
      resume: input.resume ?? false,
    })),
    test: vi.fn(),
    save: vi.fn(async () => ({ ok: true })),
    quit: vi.fn(),
    openLink: vi.fn(),
    stack: {
      state: vi.fn(async () => current),
      start: vi.fn(async () => current),
      reset: vi.fn(async () => true),
      onChange: (listener: (state: Stack) => void) => {
        listeners.push(listener);
      },
    },
  };
  (window as { ardurbotSetup?: unknown }).ardurbotSetup = bridge;
  document.documentElement.innerHTML = html.slice(html.indexOf("<head>"), html.indexOf("<script"));
  new Function(script)();
  return {
    bridge,
    push(next: Stack) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    text: (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? "",
    continueButton: () => document.getElementById("continue") as HTMLButtonElement,
  };
}

function settle(ms = 300) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.each(Object.entries(modes))("setup window with %s", (_name, { starting, stack }) => {
  it("opened from the menu while the stack is ready, shows the choice and saves nothing until Continue", async () => {
    const setup = openSetup({ stack: stack("ready") });
    await vi.waitFor(() => expect(setup.text("#stack-phase")).toBe("Ardur Bot is ready."));
    await settle();
    expect((document.getElementById("mode-new") as HTMLInputElement).checked).toBe(true);
    expect(setup.bridge.save).not.toHaveBeenCalled();

    setup.continueButton().click();
    await vi.waitFor(() =>
      expect(setup.bridge.save).toHaveBeenCalledExactlyOnceWith({
        mode: "new",
        serverUrl: localUrl,
      }),
    );
  });

  it("opened from the menu while the stack starts, does not save when it becomes ready", async () => {
    const setup = openSetup({ stack: stack(starting) });
    await vi.waitFor(() => expect(setup.bridge.stack.state).toHaveBeenCalled());
    setup.push(stack("ready"));
    await vi.waitFor(() => expect(setup.text("#stack-phase")).toBe("Ardur Bot is ready."));
    await settle();
    expect(setup.bridge.save).not.toHaveBeenCalled();
  });

  it("brings back a saved local instance at launch once it is ready", async () => {
    const setup = openSetup({ stack: stack(starting), resume: true });
    await vi.waitFor(() => expect(setup.bridge.stack.state).toHaveBeenCalled());
    setup.push(stack("ready"));
    await vi.waitFor(() =>
      expect(setup.bridge.save).toHaveBeenCalledExactlyOnceWith({
        mode: "new",
        serverUrl: localUrl,
      }),
    );
  });

  it("does not save after the person moves to Existing instance and back", async () => {
    const setup = openSetup({ stack: stack(starting), resume: true });
    await vi.waitFor(() => expect(setup.bridge.stack.state).toHaveBeenCalled());
    for (const id of ["mode-existing", "mode-new"]) {
      (document.getElementById(id) as HTMLInputElement).click();
    }
    setup.push(stack("ready"));
    await vi.waitFor(() => expect(setup.text("#stack-phase")).toBe("Ardur Bot is ready."));
    await settle();
    expect(setup.bridge.save).not.toHaveBeenCalled();
  });
});

it("offers Reset local data only for a failure that needs it, then starts fresh", async () => {
  const failed = (offerReset: boolean): Stack => ({
    ...modes["local mode"].stack("failed"),
    message: offerReset ? "The app's database settings are missing." : "The API stopped.",
    ...(offerReset ? { offerReset } : {}),
  });
  const setup = openSetup({ stack: failed(false) });
  const reset = () => document.getElementById("reset") as HTMLButtonElement;
  await vi.waitFor(() => expect(setup.text("#stack-phase")).toBe("The API stopped."));
  expect(reset().hidden).toBe(true);

  setup.push(failed(true));
  await vi.waitFor(() => expect(reset().hidden).toBe(false));
  expect(reset().textContent?.trim()).toBe("Reset local data");
  expect(setup.continueButton().textContent).toBe("Retry");
  for (const [id, hidden] of [
    ["mode-existing", true],
    ["mode-new", false],
  ] as const) {
    (document.getElementById(id) as HTMLInputElement).click();
    expect(reset().hidden).toBe(hidden);
  }
  setup.bridge.stack.reset.mockResolvedValueOnce(false);
  reset().click();
  await vi.waitFor(() => expect(setup.bridge.stack.reset).toHaveBeenCalledOnce());
  await settle();
  expect(setup.bridge.stack.start).not.toHaveBeenCalled();

  // A file in use: nothing moved, and the window says what to do.
  const inUse = "A local data file is in use; close whatever is using it and try again.";
  setup.bridge.stack.reset.mockResolvedValueOnce(inUse as never);
  reset().click();
  await vi.waitFor(() => expect(setup.text("#status")).toBe(inUse));
  expect(setup.bridge.stack.start).not.toHaveBeenCalled();
  expect(reset().disabled).toBe(false);

  reset().click();
  await vi.waitFor(() => expect(setup.bridge.stack.start).toHaveBeenCalledOnce());
  setup.push(modes["local mode"].stack("database"));
  await vi.waitFor(() => expect(reset().hidden).toBe(true));
});

it("keeps This computer free of standing explanation; a start says what it is doing", async () => {
  const setup = openSetup({ stack: modes["local mode"].stack("idle") });
  await vi.waitFor(() => expect(setup.bridge.stack.state).toHaveBeenCalled());
  const panel = document.getElementById("panel-new")!;
  const standing = [...panel.children].filter((child) => child.id !== "stack");
  expect(standing.map((child) => child.textContent?.trim())).toEqual([]);
  setup.push(modes["local mode"].stack("database"));
  await vi.waitFor(() => expect(setup.text("#stack-phase")).toBe("Starting the database."));
});
