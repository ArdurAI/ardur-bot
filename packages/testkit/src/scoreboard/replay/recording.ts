import type {
  ModelEmulatorRequest,
  ModelEmulatorResponse,
  ModelEmulatorStep,
} from "../../model-emulator.js";
import { startModelEmulator } from "../../model-emulator.js";
import type { TaskContract } from "../tasks/catalog.js";
import { referenceSolution } from "../tasks/reference.js";
import type { ReplayFixture, Variable } from "./protocol.js";
import { normalizeRequest } from "./protocol.js";

function responseChunks(response: ModelEmulatorResponse, sequence: number) {
  const chunks: string[] = [];
  const emit = (delta: unknown, finish: string | null = null) =>
    chunks.push(
      `data: ${JSON.stringify({ id: `fixture-${sequence}`, object: "chat.completion.chunk", created: 0, model: "scoreboard-v1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  emit({ role: "assistant" });
  if (response.type === "tool") {
    emit({
      tool_calls: [
        {
          index: 0,
          id: response.id,
          type: "function",
          function: { name: response.name, arguments: "" },
        },
      ],
    });
    for (const fragment of response.argumentChunks ?? [JSON.stringify(response.arguments)])
      emit({ tool_calls: [{ index: 0, function: { arguments: fragment } }] });
    emit({}, "tool_calls");
  } else if (response.type === "text") {
    emit({ content: response.text });
    emit({}, "stop");
  } else throw new Error("Reference recording only emits tools and text");
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

export function requestVariables(request: ModelEmulatorRequest): Variable[] {
  const variables: Variable[] = [];
  const textVariables = (value: string, path: (string | number)[], name: string) => {
    if (value.includes("[ardur-memory:"))
      variables.push({ path, kind: "memory-reference-id", name: `memory-${name}` });
    if (value.includes("Your Team Computer home is bots/"))
      variables.push({ path, kind: "workspace-bot-id", name: "workspace-bot" });
  };
  for (const [index, message] of request.messages.entries()) {
    if (typeof message.content === "string")
      textVariables(message.content, ["body", "messages", index, "content"], `${index}`);
    if (typeof message.content === "string" && message.content.includes("Current date and time:"))
      variables.push({
        path: ["body", "messages", index, "content"],
        kind: "current-time-line",
        name: `clock-${index}`,
      });
    if (Array.isArray(message.content))
      for (const [part, content] of message.content.entries()) {
        if (typeof content?.text === "string")
          textVariables(
            content.text,
            ["body", "messages", index, "content", part, "text"],
            `${index}-${part}`,
          );
        if (typeof content?.text === "string" && content.text.includes("Current date and time:"))
          variables.push({
            path: ["body", "messages", index, "content", part, "text"],
            kind: "current-time-line",
            name: `clock-${index}-${part}`,
          });
      }
  }
  return variables;
}

/** Explicit recording is never a passing replay. New tapes require subsequent strict validation. */
export async function startReferenceRecording(task: TaskContract, longHistory = false) {
  const solution = referenceSolution(task);
  const actions: ModelEmulatorResponse[] = [];
  const tool = (name: string, args: Record<string, unknown>) =>
    actions.push({ type: "tool", id: `call-${actions.length + 1}`, name, arguments: args });
  for (const file of Object.keys(task.files)) tool("read_file", { path: file });
  if (task.initialState.length) tool("SCOREBOARD_READ", {});
  for (const update of solution.updates) tool("SCOREBOARD_UPDATE", update);
  for (const [file, content] of Object.entries(solution.files))
    tool("write_file", { path: file, content });
  actions.push({ type: "text", text: "Saved the requested result." });
  // The fixed 204-message history requires two 50-message batches and one 2-message prefix.
  // The next message exceeds the production transcript cap and must remain uncompacted.
  for (let batch = 0; batch < (longHistory ? 3 : 0); batch++)
    actions.push({
      type: "text",
      text: "Archived conversation contains synthetic context only. Current input files remain authoritative. The requested result was saved; no further action is authorized.",
    });
  const steps: ModelEmulatorStep[] = actions.map((response) => ({ expect() {}, response }));
  const server = await startModelEmulator({ modelId: "scoreboard-v1", steps });
  return {
    ...server,
    fixture(): ReplayFixture {
      server.assertComplete();
      return {
        version: 1,
        protocol: "openai-chat-sse",
        route: {
          provider: "openai-compatible",
          model: "scoreboard-v1",
          runtime: "pi",
          protocolVersion: "chat-completions-v1",
        },
        initial: "step-0",
        terminal: [`step-${actions.length}`],
        exchanges: server.requests.map((body, index) => {
          const variables = requestVariables(body);
          return {
            id: `exchange-${index}`,
            from: `step-${index}`,
            to: `step-${index + 1}`,
            request: normalizeRequest(
              { method: "POST", path: "/v1/chat/completions", body },
              variables,
            ),
            variables,
            response: {
              status: 200,
              headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
              chunks: responseChunks(actions[index]!, index + 1),
              end: "complete",
            },
          };
        }),
      };
    },
  };
}
