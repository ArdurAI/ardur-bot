import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import type { Page } from "@playwright/test";

const createdAt = "2026-09-23T00:00:00.000Z";
export const bots = ["A", "B"].map((name, index) => ({
  id: `fixture-bot-${index}`,
  spaceId: "fixture-space",
  name: `Fixture ${name}`,
  title: "",
  description: "",
  instructions: "",
  color: "gray",
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: "isolated",
  threadId: `fixture-thread-${index}`,
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: createdAt,
  createdAt,
  voiceId: null,
  autoSpeak: false,
  modelProvider: "openai-compatible",
  modelId: "fixture-model",
  thinkingLevel: null,
  runtimeKind: "pi",
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
}));
export const me = {
  userId: "fixture-user",
  email: "fixture@example.invalid",
  name: "Fixture",
  spaceId: "fixture-space",
  isDeploymentOwner: true,
  needsModel: false,
  defaultProvider: "openai-compatible",
  defaultModel: "fixture-model",
  computerHost: "docker",
  canChooseHostComputer: false,
  sandboxProvider: "fake",
  avatarStyle: "robot",
};
export const tokenEvent = {
  id: "fixture-token",
  spaceId: "fixture-space",
  threadId: "fixture-thread-0",
  botId: bots[0]!.id,
  runId: "fixture-run",
  seq: 101,
  type: "thread.progress",
  createdAt,
  payload: { text: "First fixture token" },
};
export async function installPerformanceFixture(page: Page, trace = false, manualTrace = false) {
  let sent = false;
  const snapshot = (index: number) => ({
    botId: bots[index]!.id,
    threadId: bots[index]!.threadId,
    cursor: sent && index === 0 ? 101 : 100,
    olderCursor: null,
    run: null,
    messages: [
      ...Array.from({ length: 100 }, (_, seq) => ({
        id: `fixture-message-${index}-${seq}`,
        threadId: bots[index]!.threadId,
        seq,
        role: "bot",
        blocks: [{ kind: "text", text: `Fixture message ${seq}` }],
        createdAt,
      })),
      ...(sent && index === 0
        ? [
            {
              id: "progress:fixture-run",
              threadId: bots[0]!.threadId,
              seq: 101,
              role: "bot",
              runId: "fixture-run",
              blocks: [{ kind: "progress", text: "First fixture token" }],
              createdAt,
            },
          ]
        : []),
    ],
  });
  const spaces = [
    {
      id: "fixture-space",
      name: "Fixture space",
      isDefault: true,
      hasContent: true,
      bots,
      groups: [],
      externalConversations: [],
      botSections: [],
    },
  ];
  await page.addInitScript(
    ({ tokenEvent, trace, manualTrace }) => {
      const original = window.fetch.bind(window);
      const observeToken = () => {
        const observer = new MutationObserver(() => {
          if (
            document
              .querySelector('[data-message-id="progress:fixture-run"]')
              ?.textContent?.includes("First fixture token")
          ) {
            performance.mark("perf:first-token");
            observer.disconnect();
          }
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      };
      document.addEventListener("DOMContentLoaded", observeToken, { once: true });
      const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
      const encoder = new TextEncoder();
      if (manualTrace)
        window.addEventListener("fixture:product-event", (event) => {
          const productEvent = (event as CustomEvent).detail;
          for (const stream of streams)
            stream.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify({ json: productEvent })}\n\n`),
            );
        });
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/rpc/threads/subscribe") {
          let current: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              current = controller;
              streams.add(controller);
            },
            cancel() {
              streams.delete(current);
            },
          });
          request.signal.addEventListener(
            "abort",
            () => {
              streams.delete(current);
              try {
                current.close();
              } catch {
                /* Already cancelled. */
              }
            },
            { once: true },
          );
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        const response = await original(request);
        if (new URL(request.url).pathname === "/rpc/threads/send") {
          for (const stream of streams)
            stream.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify({ json: tokenEvent })}\n\n`),
            );
          if (trace && !manualTrace)
            setTimeout(() => {
              for (const stream of streams) {
                for (const event of [
                  {
                    ...tokenEvent,
                    seq: 102,
                    id: "fixture-final",
                    type: "thread.message.created",
                    payload: {
                      messageId: "fixture-final",
                      role: "bot",
                      blocks: [{ kind: "text", text: "First fixture token" }],
                    },
                  },
                  {
                    ...tokenEvent,
                    seq: 103,
                    id: "fixture-terminal",
                    type: "run.completed",
                    payload: {},
                  },
                ])
                  stream.enqueue(
                    encoder.encode(`event: message\ndata: ${JSON.stringify({ json: event })}\n\n`),
                  );
              }
            }, 150);
        }
        return response;
      };
      // Timestamp the actual composer submit event, before its RPC starts.
      document.addEventListener("submit", () => performance.mark("perf:submit"), true);
      document.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            event.target instanceof HTMLTextAreaElement
          )
            performance.mark("perf:submit");
        },
        true,
      );
    },
    {
      tokenEvent: trace
        ? { ...tokenEvent, payload: { ...tokenEvent.payload, streaming: true } }
        : tokenEvent,
      trace,
      manualTrace,
    },
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: {
        user: {
          id: me.userId,
          email: me.email,
          name: me.name,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        },
        session: {
          id: "fixture-session",
          userId: me.userId,
          expiresAt: "2099-01-01T00:00:00.000Z",
          createdAt,
          updatedAt: createdAt,
        },
      },
    }),
  );
  await page.route("**/rpc/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const input =
      request.postDataJSON()?.json ?? JSON.parse(url.searchParams.get("data") ?? "{}").json ?? {};
    const index = input.botId === bots[1]!.id ? 1 : 0;
    const name = url.pathname.slice(5);
    let result: unknown = [];
    if (name === "bootstrap")
      result = {
        me,
        bots,
        groups: [],
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        thread: snapshot(index),
        routines: [],
        spaces,
      };
    else if (name === "me") result = me;
    else if (name === "spaces/list") result = { current: { ...spaces[0], bots }, spaces };
    else if (name === "threads/get") result = snapshot(index);
    else if (name === "threads/head")
      result = { threadId: bots[index]!.threadId, cursor: sent ? 101 : 100 };
    else if (name === "threads/send") {
      sent = true;
      result = { runId: "fixture-run", taskId: "fixture-task", seq: 101 };
    } else if (name === "voice/status") result = { ready: false };
    else if (name === "agentSkills/list") result = [];
    else if (name === "memory/list") result = [];
    else if (name === "runtimes/availability") result = [];
    else if (name === "delegations/policy") result = { mode: "any" };
    else if (name === "preferences/get") result = DEFAULT_USER_PREFERENCES;
    await route.fulfill({ json: { json: result } });
  });
}
