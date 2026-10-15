import { writeFile } from "node:fs/promises";
import type { DeviceEventWindowEnd, ProductEvent } from "@ardurbot/contracts";
import {
  canonicalDispatchJson,
  DEVICE_EVENT_WINDOW,
  deviceEventEndFrame,
  deviceEventFrame,
  deviceSignedText,
} from "@ardurbot/contracts";

// Synthetic public signing inputs; no credentials or live home records.
const context = {
  instanceId: "fixture-home",
  proof: {
    grantId: "fixture-device",
    nonce: "fixture-nonce-00000000000000000000",
    timestamp: 1790000000000,
  },
};
const requests = [
  {
    operation: "dispatch",
    body: { clientNonce: "fixture-request-0001", botId: "fixture-bot", text: "Reply ✓ 🚀" },
  },
  { operation: "runs/get", body: { runId: "fixture-run" } },
  {
    operation: "events",
    body: { runId: "fixture-run", botId: "fixture-bot", threadId: "fixture-thread", cursor: -1 },
  },
  {
    operation: "events",
    body: {
      runId: "fixture-room-run",
      groupId: "fixture-room",
      threadId: "fixture-room-thread",
      cursor: 12,
    },
  },
  {
    operation: "events",
    body: {
      runId: "fixture-run",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      cursor: 2_147_483_647,
    },
  },
  { operation: "tasks/get", body: { taskId: "fixture-task" } },
  { operation: "runs/list", body: {} },
  { operation: "runs/list", body: { cursor: "fixture-run", limit: 2 } },
  {
    operation: "messages/get",
    body: {
      botId: "fixture-bot",
      threadId: "fixture-thread",
      around: { messageId: "fixture-answer" },
    },
  },
  {
    operation: "messages/get",
    body: { groupId: "fixture-room", threadId: "fixture-thread", before: 12 },
  },
  { operation: "rpc", body: { procedure: "computer/list", input: null } },
  {
    operation: "rpc",
    body: { procedure: "board/snapshot", input: { workspaceId: "fixture-board" } },
  },
  {
    operation: "rpc",
    body: { procedure: "board/show", input: { workspaceId: "fixture-board", id: "work-1" } },
  },
  { operation: "rooms/list", body: {} },
  {
    operation: "rooms/send",
    body: {
      groupId: "fixture-room",
      threadId: "fixture-thread",
      clientNonce: "fixture-room-request-1",
      text: "@Beta @Gamma compare ✓ 🚀",
    },
  },
  {
    operation: "rooms/send",
    body: { roomName: "Fixture room", clientNonce: "fixture-room-request-2", text: "hello" },
  },
  { operation: "stop", body: { taskId: "fixture-task" } },
];
const rejected = ["\ud800", "\udfff"].flatMap((unit, index) => [
  {
    name: `lone-${index === 0 ? "high" : "low"}-value`,
    body: { text: unit },
    error: "Use well-formed Unicode strings.",
  },
  {
    name: `lone-${index === 0 ? "high" : "low"}-key`,
    body: { [unit]: "value" },
    error: "Use well-formed Unicode strings.",
  },
]);
const item = {
  id: "work-1",
  title: "Fixture task",
  description: "",
  acceptanceCriteria: "",
  type: "task",
  status: "open",
  priority: 2,
  assignee: null,
  labels: [],
  parent: null,
  dependencies: [],
  dueAt: null,
  deferUntil: null,
  estimateMinutes: null,
  externalRef: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  closedAt: null,
  commentCount: 0,
  comments: [],
  history: [],
  closeWhenDone: false,
};
const event = (seq: number): ProductEvent => ({
  id: `fixture-event-${seq}`,
  spaceId: "fixture-space",
  botId: "fixture-bot",
  threadId: "fixture-thread",
  runId: "fixture-run",
  seq,
  type: "thread.progress",
  createdAt: "2026-10-01T00:00:00.000Z",
  payload: { text: "Reply ✓ 🚀\nnext line" },
});
function streamVector(
  name: string,
  wire: string,
  startCursor: number,
  events: ProductEvent[],
  end: DeviceEventWindowEnd | null,
) {
  const utf8 = Buffer.from(wire);
  const rocket = utf8.indexOf(Buffer.from("🚀"));
  // Split inside the four-byte scalar as well as the SSE field and frame boundaries.
  const cuts = [
    ...new Set([0, 1, 7, ...(rocket >= 0 ? [rocket + 1, rocket + 3] : []), utf8.length]),
  ].sort((a, b) => a - b);
  return {
    name,
    startCursor,
    wire,
    utf8HexChunks: cuts.slice(1).map((cut, i) => utf8.subarray(cuts[i]!, cut).toString("hex")),
    expectedEvents: events,
    expectedWindow: end,
    expectedCursor: end?.nextCursor ?? events.at(-1)?.seq ?? startCursor,
  };
}
const firstEvent = event(1);
const laterEvent = event(4);
const limitEnd: DeviceEventWindowEnd = { nextCursor: 4, reason: "limit" };
const eventStreams = [
  streamVector(
    "gaps-and-heartbeat",
    `${deviceEventFrame(firstEvent)}: heartbeat\n\n${deviceEventFrame(laterEvent)}${deviceEventEndFrame(limitEnd)}`,
    -1,
    [firstEvent, laterEvent],
    limitEnd,
  ),
  streamVector(
    "duplicate-frame",
    `${deviceEventFrame(firstEvent)}${deviceEventFrame(firstEvent)}${deviceEventFrame(laterEvent)}${deviceEventEndFrame(limitEnd)}`,
    -1,
    [firstEvent, laterEvent],
    limitEnd,
  ),
  streamVector(
    "disconnect-mid-frame",
    `${deviceEventFrame(firstEvent)}${deviceEventFrame(laterEvent).slice(0, -3)}`,
    -1,
    [firstEvent],
    null,
  ),
  streamVector(
    "reconnect",
    `${deviceEventFrame(laterEvent)}${deviceEventEndFrame(limitEnd)}`,
    1,
    [laterEvent],
    limitEnd,
  ),
  ...(["timeout", "access_lost", "payload_too_large", "error", "shutdown"] as const).map(
    (reason) => {
      const end = { nextCursor: 4, reason };
      return streamVector(reason, deviceEventEndFrame(end), 4, [], end);
    },
  ),
];
const fixtures = {
  version: 1,
  ...context,
  eventWindow: DEVICE_EVENT_WINDOW,
  eventStreams,
  requests: requests.map(({ operation, body }) => ({
    operation,
    body,
    canonicalBody: canonicalDispatchJson(body),
    signedText: deviceSignedText(context.instanceId, context.proof, operation, body),
  })),
  responses: [
    {
      operation: "rooms/send",
      body: {
        kind: "work",
        taskId: "fixture-task",
        runId: "fixture-run-1",
        runIds: ["fixture-run-1", "fixture-run-2"],
        seq: 1,
      },
    },
    {
      operation: "rooms/send",
      body: {
        kind: "receipt-only",
        seq: 2,
        receipt: {
          id: "fixture-receipt",
          threadId: "fixture-thread",
          seq: 3,
          botId: "fixture-chief",
          requestMessageId: "fixture-message",
          key: "greeting",
          text: "Hello.",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
    {
      operation: "rooms/list",
      body: [
        {
          id: "fixture-room",
          spaceId: "fixture-space",
          name: "Fixture room",
          pinned: false,
          sectionId: null,
          archivedAt: null,
          threadId: "fixture-thread",
          preview: "",
          unread: false,
          members: [
            { botId: "fixture-chief", name: "Chief", color: "ink" },
            { botId: "fixture-worker", name: "Beta", color: "ink" },
          ],
          updatedAt: "2026-10-01T00:00:00.000Z",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    },
    {
      operation: "rpc",
      procedure: "computer/list",
      status: 200,
      body: [
        {
          botId: "fixture-bot",
          name: "Fixture bot",
          status: {
            computerId: "fixture-shared-computer",
            botId: "fixture-bot",
            mode: "team",
            kind: "docker",
            state: "stopped",
            controlHolder: "none",
            controlBotId: null,
            takeoverRequested: false,
            screenAvailable: false,
            screenWidth: 1280,
            screenHeight: 720,
            homeRevision: null,
            busyBotName: null,
            canUpdate: false,
          },
        },
      ],
    },
    {
      operation: "rpc",
      procedure: "board/snapshot",
      status: 200,
      body: { items: [item], readyIds: [item.id], blockedIds: [] },
    },
    { operation: "rpc", procedure: "board/show", status: 200, body: item },
    {
      operation: "rpc",
      procedure: "board/show",
      status: 403,
      body: {
        message: "This board is only available to this computer's owner.",
        problem: {
          code: "access_lost",
          message: "This board is only available to this computer's owner.",
        },
      },
    },
  ],
  rejected,
};
await writeFile(
  new URL("./fixtures/device-operations.json", import.meta.url),
  `${JSON.stringify(fixtures, null, 2)}\n`,
);
