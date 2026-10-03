import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DispatchReceipt, PairingPayload } from "@ardurbot/contracts";
import { DispatchInputSchema, DispatchReceiptSchema } from "@ardurbot/contracts";
import { parseArgs, USAGE } from "./args.js";
import { createClient, nonce, pairDevice } from "./client.js";
import type { PairedHome } from "./config.js";
import { loadHome, saveHome } from "./config.js";
import { CliError } from "./transport.js";
export type DeviceClient = Pick<ReturnType<typeof createClient>, "request">;
type Bot = { id: string; name: string };
type Summary = { taskId: string; state: string; messageId?: string | null };
export interface CommandDependencies {
  load: () => Promise<PairedHome>;
  save: (home: PairedHome) => Promise<void>;
  pair: (code: string) => Promise<PairedHome>;
  client: (home: PairedHome) => DeviceClient;
  file: (path: string) => Promise<string>;
  sleep: () => Promise<void>;
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
const safeText = (text: string) =>
  Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
    })
    .join("");
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
) {
  for (;;) {
    const summaries = await client.request<Summary[]>("summaries");
    if (!Array.isArray(summaries)) throw new CliError("Home returned incomplete task summaries.");
    const summary = summaries.find(
      (item) =>
        item.taskId === receipt.taskId && ["done", "failed", "stopped"].includes(item.state),
    );
    if (summary) {
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
        if (page.threadId !== receipt.threadId || !message || !Array.isArray(message.blocks))
          throw new CliError("The task finished, but its answer is unavailable. Open it at home.");
        text = message.blocks
          .filter((block) => typeof block.text === "string" && block.kind === "text")
          .map((block) => block.text)
          .join("\n");
      }
      return { ...receipt, state: summary.state, text };
    }
    const tasks = DispatchReceiptSchema.array().parse(await client.request("tasks"));
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
    client: createClient,
    file: readBrief,
    sleep: () => delay(2_000),
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
