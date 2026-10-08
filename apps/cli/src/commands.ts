import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DispatchReceipt, PairingPayload } from "@ardurbot/contracts";
import { DispatchInputSchema, DispatchReceiptSchema } from "@ardurbot/contracts";
import type { Command } from "./args.js";
import { parseArgs, USAGE } from "./args.js";
import { createClient, nonce, pairDevice } from "./client.js";
import type { PairedHome } from "./config.js";
import { loadHome, saveHome } from "./config.js";
import { safeDiagnostic, safeText } from "./text.js";
import type { Transcript } from "./transcript.js";
import { prepareTranscript } from "./transcript.js";
import { CliError } from "./transport.js";
export type DeviceClient = Pick<ReturnType<typeof createClient>, "request">;
type Bot = { id: string; name: string };
type Summary = { taskId: string; state: string; messageId?: string | null };
export interface CommandDependencies {
  load: () => Promise<PairedHome>;
  save: (home: PairedHome) => Promise<void>;
  pair: (code: string) => Promise<PairedHome>;
  client: (home: PairedHome, signal?: AbortSignal) => DeviceClient;
  now: () => number;
  transcript: (path: string) => Promise<Transcript>;
  file: (path: string) => Promise<string>;
  sleep: (signal?: AbortSignal) => Promise<void>;
  out: (text: string) => void;
  error: (text: string) => void;
}
async function readBrief(filePath: string) {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new CliError("Choose a regular brief file.", 3);
    const buffer = Buffer.alloc(128_001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128_000) throw new CliError("Keep the task within 32,000 characters.", 3);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
async function listBots(client: DeviceClient): Promise<Bot[]> {
  const result = await client.request<Bot[]>("rpc", { procedure: "bots/list", input: {} });
  if (
    !Array.isArray(result) ||
    result.some((bot) => !bot || typeof bot.id !== "string" || typeof bot.name !== "string")
  )
    throw new CliError("Home returned an incomplete bot list.");
  return result.map(({ id, name }) => ({ id, name }));
}
async function botId(client: DeviceClient, selected?: string) {
  if (!selected) return undefined;
  const bots = await listBots(client);
  const exact = bots.find((bot) => bot.id === selected);
  if (exact) return exact.id;
  const named = bots.filter((bot) => bot.name === selected);
  if (named.length !== 1) throw new CliError("Choose a bot id from ardur bots.", 3);
  return named[0]!.id;
}
async function waitForReply(
  client: DeviceClient,
  receipt: DispatchReceipt,
  sleep: () => Promise<void>,
  strict = false,
) {
  for (;;) {
    const summaries = await client.request<Summary[]>("summaries");
    if (!Array.isArray(summaries)) throw new CliError("Home returned incomplete task summaries.");
    const summary = summaries.find(
      (item) =>
        item.taskId === receipt.taskId && ["done", "failed", "stopped"].includes(item.state),
    );
    if (summary && (!strict || summary.messageId || summary.state !== "done")) {
      let text = "";
      if (summary.messageId) {
        const page = await client.request<{
          threadId: string;
          messages: Array<{
            id: string;
            runId?: string;
            role: string;
            blocks: Array<{ kind: string; text?: string; reasoning?: boolean }>;
          }>;
        }>("rpc", {
          procedure: "threads/messages",
          input: {
            botId: receipt.botId,
            threadId: receipt.threadId,
            around: { messageId: summary.messageId },
          },
        });
        const message = page.messages?.find(
          (message) =>
            message.id === summary.messageId &&
            message.runId === receipt.runId &&
            message.role === "bot",
        );
        if (page.threadId !== receipt.threadId || !message || !Array.isArray(message.blocks)) {
          if (strict) {
            if (summary.state !== "done") return { ...receipt, state: summary.state, text: "" };
            await sleep();
            continue;
          }
          throw new CliError("The task finished, but its answer is unavailable. Open it at home.");
        }
        text = message.blocks
          .filter(
            (block) =>
              typeof block.text === "string" && block.kind === "text" && block.reasoning !== true,
          )
          .map((block) => block.text)
          .join("\n");
      }
      return { ...receipt, state: summary.state, text };
    }
    const tasks = DispatchReceiptSchema.array().parse(await client.request("tasks"));
    const current = tasks.find(
      (task) => task.taskId === receipt.taskId && task.runId === receipt.runId,
    );
    if (strict && current && ["failed", "stopped"].includes(current.state))
      return { ...receipt, state: current.state, text: "" };
    if (!tasks.some((task) => task.taskId === receipt.taskId))
      throw new CliError("This task is no longer listed. Check it at home.");
    await sleep();
  }
}
export async function runCli(
  args: string[],
  overrides: Partial<CommandDependencies> = {},
): Promise<number> {
  const deps: CommandDependencies = {
    load: loadHome,
    save: saveHome,
    pair: pairDevice,
    client: (home, signal) => createClient(home, undefined, signal),
    now: () => performance.now(),
    transcript: prepareTranscript,
    file: readBrief,
    sleep: (signal) => delay(2_000, undefined, { signal }),
    out: (text) => process.stdout.write(text),
    error: (text) => process.stderr.write(text),
    ...overrides,
  };
  try {
    const command = parseArgs(args);
    if (command.kind === "help") {
      deps.out(`${USAGE}\n`);
      return 0;
    }
    const output = (value: unknown, text: string) =>
      deps.out(`${command.json ? JSON.stringify(value) : safeText(text)}\n`);
    if (command.kind === "pair") {
      const home = await deps.pair(command.code);
      await deps.save(home);
      output({ homeName: home.homeName, paired: true }, `Paired with ${home.homeName}.`);
      return 0;
    }
    if (command.kind === "test") return runBotTest(command, deps);
    const home = await deps.load();
    const client = deps.client(home);
    if (command.kind === "bots") {
      const bots = await listBots(client);
      output(bots, bots.map((bot) => `${bot.id}\t${bot.name}`).join("\n"));
      return 0;
    }
    if (command.kind === "status") {
      // A signed read validates revocation and current read scope, not just reachability.
      await client.request("tasks");
      const status: Pick<PairingPayload, "homeName" | "instanceId"> & { valid: boolean } = {
        homeName: home.homeName,
        instanceId: home.instanceId,
        valid: true,
      };
      output(status, `Paired with ${home.homeName}. Device is valid.`);
      return 0;
    }
    if (command.kind === "stop") {
      const result = await client.request("stop", { taskId: command.taskId });
      output(result, `Stop requested for ${command.taskId}.`);
      return 0;
    }
    if (command.kind !== "send") throw new CliError(USAGE, 3);
    const text = command.file ? await deps.file(command.file) : command.text!;
    if (!text.trim() || text.length > 32_000)
      throw new CliError("Write a task within 32,000 characters.", 3);
    const input = DispatchInputSchema.parse({
      clientNonce: nonce(),
      botId: await botId(client, command.bot),
      text,
    });
    const receipt = DispatchReceiptSchema.parse(await client.request("dispatch", input));
    if (!command.wait) {
      output(receipt, `Task ${receipt.taskId}\nRun ${receipt.runId}`);
      return receipt.state === "failed" || receipt.state === "stopped" ? 1 : 0;
    }
    const result = await waitForReply(client, receipt, deps.sleep);
    output(result, result.text || `Task ${result.taskId}: ${result.state}.`);
    return result.state === "done" ? 0 : 1;
  } catch (error) {
    if (args[0] === "test") {
      const result = emptyTestResult();
      result.failureReason = USAGE;
      printTestResult(result, args.includes("--json"), deps);
      return 4;
    }
    const known = error instanceof CliError;
    const exitCode = known ? error.exitCode : 1;
    const message = known ? error.message : "This request could not finish; try again.";
    // Only controlled messages reach stderr, never key material or remote diagnostics.
    deps.error(
      `${args.includes("--json") ? JSON.stringify({ error: message, exitCode }) : message}\n`,
    );
    return exitCode;
  }
}

type TestVerdict = "pass" | "mismatch" | "failed" | "stopped" | "deadline" | "error";
type TestResult = {
  version: 1;
  bot: Bot | null;
  runId: string | null;
  taskId: string | null;
  verdict: TestVerdict;
  replyText: string;
  elapsedMs: number;
  failureReason: string | null;
};
function emptyTestResult(): TestResult {
  return {
    version: 1,
    bot: null,
    runId: null,
    taskId: null,
    verdict: "error",
    replyText: "",
    elapsedMs: 0,
    failureReason: null,
  };
}
function printTestResult(result: TestResult, json: boolean, deps: CommandDependencies) {
  const text = [
    result.taskId ? `Task ${result.taskId}\nRun ${result.runId}` : "",
    result.verdict === "pass" ? "Passed." : result.failureReason,
    result.replyText,
  ]
    .filter(Boolean)
    .join("\n");
  // Redact each string, not serialized JSON: escaped control sequences cannot bypass PEM redaction.
  const safe = {
    ...result,
    bot: result.bot
      ? { id: safeDiagnostic(result.bot.id), name: safeDiagnostic(result.bot.name) }
      : null,
    runId: result.runId === null ? null : safeDiagnostic(result.runId),
    taskId: result.taskId === null ? null : safeDiagnostic(result.taskId),
    replyText: safeDiagnostic(result.replyText),
    failureReason: result.failureReason === null ? null : safeDiagnostic(result.failureReason),
  };
  deps.out(`${json ? JSON.stringify(safe) : safeDiagnostic(text)}\n`);
}
async function runBotTest(command: Extract<Command, { kind: "test" }>, deps: CommandDependencies) {
  const result = emptyTestResult();
  const started = deps.now();
  const controller = new AbortController();
  const deadline = new Error("deadline");
  let expired = false;
  let transcript: Transcript | undefined;
  let exitCode = 4;
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(deadline), { once: true });
  });
  // Every client request and sleep races the same deadline; late responses cannot start new work.
  const bounded = <T>(work: () => Promise<T>): Promise<T> =>
    expired ? Promise.reject(deadline) : Promise.race([work(), stopped]);
  // Transcript preparation is local and happens before admission, outside the network deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (command.transcript) transcript = await deps.transcript(command.transcript);
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, command.timeoutMs);
    const home = await bounded(deps.load);
    const rawClient = deps.client(home, controller.signal);
    const client: DeviceClient = {
      request: <T>(operation: string, body?: unknown) =>
        bounded(() => rawClient.request<T>(operation, body)),
    };
    const bots = await listBots(client);
    const exact = bots.find((bot) => bot.id === command.bot);
    const matches = exact ? [exact] : bots.filter((bot) => bot.name === command.bot);
    if (matches.length !== 1) {
      const candidates = (matches.length ? matches : bots)
        .map((bot) => `${bot.id}\t${bot.name}`)
        .join("\n");
      throw new CliError(
        `Choose a bot id from ardur bots.${candidates ? `\n${candidates}` : ""}`,
        3,
      );
    }
    result.bot = matches[0]!;
    if (transcript) await transcript.write({ ...result, prompt: command.prompt });
    const receipt = DispatchReceiptSchema.parse(
      await client.request(
        "dispatch",
        DispatchInputSchema.parse({
          clientNonce: nonce(),
          botId: result.bot.id,
          text: command.prompt,
        }),
      ),
    );
    result.runId = receipt.runId;
    result.taskId = receipt.taskId;
    if (transcript) await transcript.write({ ...result, prompt: command.prompt });
    if (receipt.botId !== result.bot.id)
      throw new CliError("Home returned a different bot; check the task at home.");
    const reply = ["failed", "stopped"].includes(receipt.state)
      ? { ...receipt, text: "" }
      : await waitForReply(
          client,
          receipt,
          () => bounded(() => deps.sleep(controller.signal)),
          true,
        );
    result.replyText = reply.text;
    if (reply.state === "failed" || reply.state === "stopped") {
      result.verdict = reply.state;
      result.failureReason =
        safeDiagnostic(reply.text) ||
        (reply.state === "failed"
          ? "The bot run failed; check it at home."
          : "The bot run stopped.");
      exitCode = 2;
    } else {
      const passed = reply.text.includes(command.expectContains);
      result.verdict = passed ? "pass" : "mismatch";
      result.failureReason = passed ? null : "Reply did not contain the expected text.";
      exitCode = passed ? 0 : 1;
    }
  } catch (error) {
    if (expired || error === deadline) {
      result.verdict = "deadline";
      result.failureReason =
        "The deadline was reached. Waiting stopped; the task was not cancelled.";
      exitCode = 3;
    } else {
      result.verdict = "error";
      exitCode = error instanceof CliError && error.exitCode !== 1 ? 4 : 2;
      result.failureReason =
        error instanceof CliError
          ? safeDiagnostic(error.message)
          : "This request could not finish; check it at home before trying again.";
    }
  } finally {
    if (timer) clearTimeout(timer);
    result.elapsedMs = Math.max(0, Math.round(deps.now() - started));
    try {
      if (transcript) await transcript.write({ ...result, prompt: command.prompt });
    } catch {
      result.failureReason = "The private transcript could not be saved.";
      result.verdict = "error";
      exitCode = 4;
    } finally {
      await transcript?.close().catch(() => undefined);
    }
  }
  printTestResult(result, command.json, deps);
  return exitCode;
}
