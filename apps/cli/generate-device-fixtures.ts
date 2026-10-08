import { writeFile } from "node:fs/promises";
import { canonicalDispatchJson, deviceSignedText } from "@ardurbot/contracts";

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
const fixtures = {
  version: 1,
  ...context,
  requests: requests.map(({ operation, body }) => ({
    operation,
    body,
    canonicalBody: canonicalDispatchJson(body),
    signedText: deviceSignedText(context.instanceId, context.proof, operation, body),
  })),
  rejected,
};
await writeFile(
  new URL("./fixtures/device-operations.json", import.meta.url),
  `${JSON.stringify(fixtures, null, 2)}\n`,
);
