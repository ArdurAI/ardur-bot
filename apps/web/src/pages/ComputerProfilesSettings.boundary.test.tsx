// @vitest-environment jsdom

import { createRequire } from "node:module";
import path from "node:path";
import type { Actor } from "@ardurbot/contracts";
import { moveOntoThisMacUnavailableMessage } from "@ardurbot/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  configure: vi.fn(async (_input: unknown) => ({}) as unknown),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    computer: {
      engine: vi.fn(async () => ({ name: "ssh", rootless: false })),
      configure: (input: unknown) => boundary.configure(input),
    },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = (props: ComponentProps<"button">) => <button {...props} />;
  return {
    Button,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    AlertDialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogCancel: Button,
    AlertDialogAction: Button,
  };
});

import { ComputerProfile } from "./ComputerProfilesSettings";

const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const { RPCHandler } = apiRequire("@orpc/server/fetch") as {
  RPCHandler: new (
    router: unknown,
    options?: { clientInterceptors?: unknown[] },
  ) => {
    handle: (
      request: Request,
      options: { prefix: string; context: { actor: Actor } },
    ) => Promise<{ matched?: boolean; response?: Response }>;
  };
};
const { onError } = apiRequire("@orpc/server") as {
  onError: (handler: (error: unknown, options: { path: readonly string[] }) => void) => unknown;
};

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  delete window.ardurbotDesktop;
});

it("renders the host refusal from the real RPC handler instead of the generic failure", async () => {
  const { createRouter } = await import(path.join(process.cwd(), "apps/api/src/router.ts"));
  const { logUnexpectedRpcError } = await import(path.join(process.cwd(), "apps/api/src/app.ts"));
  const actor = {
    spaceId: "space",
    userId: "owner",
    email: "owner@example.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer: { id: "computer", connectionId: "office" },
      }),
    },
    deploymentSettings: {
      findUnique: async () => ({ computerHost: "this-mac" }),
    },
  };
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: {
        sandboxProvider: "docker",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        agentRuntime: "scripted",
      },
      hostBridge: { hub: { health: { platform: "linux" } } },
      dataDir: "/tmp/ardurbot-router-test",
    } as never),
    {
      clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
    },
  );
  const client = createORPCClient(
    new RPCLink({
      url: "http://127.0.0.1/rpc",
      fetch: async (request) => {
        const { response } = await handler.handle(request, { prefix: "/rpc", context: { actor } });
        return response ?? new Response(null, { status: 404 });
      },
    }),
  ) as {
    computer: {
      configure: (input: {
        botId: string;
        connectionId: string | null;
        confirmed: boolean;
      }) => Promise<unknown>;
    };
  };
  boundary.configure.mockImplementation((input) => client.computer.configure(input as never));
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const sentence = moveOntoThisMacUnavailableMessage("linux");
  window.ardurbotDesktop = { platform: "linux" } as NonNullable<Window["ardurbotDesktop"]>;
  try {
    await act(async () =>
      root.render(
        <ComputerProfile
          botId="bot"
          name="Builder"
          status={{
            botId: "bot",
            computerId: "computer",
            kind: "ssh",
            imageProfile: "base",
            connectionId: "office",
            mode: "dedicated",
            state: "stopped",
            controlHolder: "none",
            controlBotId: null,
            takeoverRequested: false,
            screenAvailable: false,
            screenWidth: 1280,
            screenHeight: 800,
            homeRevision: "saved",
            busyBotName: null,
            canUpdate: true,
          }}
          connections={[{ id: "office", name: "Office", settings: { engine: "ssh" } as never }]}
          deploymentDefault="this-mac"
          onChanged={async () => {}}
        />,
      ),
    );
    const connection = element.querySelector<HTMLSelectElement>('[aria-label="Connection"]')!;
    await act(async () => {
      connection.value = "";
      connection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const button = (name: string) =>
      [...element.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
    await act(async () => button("Apply").click());
    await act(async () => button("Continue").click());
    expect(element.textContent).toContain(sentence);
    expect(element.textContent).not.toContain(
      "Could not change the computer; stop its bots and try again.",
    );
    await expect(
      client.computer.configure({
        botId: "bot",
        connectionId: null,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: sentence });
  } finally {
    await act(async () => root.unmount());
  }
}, 120_000);
