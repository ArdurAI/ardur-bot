import type { DeviceRunDetail } from "@ardurbot/contracts";
import {
  DeviceMessagesGetInputSchema,
  DeviceMessagesGetOutputSchema,
  DeviceRunGetInputSchema,
  DeviceRunGetOutputSchema,
  DeviceRunsListInputSchema,
  DeviceRunsListOutputSchema,
  DeviceStopOutputSchema,
  DeviceTaskGetInputSchema,
  DeviceTaskGetOutputSchema,
  DispatchInputSchema,
  DispatchReceiptSchema,
  wellFormedUnicode,
} from "@ardurbot/contracts";
import type { Command } from "./args.js";
import { nonce } from "./client.js";
import type { CommandDependencies, DeviceClient } from "./commands.js";
import { safeDiagnostic } from "./text.js";
import { CliError } from "./transport.js";

function redact(value: unknown): unknown {
  if (typeof value === "string") return safeDiagnostic(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  return value;
}

/** Uses test bot's versioned result fields and its 0–4 exit-code meanings. */
export async function runDeviceCommand(command: Command, deps: CommandDependencies) {
  const started = deps.now();
  const result = {
    version: 1,
    command: command.kind.replace("-", " "),
    bot: null as { id: string; name: string } | null,
    runId: null as string | null,
    taskId: null as string | null,
    verdict: "pass",
    replyText: "",
    elapsedMs: 0,
    failureReason: null as string | null,
    data: null as unknown,
  };
  let exitCode = 0;
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Error("deadline");
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(deadline), { once: true });
  });
  const bounded = <T>(work: () => Promise<T>) =>
    expired ? Promise.reject(deadline) : Promise.race([work(), stopped]);
  try {
    if (command.kind === "wait" || (command.kind === "send" && command.wait)) {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
      }, command.timeoutMs);
    }
    const home = await bounded(deps.load);
    const raw = deps.client(home, controller.signal);
    const client: DeviceClient = {
      request: <T>(operation: string, body?: unknown) =>
        bounded(() => raw.request<T>(operation, body)),
    };
    let runId: string | undefined;
    if (command.kind === "runs-list") {
      result.data = DeviceRunsListOutputSchema.parse(
        await client.request(
          "runs/list",
          DeviceRunsListInputSchema.parse({ cursor: command.cursor, limit: command.limit }),
        ),
      );
    } else if (command.kind === "runs-show") {
      result.runId = command.runId;
      result.data = DeviceRunGetOutputSchema.parse(
        await client.request("runs/get", DeviceRunGetInputSchema.parse({ runId: command.runId })),
      );
    } else if (command.kind === "tasks-show") {
      result.taskId = command.taskId;
      result.data = DeviceTaskGetOutputSchema.parse(
        await client.request(
          "tasks/get",
          DeviceTaskGetInputSchema.parse({ taskId: command.taskId }),
        ),
      );
    } else if (command.kind === "stop") {
      result.taskId = command.taskId;
      // Stop is a request, not confirmation. Keep the existing device operation and response.
      result.data = DeviceStopOutputSchema.parse(
        await client.request("stop", { taskId: command.taskId }),
      );
    } else if (command.kind === "send") {
      const text = command.file ? await bounded(() => deps.file(command.file!)) : command.text!;
      if (!wellFormedUnicode(text) || (command.requestId && !wellFormedUnicode(command.requestId)))
        throw new CliError("Use well-formed Unicode strings.", 3);
      if (!text.trim() || text.length > 32_000)
        throw new CliError("Write a task within 32,000 characters.", 3);
      let botId: string | undefined;
      if (command.bot) {
        const bots = await client.request<Array<{ id: string; name: string }>>("rpc", {
          procedure: "bots/list",
          input: {},
        });
        if (
          !Array.isArray(bots) ||
          bots.some((bot) => typeof bot.id !== "string" || typeof bot.name !== "string")
        )
          throw new CliError("Home returned an incomplete bot list.");
        const exact = bots.find((bot) => bot.id === command.bot);
        const matches = exact ? [exact] : bots.filter((bot) => bot.name === command.bot);
        if (matches.length !== 1) throw new CliError("Choose a bot id from ardur bots.", 3);
        result.bot = matches[0]!;
        botId = result.bot.id;
      }
      // clientNonce already is the durable per-device request id. No new wire field is needed.
      const receipt = DispatchReceiptSchema.parse(
        await client.request(
          "dispatch",
          DispatchInputSchema.parse({ clientNonce: command.requestId ?? nonce(), botId, text }),
        ),
      );
      if (botId && receipt.botId !== botId)
        throw new CliError("Home returned a different bot; check the task at home.");
      result.taskId = receipt.taskId;
      result.runId = receipt.runId;
      result.data = receipt;
      if (command.wait) runId = receipt.runId;
      else if (receipt.state === "failed" || receipt.state === "stopped") {
        result.verdict = receipt.state;
        result.failureReason =
          receipt.state === "failed"
            ? "The bot run failed; check it at home."
            : "The bot run stopped.";
        exitCode = 2;
      }
    } else if (command.kind === "wait") {
      runId = command.runId;
      result.runId = runId;
    } else {
      throw new CliError("Choose a supported command.", 3);
    }
    if (runId) {
      for (;;) {
        const { run } = DeviceRunGetOutputSchema.parse(await client.request("runs/get", { runId }));
        if (run.runId !== runId || (result.taskId && run.taskId !== result.taskId))
          throw new CliError("Home returned a different run; check the task at home.");
        result.taskId = run.taskId;
        result.data = { run };
        if (run.cancelConfirmed || run.status === "cancelled" || run.status === "failed") {
          result.verdict = run.cancelConfirmed || run.status === "cancelled" ? "stopped" : "failed";
          result.failureReason = run.failure?.message ?? "The bot run stopped.";
          exitCode = 2;
          break;
        }
        if (run.status === "waiting_input" || run.status === "waiting_takeover") {
          result.verdict = "error";
          result.failureReason = "This run needs input at home; waiting stopped.";
          exitCode = 4;
          break;
        }
        if (run.status === "completed") {
          if (run.failure) {
            result.verdict = "error";
            result.failureReason = run.failure.message;
            exitCode = 2;
            break;
          }
          result.replyText = await answer(client, run);
          break;
        }
        await bounded(() => deps.sleep(controller.signal));
      }
    }
  } catch (error) {
    if (expired || error === deadline) {
      result.verdict = "deadline";
      result.failureReason =
        "The deadline was reached. Waiting stopped; the task was not cancelled.";
      exitCode = 3;
    } else {
      result.verdict = "error";
      result.failureReason =
        error instanceof CliError
          ? error.message
          : "This request could not finish; check it at home before trying again.";
      exitCode = error instanceof CliError && error.exitCode !== 1 ? 4 : 2;
    }
  } finally {
    if (timer) clearTimeout(timer);
    result.elapsedMs = Math.max(0, Math.round(deps.now() - started));
  }
  const text =
    result.failureReason ??
    (result.replyText ||
      (command.kind === "send"
        ? `Task ${result.taskId}\nRun ${result.runId}`
        : command.kind === "stop"
          ? `Cancellation requested for ${result.taskId}.`
          : JSON.stringify(result.data)));
  deps.out(
    `${"json" in command && command.json ? JSON.stringify(redact(result)) : safeDiagnostic(text)}\n`,
  );
  return exitCode;
}

async function answer(client: DeviceClient, run: DeviceRunDetail): Promise<string> {
  const unavailable = () =>
    new CliError("The task finished, but its answer is unavailable. Open it at home.");
  const page = DeviceMessagesGetOutputSchema.parse(
    await client.request(
      "messages/get",
      DeviceMessagesGetInputSchema.parse({
        botId: run.botId,
        threadId: run.threadId,
        around: { messageId: run.messageId },
      }),
    ),
  );
  const message = page.messages.find(
    (message) =>
      message.id === run.messageId && message.runId === run.runId && message.role === "bot",
  );
  if (page.threadId !== run.threadId || !message) throw unavailable();
  const text = message.blocks
    .filter((block) => block.kind === "text" && block.reasoning !== true)
    .map((block) => (block.kind === "text" ? (block.text ?? "") : ""))
    .join("\n");
  if (!text) throw unavailable();
  return text;
}
