import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { ComposioEmulator, ScriptedAgentRuntime } from "@ardurbot/adapters";
import type { DeviceGrantView, PairingPayload } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { createClient, pairDevice } from "../../../apps/cli/src/client.js";
import { runCli } from "../../../apps/cli/src/commands.js";
import type { Transport } from "../../../apps/cli/src/transport.js";
import { CliError } from "../../../apps/cli/src/transport.js";
import { sessionCookieHeader } from "./index.js";

const hasDatabase = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!hasDatabase)("paired command-line device", () => {
  it("pairs, signs, dispatches to completion, reads the final answer and is refused after revocation", async () => {
    const origin = "http://127.0.0.1:5173";
    const homeUrl = "https://home.example.test";
    const dataDir = await mkdtemp(path.join(tmpdir(), "ardur-cli-journey-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const runtime = new ScriptedAgentRuntime();
    vi.spyOn(runtime, "run").mockImplementation(async function* () {
      yield { type: "text", text: "Public fixture task completed." };
      yield { type: "done", text: "Public fixture task completed." };
    });
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      signupsEnabled: "true",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
      runtime,
    });
    vi.spyOn(handles.executor, "refreshBrief").mockResolvedValue(undefined);
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `cli-${randomUUID()}@example.test`,
          password: "fixture-password12",
          name: "CLI fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      async function rpc<T>(procedure: string, input: unknown = {}): Promise<T> {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        expect(response.status, procedure).toBe(200);
        return ((await response.json()) as { json: T }).json;
      }
      const me = await rpc<{ userId: string; spaceId: string }>("me");
      await handles.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: me.userId },
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Builder fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const issued = await rpc<{ payload: PairingPayload }>("pairing/start", {
        scopes: ["read", "dispatch", "stop", "ordinary"],
        hints: [homeUrl],
      });
      // In-process transport exercises the real routes and signatures without a listener.
      // The separate transport tests cover TLS gating before any HTTP request leaves.
      const transport: Transport = async (url, pin, body) => {
        expect(new URL(url).origin).toBe(homeUrl);
        expect(pin).toBe(issued.payload.certificateFingerprint);
        const response = await handles.app.request(new URL(url).pathname, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as { message?: string };
        if (!response.ok)
          throw new CliError(
            result.message ?? "Request refused.",
            response.status === 401 || response.status === 403 ? 2 : 1,
          );
        return result;
      };
      const home = await pairDevice(JSON.stringify(issued.payload), transport);
      expect(home.spaceId).toBe(me.spaceId);
      const listed = await rpc<{ devices: DeviceGrantView[] }>("devices/list");
      expect(listed.devices).toContainEqual(
        expect.objectContaining({ id: home.grantId, platform: "cli", deviceName: "Command line" }),
      );
      const out: string[] = [];
      const errors: string[] = [];
      const deadline = Date.now() + 15_000;
      const deps = {
        load: async () => home,
        client: () => createClient(home, transport),
        out: (text: string) => out.push(text),
        error: (text: string) => errors.push(text),
        sleep: async () => {
          if (Date.now() > deadline) throw new Error("Task deadline");
          await setTimeout(25);
        },
      };
      expect(
        await runCli(["send", bot.id, "Complete the public fixture.", "--wait", "--json"], deps),
      ).toBe(0);
      const receipt = JSON.parse(out.join(""));
      expect(receipt).toMatchObject({
        botId: bot.id,
        state: "done",
        text: "Public fixture task completed.",
      });
      expect(errors).toEqual([]);
      const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } });
      expect(run.status).toBe("completed");
      await rpc("devices/revoke", { id: home.grantId });
      out.length = 0;
      expect(await runCli(["send", bot.id, "Must not run."], deps)).toBe(2);
      expect(out).toEqual([]);
      expect(errors.join("")).toContain("This device is unavailable; pair it again at home.");
      expect(await handles.prisma.run.count({ where: { botId: bot.id } })).toBe(1);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 30_000);
});
