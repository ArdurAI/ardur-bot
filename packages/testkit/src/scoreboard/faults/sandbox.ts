import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@ardurbot/adapter-kit";
import { teamBotWorkspaceDirectory } from "../../../../adapters/src/computer-support.js";
import { DesktopSandboxProvider } from "../../../../host-runtime/src/desktop-sandbox.js";

/** Durable production file IO; only the executor's synthetic directory setup is allowed. */
export class FaultSandbox extends DesktopSandboxProvider {
  constructor(private readonly directory: string) {
    super({ root: directory, restricted: true });
  }

  override async environmentNote() {
    return "Synthetic fault workspace. Shell commands are unavailable.";
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const root = path.resolve(computer.providerRef);
    const expected = context.botId
      ? ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(context.botId)]
      : [];
    if (
      !root.startsWith(`${path.resolve(this.directory)}${path.sep}`) ||
      !expected.length ||
      JSON.stringify(request.argv) !== JSON.stringify(expected)
    ) {
      yield { type: "stderr", data: "Only synthetic workspace setup is permitted." };
      yield { type: "exit", code: 126 };
      return;
    }
    for (const folder of expected.slice(2)) {
      const target = path.resolve(root, folder);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid fixture directory");
      await mkdir(target, { recursive: true });
    }
    yield { type: "exit", code: 0 };
  }
}
