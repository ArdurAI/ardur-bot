import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { AgentRuntime } from "@ardurbot/adapter-kit";
import {
  archiveBot,
  ComposioEmulator,
  captureIntegrationManifest,
  createJobReconciler,
  createScheduleFromTool,
  DesktopSandboxProvider,
  FakeSandboxProvider,
  handoffToGroupBot,
  ManagedSandboxEmulator,
  McpConnector,
  messageBot,
  owningSandbox,
  ScriptedAgentRuntime,
  toComputerRef,
} from "@ardurbot/adapters";
import type { DelegationSnapshot, MemoryPage, TaughtSkill } from "@ardurbot/contracts";
import {
  ACTIVE_RUN_STATUSES,
  LEGACY_RESTART_SUMMARY,
  ONCE_ROUTINE_CRON,
  RECEIPT_FILTERED_SUMMARY_MARKER,
} from "@ardurbot/core";
import {
  admitDelegation,
  appendEvent,
  claimSteering,
  createThreadEvents,
  createThreadMessage,
  expireQuietBotMessages,
  finalizeRun,
  RunHistoryWriteError,
  sendUserMessage,
  updateWorkerTask,
  wakeGoalCoordinatorForDelegation,
} from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { markBriefPending, refreshRunBrief } from "@ardurbot/memory";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import * as turnContext from "../../adapters/src/context/assemble.js";
import { checkDelegationExecution } from "../../adapters/src/delegation-execution.js";
import { integrationApprovalForCall } from "../../adapters/src/integration-access.js";
import { toHistory } from "../../adapters/src/pi-runtime.js";
import { promptWithInitialSteering } from "../../adapters/src/steering-input.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeJourneys = hasDb ? describe : describe.skip;

describeJourneys("required product journeys", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<ReturnType<typeof createApp>>["prisma"];
  let connector: Awaited<ReturnType<typeof createApp>>["connector"];
  let executor: Awaited<ReturnType<typeof createApp>>["executor"];
  let jobs: Awaited<ReturnType<typeof createApp>>["jobs"];
  let sandbox: Awaited<ReturnType<typeof createApp>>["sandbox"];
  const stamp = Date.now();
  let ownerCookie: string;
  const dataDir = mkdtempSync(path.join(tmpdir(), "ardurbot-journey-"));

  async function settleFixtureWork(botIds: string[], goalId?: string) {
    if (goalId)
      await prisma.teamGoal.update({
        where: { id: goalId },
        data: { status: "stopped", stoppedAt: new Date() },
      });
    await prisma.run.updateMany({
      where: {
        botId: { in: botIds },
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled", completedAt: new Date() },
    });
    await prisma.task.updateMany({
      where: { botId: { in: botIds }, status: { in: ["queued", "running"] } },
      data: { status: "cancelled" },
    });
  }

  async function sendAndWait(app: App, cookie: string, botId: string, text: string) {
    const { runId } = await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text });
    let terminal: { status: string; error: string | null } | null = null;
    await waitForDatabase(async () => {
      terminal = await prisma.run.findUnique({
        where: { id: runId },
        select: { status: true, error: true },
      });
      return Boolean(terminal && ["completed", "failed", "cancelled"].includes(terminal.status));
    });
    if (!terminal) throw new Error(`run ${runId} was not found after completion`);
    if (terminal.status !== "completed") {
      throw new Error(
        `run ${runId} ended ${terminal.status}: ${terminal.error ?? "unknown error"}`,
      );
    }
    return {
      ...(await rpc<Snap>(app, cookie, "threads/get", { botId })),
      run: { id: runId, status: terminal.status },
    };
  }

  async function sendGroupAndWait(
    app: App,
    cookie: string,
    groupId: string,
    text: string,
    waitForBotId?: string,
  ) {
    const { runIds, runId } = await rpc<{ runId: string; runIds?: string[] }>(
      app,
      cookie,
      "threads/send",
      {
        groupId,
        text,
      },
    );
    let targets = runIds ?? [runId];
    if (waitForBotId) {
      const runs = await prisma.run.findMany({
        where: { id: { in: targets }, botId: waitForBotId },
        select: { id: true },
      });
      targets = runs.map((run) => run.id);
      if (targets.length === 0) {
        throw new Error(`no run scheduled for bot ${waitForBotId}`);
      }
    }
    for (const runId of targets) {
      let terminal: { status: string; error: string | null } | null = null;
      await waitForDatabase(async () => {
        terminal = await prisma.run.findUnique({
          where: { id: runId },
          select: { status: true, error: true },
        });
        return Boolean(terminal && ["completed", "failed", "cancelled"].includes(terminal.status));
      });
      if (!terminal) throw new Error(`run ${runId} was not found after completion`);
      if (terminal.status !== "completed") {
        throw new Error(
          `run ${runId} ended ${terminal.status}: ${terminal.error ?? "unknown error"}`,
        );
      }
    }
    return rpc<Snap>(app, cookie, "threads/get", { groupId });
  }

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
    connector = handles.connector;
    executor = handles.executor;
    jobs = handles.jobs;
    sandbox = handles.sandbox;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("new bots inherit a connected tool while an explicit removal survives saves and review", async () => {
    const cookie = await signup(app, `integration-access-${stamp}@ardurbot.test`, "Workspace");
    const otherCookie = await signup(
      app,
      `integration-access-other-${stamp}@ardurbot.test`,
      "Other workspace",
    );
    const owner = await rpc<Me>(app, cookie, "me");
    const tool = {
      name: "synthetic_read",
      description: "Read a fixture",
      inputSchema: { type: "object" },
    };
    const manifest = captureIntegrationManifest([tool], "fixture");
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        slug: `fixture-${stamp}`,
        name: "Fixture connection",
        transport: "streamable_http",
        endpoint: "https://example.test/mcp",
        catalogId: "github",
        enabled: true,
        connectionState: "connected",
        manifest,
        spaceAllowedTools: [tool.name],
      },
    });
    const first = await rpc<Bot>(app, cookie, "bots/create", {
      name: "First",
      title: "First",
      description: "Fixture",
      instructions: "",
    });
    const second = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Second",
      title: "Second",
      description: "Fixture",
      instructions: "",
    });
    const outsider = await rpc<Bot>(app, otherCookie, "bots/create", {
      name: "Outside",
      title: "Outside",
      description: "Fixture",
      instructions: "",
    });
    const mcp = new McpConnector(prisma, {} as never);
    (
      mcp as unknown as {
        sessionFor: () => Promise<{ listTools: () => Promise<{ tools: (typeof tool)[] }> }>;
      }
    ).sessionFor = async () => ({ listTools: async () => ({ tools: [tool] }) });
    const listed = (botId: string, scope = owner) =>
      mcp.discoverTools({
        botId,
        spaceId: scope.spaceId,
        userId: scope.userId,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      });
    try {
      expect((await listed(first.id)).map((entry) => entry.name)).toContain(
        `mcp__${server.slug}__synthetic_read`,
      );
      expect(await rpc(app, cookie, "integrations/available", { botId: first.id })).toEqual([
        { id: server.id, name: "Fixture connection" },
      ]);
      await rpc(app, cookie, "integrations/assign", {
        connectionId: server.id,
        toolIds: [tool.name],
        overrides: [{ botId: first.id, access: "none", toolIds: [] }],
      });
      expect(await listed(first.id)).toEqual([]);
      expect(await rpc(app, cookie, "integrations/available", { botId: first.id })).toEqual([]);
      expect((await listed(second.id)).map((entry) => entry.route?.resourceId)).toContain(
        server.id,
      );
      await rpc(app, cookie, "integrations/assign", {
        connectionId: server.id,
        toolIds: [tool.name],
        overrides: [],
      });
      await prisma.mcpServer.update({
        where: { id: server.id },
        data: { needsReview: true, spaceAllowedTools: [], revision: { increment: 1 } },
      });
      expect(await listed(second.id)).toEqual([]);
      await rpc(app, cookie, "integrations/assign", {
        connectionId: server.id,
        toolIds: [tool.name],
        overrides: [],
      });
      expect(await listed(first.id)).toEqual([]);
      expect((await listed(second.id)).map((entry) => entry.route?.resourceId)).toContain(
        server.id,
      );
      const third = await rpc<Bot>(app, cookie, "bots/create", {
        name: "Later",
        title: "Later",
        description: "Fixture",
        instructions: "",
      });
      expect((await listed(third.id)).map((entry) => entry.route?.resourceId)).toContain(server.id);
      expect(await listed(outsider.id, await rpc<Me>(app, otherCookie, "me"))).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  it("keeps a custom MCP override below the space Block after a partial update", async () => {
    const cookie = await signup(app, `custom-ceiling-${stamp}@ardurbot.test`, "Workspace");
    const owner = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Worker",
      title: "Worker",
      description: "Fixture",
      instructions: "",
    });
    const tools = ["synthetic_read_a", "synthetic_read_b"].map((name) => ({
      name,
      description: "Read a fixture",
      inputSchema: { type: "object" },
    }));
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        slug: `custom-${stamp}`,
        name: "Fixture connection",
        transport: "streamable_http",
        endpoint: "https://example.test/mcp",
        enabled: true,
        connectionState: "connected",
        manifest: captureIntegrationManifest(tools, "fixture"),
        spaceAllowedTools: tools.map((tool) => tool.name),
      },
    });
    await rpc(app, cookie, "mcp/servers/permissions", {
      serverId: server.id,
      toolIds: tools.map((tool) => tool.name),
      overrides: [{ botId: bot.id, access: "custom", toolIds: tools.map((tool) => tool.name) }],
    });
    const mcp = new McpConnector(prisma, {} as never);
    (
      mcp as unknown as {
        sessionFor: () => Promise<{ listTools: () => Promise<{ tools: typeof tools }> }>;
      }
    ).sessionFor = async () => ({ listTools: async () => ({ tools }) });
    const context = {
      botId: bot.id,
      spaceId: owner.spaceId,
      userId: owner.userId,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    };
    try {
      expect((await mcp.discoverTools(context)).map((tool) => tool.route?.toolName)).toContain(
        tools[1]!.name,
      );
      await rpc(app, cookie, "mcp/servers/permissions", {
        serverId: server.id,
        toolIds: [tools[0]!.name],
        overrides: [],
      });
      const current = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(
        (
          await prisma.botMcpServer.findFirstOrThrow({
            where: { botId: bot.id, serverId: server.id },
          })
        ).allowedTools,
      ).toEqual(tools.map((tool) => tool.name));
      expect((await mcp.discoverTools(context)).map((tool) => tool.route?.toolName)).toEqual([
        tools[0]!.name,
      ]);
      const route = {
        connectorId: "mcp" as const,
        resourceId: server.id,
        resourceRevision: current.revision,
        toolName: tools[1]!.name,
      };
      const events = [];
      for await (const event of mcp.execute(
        { tool: `mcp__${server.slug}__${tools[1]!.name}`, args: {}, executionId: "blocked", route },
        context,
      ))
        events.push(event);
      expect(events).toMatchObject([{ type: "error" }]);
      expect(await integrationApprovalForCall(prisma, route, context, {})).toBe("disabled");
    } finally {
      await mcp.close();
    }
  });

  it("admits and executes an inherited integration call through delegation", async () => {
    const cookie = await signup(app, `inherited-delegation-${stamp}@ardurbot.test`, "Workspace");
    const owner = await rpc<Me>(app, cookie, "me");
    const requester = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Requester",
      title: "Requester",
      description: "Fixture",
      instructions: "",
    });
    const worker = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Worker",
      title: "Worker",
      description: "Fixture",
      instructions: "",
    });
    const tool = {
      name: "synthetic_read",
      description: "Read a fixture",
      inputSchema: { type: "object" },
    };
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        slug: `delegation-${stamp}`,
        name: "Fixture connection",
        transport: "streamable_http",
        endpoint: "https://example.test/mcp",
        catalogId: "github",
        enabled: true,
        connectionState: "connected",
        manifest: captureIntegrationManifest([tool], "fixture"),
        spaceAllowedTools: [tool.name],
      },
    });
    expect(await prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
    const completed = await sendAndWait(app, cookie, requester.id, "Read the fixture");
    const pin: DelegationSnapshot["pin"] = {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "fixture",
      effort: "off",
      credentialId: "fixture",
      revision: 1,
    };
    const parent = await prisma.run.update({
      where: { id: completed.run.id },
      data: { status: "running", runtimePin: pin },
    });
    const recipient = await prisma.bot.findUniqueOrThrow({
      where: { id: worker.id },
      include: { computer: true },
    });
    const snapshot: DelegationSnapshot = {
      pin,
      computer: {
        id: recipient.computerId,
        mode: recipient.computer?.scope === "dedicated" ? "dedicated" : "team",
        kind: recipient.computer?.kind ?? null,
      },
      destination: { host: null, local: false },
    };
    const handoff = await prisma.$transaction((tx) =>
      admitDelegation(tx, {
        spaceId: owner.spaceId,
        userId: owner.userId,
        parentRunId: parent.id,
        actingBotId: worker.id,
        actingName: "Worker",
        kind: "message",
        admissionKey: `inherited-${stamp}`,
        prompt: "Read the fixture",
        snapshot,
      }),
    );
    expect((handoff.authority as { connectors: string[] }).connectors).toContain(
      `mcp:${server.id}:${tool.name}`,
    );
    await prisma.delegation.update({ where: { id: handoff.id }, data: { status: "running" } });
    const run = await prisma.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: worker.id,
        threadId: parent.threadId,
        taskId: parent.taskId,
        status: "running",
        trigger: "delegation",
        delegationId: handoff.id,
        delegationRootTaskId: parent.taskId,
        runtimePin: pin,
      },
    });
    const route = {
      connectorId: "mcp" as const,
      resourceId: server.id,
      resourceRevision: server.revision,
      toolName: tool.name,
    };
    expect(await checkDelegationExecution(prisma, run.id, "read_file", route)).toBeUndefined();
    const mcp = new McpConnector(prisma, {} as never);
    (
      mcp as unknown as {
        sessionFor: () => Promise<{
          listTools: () => Promise<{ tools: (typeof tool)[] }>;
          callTool: () => Promise<{ content: { type: string; text: string }[] }>;
        }>;
      }
    ).sessionFor = async () => ({
      listTools: async () => ({ tools: [tool] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    try {
      const context = {
        botId: worker.id,
        spaceId: owner.spaceId,
        userId: owner.userId,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      };
      const events = [];
      for await (const event of mcp.execute(
        { tool: `mcp__${server.slug}__${tool.name}`, args: {}, executionId: "delegated", route },
        context,
      ))
        events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
    } finally {
      await mcp.close();
    }
  });

  it("computer updates preserve the workspace and reserve the shared computer until completion", async () => {
    const cookie = await signup(app, `maintenance-${stamp}@ardurbot.test`, "Maintenance");
    const outsider = await signup(
      app,
      `maintenance-other-${stamp}@ardurbot.test`,
      "Other workspace",
    );
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "Writer",
      description: "Writes files",
      instructions: "Write files.",
    });
    await waitForDatabase(
      async () =>
        (await prisma.run.count({
          where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        })) === 0,
    );
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    const original = await prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    });
    const ctx = {
      operationId: "fixture",
      traceId: "fixture",
      spaceId: original.spaceId,
      userId: original.userId,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    await sandbox.writeFile(
      toComputerRef(original.computer!),
      { path: "notes.txt", content: new TextEncoder().encode("durable work") },
      ctx,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A computer router (ConnectedSandboxProvider here) dispatches every operation on an
    // existing computer to the provider owningSandbox resolves, not to itself; spying on the
    // router would never see the checkpoint or destroy calls replaceComputer makes on it.
    const owner = await owningSandbox(sandbox, original.computer!, ctx);
    const destroyed = vi.spyOn(owner, "destroy");
    const exportWorkspace = owner.exportWorkspace.bind(owner);
    const spy = vi
      .spyOn(owner, "exportWorkspace")
      .mockImplementation(async function* (ref, context) {
        await gate;
        yield* exportWorkspace(ref, context);
      });
    try {
      const update = await rpc<{ id: string }>(app, cookie, "computer/update", { botId: bot.id });
      await waitForDatabase(
        async () =>
          (await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } })).stage ===
          "saving",
      );
      expect(await rpc(app, outsider, "computer/updates")).toEqual([]);
      const duplicate = await app.request("/rpc/computer/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ json: { botId: bot.id } }),
      });
      expect(duplicate.status).toBe(409);
      const stopped = await app.request("/rpc/computer/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ json: { botId: bot.id } }),
      });
      expect(stopped.status).toBe(409);
      const switched = await app.request("/rpc/bots/setComputer", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ json: { botId: bot.id, mode: "dedicated" } }),
      });
      expect(switched.status).toBe(409);
      release();
      await waitForDatabase(
        async () =>
          (await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } })).status ===
          "completed",
      );
      const replacement = await prisma.computer.findUniqueOrThrow({
        where: { id: original.computerId! },
      });
      expect(replacement.maintenanceId).toBeNull();
      expect(destroyed).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: original.computer!.providerRef }),
        expect.anything(),
      );
      expect(
        new TextDecoder().decode(
          await sandbox.readFile(toComputerRef(replacement), "notes.txt", ctx),
        ),
      ).toBe("durable work");
    } finally {
      release();
      spy.mockRestore();
      destroyed.mockRestore();
    }
  });

  it("1+2: users are isolated and workspace bots share the Team Computer", async () => {
    const ada = await signup(app, `ada-j-${stamp}@ardurbot.test`, "Ada Journey");
    const bob = await signup(app, `bob-j-${stamp}@ardurbot.test`, "Bob Journey");

    const adaMe = await rpc<Me>(app, ada, "me");
    const bobMe = await rpc<Me>(app, bob, "me");
    expect(adaMe.spaceId).not.toBe(bobMe.spaceId);

    const chief = await rpc<Bot>(app, ada, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Keeps work moving",
      instructions: "",
      notifyOnFinish: true,
    });
    const coder = await rpc<Bot>(app, ada, "bots/create", {
      name: "Coder",
      title: "Engineer",
      description: "Writes code",
      instructions: "",
      notifyOnFinish: true,
    });
    const bobBot = await rpc<Bot>(app, bob, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Bob's bot",
      instructions: "",
      notifyOnFinish: true,
    });
    const [chiefRecord, coderRecord, bobRecord] = await Promise.all(
      [chief.id, coder.id, bobBot.id].map((id) =>
        prisma.bot.findUniqueOrThrow({ where: { id }, include: { computer: true } }),
      ),
    );
    expect(chief.computerMode).toBe("team");
    expect(coder.computerMode).toBe("team");
    expect(chiefRecord.computerId).toBe(coderRecord.computerId);
    expect(chiefRecord.computerId).not.toBe(bobRecord.computerId);

    const bobList = await rpc<Bot[]>(app, bob, "bots/list");
    expect(bobList.map((b) => b.id)).not.toContain(chief.id);
    const forbidden = await raw(app, bob, "bots/get", { botId: chief.id });
    expect(forbidden.status).toBeGreaterThanOrEqual(400);

    const pinned = await rpc<Bot>(app, ada, "bots/update", { botId: coder.id, pinned: true });
    expect(pinned.pinned).toBe(true);
    const [section, concurrentSection] = await Promise.all([
      rpc<{ id: string; name: string }>(app, ada, "botSections/create", {
        botId: chief.id,
        name: "Planning",
      }),
      rpc<{ id: string; name: string }>(app, ada, "botSections/create", {
        botId: coder.id,
        name: "Planning",
      }),
    ]);
    expect(section.name).toBe("Planning");
    expect(concurrentSection.id).toBe(section.id);
    expect(await rpc<Array<{ id: string }>>(app, ada, "botSections/list")).toEqual([
      expect.objectContaining({ id: section.id }),
    ]);
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.sectionId,
    ).toBe(section.id);
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === coder.id)?.sectionId,
    ).toBe(section.id);
    const foreignSection = await raw(app, bob, "bots/update", {
      botId: bobBot.id,
      sectionId: section.id,
    });
    expect(foreignSection.status).toBeGreaterThanOrEqual(400);
    expect(await rpc<unknown[]>(app, bob, "botSections/list")).toEqual([]);
    const renamed = await rpc<{ id: string; name: string }>(app, ada, "botSections/update", {
      sectionId: section.id,
      name: "Delivery",
    });
    expect(renamed).toMatchObject({ id: section.id, name: "Delivery" });
    expect(await rpc<Array<{ id: string; name: string }>>(app, ada, "botSections/list")).toEqual([
      expect.objectContaining({ id: section.id, name: "Delivery" }),
    ]);
    await rpc<{ id: string; name: string }>(app, ada, "botSections/create", {
      botId: coder.id,
      name: "Archive",
    });
    const renameClash = await raw(app, ada, "botSections/update", {
      sectionId: section.id,
      name: "Archive",
    });
    expect(renameClash.status).toBe(409);
    const foreignRename = await raw(app, bob, "botSections/update", {
      sectionId: section.id,
      name: "Stolen",
    });
    expect(foreignRename.status).toBeGreaterThanOrEqual(400);
    expect(await rpc<Array<{ id: string; name: string }>>(app, ada, "botSections/list")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: section.id, name: "Delivery" })]),
    );
    const duplicate = await rpc<Bot>(app, ada, "bots/duplicate", { botId: chief.id });
    expect(duplicate).toMatchObject({
      name: "Chief copy",
      title: chief.title,
      description: chief.description,
      instructions: chief.instructions,
      notifyOnFinish: chief.notifyOnFinish,
      color: chief.color,
      pinned: false,
      sectionId: null,
      unread: false,
    });
    expect(duplicate.id).not.toBe(chief.id);
    expect((await rpc<Bot[]>(app, ada, "bots/list"))[0]?.id).toBe(coder.id);

    await sendAndWait(
      app,
      ada,
      chief.id,
      "write a file in your home called notes/result.txt that says isolation-ok",
    );
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.unread,
    ).toBe(true);
    await rpc(app, ada, "threads/markRead", { botId: chief.id });
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.unread,
    ).toBe(false);
    await rpc(app, ada, "threads/markUnread", { botId: chief.id });
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.unread,
    ).toBe(true);
    await sendAndWait(app, ada, coder.id, "remember that coder prefers rust");

    const chiefFile = await rpc<{ path: string; content: string }>(app, ada, "computer/readFile", {
      botId: chief.id,
      path: "notes/result.txt",
    });
    expect(chiefFile.content).toContain("isolation-ok");
    const computer = await rpc<{ state: string }>(app, ada, "computer/status", { botId: chief.id });
    expect(computer.state).toBe("running");
    await rpc(app, ada, "computer/stop", { botId: chief.id });
    const persisted = await rpc<{ content: string }>(app, ada, "computer/readFile", {
      botId: chief.id,
      path: "notes/result.txt",
    });
    expect(persisted.content).toContain("isolation-ok");
    const coderMem = await rpc<MemoryPage>(app, ada, "memory/list", {
      botId: coder.id,
    });
    expect(coderMem.items.some((m) => m.content.toLowerCase().includes("rust"))).toBe(true);
    const dedicated = await rpc<Bot>(app, ada, "bots/setComputer", {
      botId: coder.id,
      mode: "dedicated",
    });
    expect(dedicated.computerMode).toBe("dedicated");
    const dedicatedRecord = await prisma.bot.findUniqueOrThrow({
      where: { id: coder.id },
      include: { computer: true },
    });
    expect(dedicatedRecord.computerId).not.toBe(chiefRecord.computerId);
    await rpc<Bot>(app, ada, "bots/setComputer", { botId: coder.id, mode: "team" });
    const backOnTeam = await prisma.bot.findUniqueOrThrow({ where: { id: coder.id } });
    expect(backOnTeam.computerId).toBe(chiefRecord.computerId);
    await rpc<Bot>(app, ada, "bots/setComputer", { botId: coder.id, mode: "dedicated" });
    const reusedDedicated = await prisma.bot.findUniqueOrThrow({ where: { id: coder.id } });
    expect(reusedDedicated.computerId).toBe(dedicatedRecord.computerId);
    expect(bobBot.id).not.toBe(chief.id);
  });

  it("clears a conversation without removing the bot, computer, memory, or routines", async () => {
    const cookie = await signup(app, `clear-j-${stamp}@ardurbot.test`, "Clear Journey");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Keeper",
      title: "Keeps its setup",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says kept-after-clear",
    );
    const memories = await rpc<MemoryPage>(app, cookie, "memory/list", {
      botId: bot.id,
    });
    await rpc(app, cookie, "memory/update", {
      documentId: memories.items[0]!.id,
      expectedRevision: memories.items[0]!.revision,
      content: "# Keeper\n\nRemember this after clearing.",
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Kept routine",
      prompt: "Check in",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "queued before clear",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        historyCompactedUpToSeq: 0,
        historyCompactionSummary: "summary that must be invalidated",
        historyCompactionGeneration: 3,
      },
    });

    await rpc(app, cookie, "threads/clear", { botId: bot.id });

    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(snap.messages).toEqual([]);
    expect(snap.run).toBeNull();
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.event.findMany({ where: { threadId: thread.id } })).toMatchObject([
      { type: "thread.cleared" },
    ]);
    // The deleted messages all count as compacted, so compaction cannot summarize them and
    // recall cannot treat the fresh conversation as having uncompacted history.
    const clearedThread = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(clearedThread.historyCompactedUpToSeq).toBe(clearedThread.nextMessageSeq - 1);
    expect(clearedThread.historyCompactionSummary).toBeNull();
    expect(clearedThread.historyCompactionGeneration).toBe(4);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      (await rpc<Bot[]>(app, cookie, "bots/list")).find((item) => item.id === bot.id),
    ).toMatchObject({
      preview: "",
      unread: false,
    });
    expect(
      await rpc(app, cookie, "computer/readFile", { botId: bot.id, path: "notes/result.txt" }),
    ).toMatchObject({ content: expect.stringContaining("kept-after-clear") });
    expect((await rpc<MemoryPage>(app, cookie, "memory/list", { botId: bot.id })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("Remember this") }),
      ]),
    );
    expect(await rpc(app, cookie, "routines/list", { botId: bot.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: routine.id })]),
    );

    await expect(
      appendEvent(prisma, {
        spaceId: thread.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "thread.progress",
        runId: run.id,
        payload: { text: "stale output after clear" },
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    await expect(
      createThreadMessage(prisma, {
        threadId: thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "stale output after clear" }],
        runId: run.id,
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.event.findMany({ where: { threadId: thread.id } })).toMatchObject([
      { type: "thread.cleared" },
    ]);

    const after = await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/after-clear.txt that says hello-after-clear",
    );
    expect(after.messages.length).toBeGreaterThan(0);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBeGreaterThan(0);
  });

  it("starts a new chat without sending retained history to the next turn", async () => {
    const cookie = await signup(app, `restart-j-${stamp}@ardurbot.test`, "Restart Journey");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Fresh Start",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const earlierTurn = "EARLIER_CHAT_BOUNDARY_SENTINEL";
    const newTurn = "NEW_CHAT_TURN_SENTINEL";
    await sendAndWait(app, cookie, bot.id, earlierTurn);
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });

    await rpc(app, cookie, "threads/restart", { botId: bot.id });

    const reset = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(reset.historyCompactionSummary).toBe(`${RECEIPT_FILTERED_SUMMARY_MARKER}New chat.`);
    expect(reset.historyCompactedUpToSeq).toBe(reset.nextMessageSeq - 1);
    // Recreate the committed state left by a restart before summaries gained a marker.
    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        historyCompactedUpToSeq: reset.historyCompactedUpToSeq,
        historyCompactionSummary: LEGACY_RESTART_SUMMARY,
      },
    });
    const requests = new Map<string, { prompt: string; history: Array<{ content: string }> }>();
    const originalRun = ScriptedAgentRuntime.prototype.run;
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) => {
        requests.set(request.runId, { prompt: request.prompt, history: request.history });
        return originalRun.call(new ScriptedAgentRuntime(), request, context);
      });
    let after: Awaited<ReturnType<typeof sendAndWait>>;
    try {
      after = await sendAndWait(app, cookie, bot.id, newTurn);
    } finally {
      runtimeSpy.mockRestore();
    }

    const runtimeRequest = requests.get(after.run.id);
    expect(runtimeRequest).toBeDefined();
    expect(runtimeRequest!.history.map((message) => message.content)).toEqual([
      "<thread_summary>\nNew chat.\n</thread_summary>",
    ]);
    expect(runtimeRequest!.prompt).toContain(newTurn);
    expect(runtimeRequest!.prompt).not.toContain(earlierTurn);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBeGreaterThan(1);
    const afterThread = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(afterThread.historyCompactedUpToSeq).toBe(reset.historyCompactedUpToSeq);
    expect(afterThread.historyCompactionSummary).toBe(LEGACY_RESTART_SUMMARY);
  });

  it("2b: two Team bots send at once on distinct screens", async () => {
    const cookie = await signup(app, `parallel-j-${stamp}@ardurbot.test`, "Parallel");
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const [writerSnap, researcherSnap] = await Promise.all([
      sendAndWait(app, cookie, writer.id, "observe your screen and type writer-desk"),
      sendAndWait(app, cookie, researcher.id, "observe your screen and type researcher-desk"),
    ]);
    expect(writerSnap.run?.status).toBe("completed");
    expect(researcherSnap.run?.status).toBe("completed");
    expect(
      (
        await rpc<{ busyBotName: string | null }>(app, cookie, "computer/status", {
          botId: writer.id,
        })
      ).busyBotName,
    ).toBeNull();
    expect(
      (
        await rpc<{ busyBotName: string | null }>(app, cookie, "computer/status", {
          botId: researcher.id,
        })
      ).busyBotName,
    ).toBeNull();
    const writerScreen = await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", {
      botId: writer.id,
    });
    const researcherScreen = await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", {
      botId: researcher.id,
    });
    expect(writerScreen.url).toContain(writer.id);
    expect(researcherScreen.url).toContain(researcher.id);
    expect(writerScreen.url).not.toBe(researcherScreen.url);
  });

  it("3: disconnect and reconnect from a cursor reconstructs the thread", async () => {
    const cookie = await signup(app, `cursor-j-${stamp}@ardurbot.test`, "Cursor");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says reconnect-ok",
    );
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(snap.messages.map((m) => m.seq)).toEqual(
      [...snap.messages].map((m) => m.seq).sort((a, b) => a - b),
    );
    expect(snap.messages.some((m) => JSON.stringify(m.blocks).includes("reconnect-ok"))).toBe(true);
    const again = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(again.messages.length).toBe(snap.messages.length);
  });

  it("4: takeover login then resume without exposing credentials", async () => {
    const cookie = await signup(app, `takeover-j-${stamp}@ardurbot.test`, "Takeover");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "install the gsc cli and sign in",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_takeover",
    );
    expect(JSON.stringify(waiting.messages)).not.toMatch(/password|secret|token/i);
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    await rpc(app, cookie, "computer/release", { botId: bot.id });
    const done = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/signed in|session/);
    expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");

    const releaseEvents = await prisma.event.count({
      where: { botId: bot.id, type: "computer.takeover.released" },
    });
    await rpc(app, cookie, "computer/release", { botId: bot.id });
    expect(
      await prisma.event.count({
        where: { botId: bot.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEvents);
  });

  it("4d: skipping takeover resumes without treating login as done", async () => {
    const cookie = await signup(app, `takeover-skip-j-${stamp}@ardurbot.test`, "Skip Takeover");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "install the gsc cli and sign in",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_takeover",
    );
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    await rpc(app, cookie, "computer/release", { botId: bot.id, reason: "skipped" });
    const done = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/skipped/);
    expect(JSON.stringify(done.messages).toLowerCase()).not.toMatch(/signed in/);
    expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");
    const released = await prisma.event.findFirst({
      where: { botId: bot.id, type: "computer.takeover.released" },
      orderBy: { createdAt: "desc" },
    });
    expect(released).toMatchObject({
      runId: waiting.run?.id,
      payload: { reason: "skipped" },
    });
  });

  it("4b: an expired takeover denies input and reconciles API and database state", async () => {
    const previousTakeoverTtl = process.env.COMPUTER_TAKEOVER_TTL_MS;
    process.env.COMPUTER_TAKEOVER_TTL_MS = "1000";
    try {
      const cookie = await signup(app, `takeover-expiry-j-${stamp}@ardurbot.test`, "Expiry");
      const bot = await rpc<Bot>(app, cookie, "bots/create", {
        name: "Chief",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      await rpc(app, cookie, "threads/send", {
        botId: bot.id,
        text: "install the gsc cli and sign in",
      });
      const waiting = await waitFor(
        app,
        cookie,
        bot.id,
        (snap) => snap.run?.status === "waiting_takeover",
      );
      await rpc(app, cookie, "computer/boot", { botId: bot.id });
      const lease = await rpc<{ leaseId: string; expiresAt: string }>(
        app,
        cookie,
        "computer/takeover",
        { botId: bot.id },
      );
      expect(new Date(lease.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(1000);
      expect(
        (await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", { botId: bot.id }))
          .url,
      ).toContain("view_only=false");
      await rpc(app, cookie, "computer/input", {
        botId: bot.id,
        kind: "key",
        payload: { key: "a" },
      });

      await waitForDatabase(async () => {
        const storedBot = await prisma.bot.findUniqueOrThrow({
          where: { id: bot.id },
          include: { computer: true },
        });
        const computer = storedBot.computer!;
        return computer.controlLeaseId === null && computer.controlHolder === "none";
      });

      expect(
        (await rpc<{ controlHolder: string }>(app, cookie, "computer/status", { botId: bot.id }))
          .controlHolder,
      ).toBe("none");
      expect(
        (await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", { botId: bot.id }))
          .url,
      ).toContain("view_only=true");
      expect(
        (
          await raw(app, cookie, "computer/input", {
            botId: bot.id,
            kind: "key",
            payload: { key: "b" },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const done = await waitFor(
        app,
        cookie,
        bot.id,
        (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
      );
      expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/skipped/);
      expect(JSON.stringify(done.messages).toLowerCase()).not.toMatch(/signed in/);
      expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");
      expect(
        await prisma.event.findFirst({
          where: { runId: waiting.run?.id, type: "computer.takeover.released" },
          orderBy: { createdAt: "desc" },
        }),
      ).toMatchObject({ payload: { reason: "expired" } });
    } finally {
      if (previousTakeoverTtl === undefined) delete process.env.COMPUTER_TAKEOVER_TTL_MS;
      else process.env.COMPUTER_TAKEOVER_TTL_MS = previousTakeoverTtl;
    }
  });

  it("4c: a takeover authorizes input only on the controlled bot screen", async () => {
    const cookie = await signup(app, `takeover-scope-j-${stamp}@ardurbot.test`, "Takeover Scope");
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    await rpc(app, cookie, "computer/boot", { botId: writer.id });
    await rpc(app, cookie, "computer/takeover", { botId: writer.id });
    expect(
      (
        await raw(app, cookie, "computer/input", {
          botId: researcher.id,
          kind: "key",
          payload: { key: "A" },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    await rpc(app, cookie, "computer/release", { botId: writer.id });
  });

  it("4d: a stale Team release cannot clear a newer bot takeover", async () => {
    const cookie = await signup(
      app,
      `takeover-release-fence-j-${stamp}@ardurbot.test`,
      "Release Fence",
    );
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    await rpc(app, cookie, "computer/boot", { botId: writer.id });
    await rpc(app, cookie, "threads/send", {
      botId: researcher.id,
      text: "install the gsc cli and sign in",
    });
    await waitFor(app, cookie, researcher.id, (snap) => snap.run?.status === "waiting_takeover");

    const writerLease = await rpc<{ leaseId: string; expiresAt: string }>(
      app,
      cookie,
      "computer/takeover",
      { botId: writer.id },
    );
    const releaseEventsBefore = await prisma.event.count({
      where: { botId: researcher.id, type: "computer.takeover.released" },
    });

    const originalSetScreenControl = sandbox.setScreenControl;
    let signalReleaseRevocation!: () => void;
    let allowReleaseRevocation!: () => void;
    const releaseRevocationReached = new Promise<void>((resolve) => {
      signalReleaseRevocation = resolve;
    });
    const releaseRevocationAllowed = new Promise<void>((resolve) => {
      allowReleaseRevocation = resolve;
    });
    const revokedLeases: string[] = [];
    sandbox.setScreenControl = async (_computer, interactive, context, controlToken) => {
      expect(interactive).toBe(false);
      revokedLeases.push(controlToken ?? "");
      if (revokedLeases.length !== 1) return;
      expect(context.botId).toBe(writer.id);
      expect(controlToken).toBe(writerLease.leaseId);
      signalReleaseRevocation();
      await releaseRevocationAllowed;
    };

    let staleRelease: Promise<{ ok: true }> | undefined;
    let researcherLease!: { leaseId: string; expiresAt: string };
    try {
      // Provider cleanup leaves a fencing tombstone: a replacement cannot take
      // control until revocation finishes, even though the holder is already none.
      staleRelease = rpc<{ ok: true }>(app, cookie, "computer/release", { botId: writer.id });
      await releaseRevocationReached;
      expect((await raw(app, cookie, "computer/takeover", { botId: researcher.id })).status).toBe(
        409,
      );
      allowReleaseRevocation();
      await staleRelease;
      researcherLease = await rpc<{ leaseId: string; expiresAt: string }>(
        app,
        cookie,
        "computer/takeover",
        { botId: researcher.id },
      );
    } finally {
      allowReleaseRevocation();
      await staleRelease?.catch(() => undefined);
      sandbox.setScreenControl = originalSetScreenControl;
    }

    expect(researcherLease.leaseId).not.toBe(writerLease.leaseId);
    expect(revokedLeases).toEqual([writerLease.leaseId]);

    const writerRecord = await prisma.bot.findUniqueOrThrow({
      where: { id: writer.id },
      include: { computer: true },
    });
    const researcherRecord = await prisma.bot.findUniqueOrThrow({
      where: { id: researcher.id },
      include: { computer: true },
    });
    const computerId = writerRecord.computer!.id;
    expect(researcherRecord.computer!.id).toBe(computerId);
    // A delayed finalization of the old lease must still lose its database CAS
    // after a new owner has been admitted.
    await expect(
      createThreadEvents(prisma).finalizeComputerControlRelease({
        spaceId: writerRecord.spaceId,
        computerId,
        botId: writer.id,
        runId: null,
        leaseId: writerLease.leaseId,
        holder: "bot",
        reason: "released",
      }),
    ).resolves.toBe(false);
    const afterStaleRelease = await prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(afterStaleRelease.controlHolder).toBe("user");
    expect(afterStaleRelease.controlBotId).toBe(researcher.id);
    expect(afterStaleRelease.controlLeaseId).toBe(researcherLease.leaseId);
    expect(afterStaleRelease.controlLeaseExpiresAt?.toISOString()).toBe(researcherLease.expiresAt);
    expect(
      await prisma.event.count({
        where: { botId: researcher.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEventsBefore);
    expect(
      (
        await prisma.run.findFirstOrThrow({
          where: { botId: researcher.id, status: "waiting_takeover" },
        })
      ).status,
    ).toBe("waiting_takeover");

    await rpc(app, cookie, "computer/release", { botId: researcher.id });
    const afterOwnerRelease = await prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(afterOwnerRelease).toMatchObject({
      controlHolder: "bot",
      controlBotId: null,
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    });
    await waitFor(
      app,
      cookie,
      researcher.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(
      await prisma.event.count({
        where: { botId: researcher.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEventsBefore + 1);
    const releaseEvent = await prisma.event.findFirstOrThrow({
      where: { botId: researcher.id, type: "computer.takeover.released" },
      orderBy: { seq: "desc" },
    });
    expect(releaseEvent.payload).toMatchObject({
      holder: "bot",
      leaseId: researcherLease.leaseId,
      reason: "released",
    });

    await rpc(app, cookie, "computer/release", { botId: researcher.id });
    expect(
      await prisma.event.count({
        where: { botId: researcher.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEventsBefore + 1);
  });

  it("4e: concurrent Team takeovers never return another bot's lease", async () => {
    const cookie = await signup(
      app,
      `takeover-owner-race-j-${stamp}@ardurbot.test`,
      "Takeover Owner Race",
    );
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const analyst = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Analyst",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    await rpc(app, cookie, "computer/boot", { botId: writer.id });
    const writerLease = await rpc<{ leaseId: string }>(app, cookie, "computer/takeover", {
      botId: writer.id,
    });

    const originalSetScreenControl = sandbox.setScreenControl;
    let revocations = 0;
    let signalRevocation!: () => void;
    let releaseRevocations!: () => void;
    const revocationReached = new Promise<void>((resolve) => {
      signalRevocation = resolve;
    });
    const revocationAllowed = new Promise<void>((resolve) => {
      releaseRevocations = resolve;
    });
    sandbox.setScreenControl = async (_computer, interactive, _context, controlToken) => {
      expect(interactive).toBe(false);
      expect(controlToken).toBe(writerLease.leaseId);
      revocations += 1;
      signalRevocation();
      await revocationAllowed;
    };

    let responses: Response[] = [];
    let firstTakeover: Promise<Response> | undefined;
    try {
      firstTakeover = raw(app, cookie, "computer/takeover", { botId: researcher.id });
      await revocationReached;
      // Admission rejects the competing request before a second provider revoke.
      const competing = await raw(app, cookie, "computer/takeover", { botId: analyst.id });
      expect(competing.status).toBe(409);
      releaseRevocations();
      responses = [await firstTakeover, competing];
    } finally {
      releaseRevocations();
      await firstTakeover?.catch(() => undefined);
      sandbox.setScreenControl = originalSetScreenControl;
    }

    expect(revocations).toBe(1);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const computer = await prisma.computer.findFirstOrThrow({
      where: { bots: { some: { id: writer.id } } },
      select: { controlBotId: true, controlLeaseId: true },
    });
    const winner = computer.controlBotId === researcher.id ? researcher : analyst;
    expect(winner.id).toBe(researcher.id);
    const successfulResponse = responses.find((response) => response.status === 200)!;
    await expect(successfulResponse.clone().json()).resolves.toMatchObject({
      json: { leaseId: computer.controlLeaseId },
    });

    await rpc(app, cookie, "computer/release", { botId: winner.id });
  });

  it("5: a routine wakes the bot and posts into the existing thread", async () => {
    const cookie = await signup(app, `routine-j-${stamp}@ardurbot.test`, "Routine");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string; nextRunAt: string | null }>(
      app,
      cookie,
      "routines/create",
      {
        botId: bot.id,
        name: "Monday briefing",
        prompt: "write a file in your home called notes/result.txt that says routine-ok",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        notify: true,
        active: true,
      },
    );
    expect(routine.nextRunAt).toBeTruthy();
    const dueAt = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: routine.id },
      data: { nextRunAt: dueAt },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
    });
    const snap = await waitFor(app, cookie, bot.id, (s) =>
      s.messages.some(
        (m) =>
          JSON.stringify(m.blocks).includes("routine-ok") ||
          JSON.stringify(m.blocks).includes("writing"),
      ),
    );
    expect(snap.messages.length).toBeGreaterThan(0);
    const routineRuns = await prisma.run.count({
      where: { botId: bot.id, trigger: "routine" },
    });
    expect(routineRuns).toBe(1);
    const advanced = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(advanced.nextRunAt?.getTime()).toBeGreaterThan(dueAt.getTime());

    const legacyRunsBefore = await prisma.run.count({
      where: { botId: bot.id, trigger: "routine" },
    });
    const legacyDueAt = new Date(Date.now() - 1_000);
    const legacy = await prisma.routine.create({
      data: {
        spaceId: advanced.spaceId,
        userId: advanced.userId,
        botId: bot.id,
        name: "Legacy schedule",
        prompt: "Run the legacy schedule once",
        crons: ["0 0 9 * * *"],
        timezone: "UTC",
        notify: false,
        active: true,
        nextRunAt: legacyDueAt,
      },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: legacy.id, scheduledFor: legacyDueAt.toISOString() },
    });
    await waitForDatabase(async () => {
      const stored = await prisma.routine.findUnique({ where: { id: legacy.id } });
      return stored?.active === false && stored.nextRunAt === null;
    });
    expect(await prisma.run.count({ where: { botId: bot.id, trigger: "routine" } })).toBe(
      legacyRunsBefore + 1,
    );
  });

  it("5b: tool-created schedules wake in the creating group or 1:1 thread", async () => {
    const cookie = await signup(app, `schedule-dest-j-${stamp}@ardurbot.test`, "Schedule Dest");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Scheduler",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const peer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Peer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const dmThread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Schedule room",
      botIds: [bot.id, peer.id],
    });
    const events = createThreadEvents(prisma);
    const scheduleDeps = { prisma, events, jobs };

    const groupCreated = await createScheduleFromTool(scheduleDeps, {
      spaceId: me.spaceId,
      botId: bot.id,
      userId: me.userId,
      threadId: group.threadId,
      name: "Group ping",
      prompt: "say group-reminder-ok",
      schedule: { delaySeconds: 30 },
    });
    expect(groupCreated).toMatchObject({ ok: true });
    if (!("ok" in groupCreated) || !groupCreated.ok)
      throw new Error("group schedule create failed");
    const groupRoutine = await prisma.routine.findUniqueOrThrow({
      where: { id: groupCreated.routineId },
    });
    expect(groupRoutine.threadId).toBe(group.threadId);
    expect(groupRoutine.crons).toEqual([ONCE_ROUTINE_CRON]);

    const groupDueAt = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: groupRoutine.id },
      data: { nextRunAt: groupDueAt },
    });
    await executor.wakeRoutine(groupRoutine.id, groupDueAt.toISOString());
    await waitForDatabase(async () => {
      const run = await prisma.run.findFirst({
        where: { routineId: groupRoutine.id, trigger: "routine" },
      });
      return run?.threadId === group.threadId;
    });
    const groupRun = await prisma.run.findFirstOrThrow({
      where: { routineId: groupRoutine.id, trigger: "routine" },
    });
    expect(groupRun.threadId).toBe(group.threadId);
    expect(groupRun.threadId).not.toBe(dmThread.id);
    expect(
      await prisma.event.count({
        where: {
          threadId: group.threadId,
          type: "routine.fired",
          runId: groupRun.id,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.event.count({
        where: {
          threadId: dmThread.id,
          type: "routine.fired",
          runId: groupRun.id,
        },
      }),
    ).toBe(0);

    const dmCreated = await createScheduleFromTool(scheduleDeps, {
      spaceId: me.spaceId,
      botId: bot.id,
      userId: me.userId,
      threadId: dmThread.id,
      name: "DM ping",
      prompt: "say dm-reminder-ok",
      schedule: { delaySeconds: 30 },
    });
    expect(dmCreated).toMatchObject({ ok: true });
    if (!("ok" in dmCreated) || !dmCreated.ok) throw new Error("dm schedule create failed");
    const dmRoutine = await prisma.routine.findUniqueOrThrow({
      where: { id: dmCreated.routineId },
    });
    expect(dmRoutine.threadId).toBe(dmThread.id);

    const dmDueAt = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: dmRoutine.id },
      data: { nextRunAt: dmDueAt },
    });
    await executor.wakeRoutine(dmRoutine.id, dmDueAt.toISOString());
    await waitForDatabase(async () => {
      const run = await prisma.run.findFirst({
        where: { routineId: dmRoutine.id, trigger: "routine" },
      });
      return run?.threadId === dmThread.id;
    });
    const dmRun = await prisma.run.findFirstOrThrow({
      where: { routineId: dmRoutine.id, trigger: "routine" },
    });
    expect(dmRun.threadId).toBe(dmThread.id);
    expect(
      await prisma.event.count({
        where: {
          threadId: dmThread.id,
          type: "routine.fired",
          runId: dmRun.id,
        },
      }),
    ).toBe(1);
  });

  it("allocates event and message cursors atomically under concurrent writes", async () => {
    const cookie = await signup(app, `sequence-j-${stamp}@ardurbot.test`, "Sequence");
    const actor = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Sequencer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        appendEvent(prisma, {
          spaceId: actor.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "thread.progress",
          payload: { delta: String(index) },
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        createThreadMessage(prisma, {
          threadId: thread.id,
          role: "system",
          blocks: [{ kind: "meta", text: String(index) }],
        }),
      ),
    );

    const [events, messages] = await Promise.all([
      prisma.event.findMany({ where: { threadId: thread.id }, orderBy: { seq: "asc" } }),
      prisma.message.findMany({ where: { threadId: thread.id }, orderBy: { seq: "asc" } }),
    ]);
    expect(events.map((row) => row.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(messages.map((row) => row.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("6: fake, managed-sandbox emulator, and desktop executor run the same graphical task", async () => {
    const ctx = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const fake = new FakeSandboxProvider();
    const managed = new ManagedSandboxEmulator();
    const desktop = new DesktopSandboxProvider();
    const a = await fake.provision({ botId: "ja", homePath: "/tmp/ja" }, ctx);
    const b = await managed.provision({ botId: "jb", homePath: "/tmp/jb" }, ctx);
    const c = await desktop.provision({ botId: "jc", homePath: "/tmp/jc" }, ctx);
    let out = "";
    for await (const event of fake.execute(a, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    for await (const event of managed.execute(b, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    for await (const event of desktop.execute(c, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    expect(out.match(/same-task/g)?.length).toBe(3);
    await desktop.destroy(c, ctx);
  });

  it("7: destination write is independently inspectable and credentials stay out of the thread", async () => {
    const cookie = await signup(app, `dest-j-${stamp}@ardurbot.test`, "Dest");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = connector.records.length;
    const secret = "test-openrouter-key-not-a-real-secret";
    await rpc(app, cookie, "models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: secret,
      label: "test",
      modelId: "offline-fixture",
    });
    await sendAndWait(app, cookie, bot.id, "write this to the destination crm as a note");
    expect(connector.records.length).toBeGreaterThan(before);
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(JSON.stringify(snap)).not.toContain(secret);
    const inspect = await fetch(`http://127.0.0.1:${connector.port}/records`);
    const records = (await inspect.json()) as unknown[];
    expect(records.length).toBeGreaterThan(0);
  });

  it("8: retrying a completed effect does not duplicate the destination write", async () => {
    const cookie = await signup(app, `crash-j-${stamp}@ardurbot.test`, "Crash");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = connector.records.length;
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note",
    });
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const afterFirst = connector.records.length;
    expect(afterFirst).toBeGreaterThan(before);
    await prisma.run.update({
      where: { id: sent.runId },
      data: { status: "running", completedAt: null },
    });
    await executor.continueRun(sent.runId, "retry");
    expect(connector.records.length).toBe(afterFirst);
  });

  it("9: export includes memory and files but not secrets or browser sessions", async () => {
    const cookie = await signup(app, `export-j-${stamp}@ardurbot.test`, "Export");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "Be useful",
      notifyOnFinish: true,
    });
    const secret = "test-openrouter-key-not-a-real-secret";
    await rpc(app, cookie, "models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: secret,
      label: "hidden",
      modelId: "offline-fixture",
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says export-ok",
    );
    const download = await rpc<{ path: string }>(app, cookie, "export/bot", {
      botId: bot.id,
    });
    const exported = await app.request(download.path, { headers: { cookie } });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/gzip");
    const archive = gunzipSync(Buffer.from(await exported.arrayBuffer())).toString("utf8");
    expect(archive).toContain("export-ok");
    expect(archive).toContain("Be useful");
    expect(archive).not.toContain(secret);
    expect(archive).not.toMatch(/browserProfile|ciphertext|sessionCookie/i);
  });

  it("10: bots can be archived safely and deleted with or without their memories", async () => {
    const ada = await signup(app, `delete-j-${stamp}@ardurbot.test`, "Delete Ada");
    const bob = await signup(app, `delete-bob-j-${stamp}@ardurbot.test`, "Delete Bob");
    const keep = await rpc<Bot>(app, ada, "bots/create", {
      name: "Keep",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const gone = await rpc<Bot>(app, ada, "bots/create", {
      name: "Gone",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "dedicated",
    });
    const forget = await rpc<Bot>(app, ada, "bots/create", {
      name: "Forget",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const goneMemory = await prisma.memoryDocument.findFirstOrThrow({ where: { botId: gone.id } });
    const forgetMemory = await prisma.memoryDocument.findFirstOrThrow({
      where: { botId: forget.id },
    });
    await prisma.memoryDocument.update({
      where: { id: goneMemory.id },
      data: { content: "important retained context" },
    });
    await sendAndWait(
      app,
      ada,
      gone.id,
      "write a file in your home called notes/result.txt that says delete-ok",
    );
    const goneArtifact = await rpc<{ id: string }>(app, ada, "artifacts/create", {
      botId: gone.id,
      name: "delete-me.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("fake artifact content").toString("base64"),
    });
    const home = path.join(dataDir, "homes", gone.id);
    expect(existsSync(home)).toBe(true);
    // Spend that really happened. The scripted runtime emits no usage event, so the row is
    // written directly, the same way this file creates runs and tasks elsewhere.
    const goneBotRow = await prisma.bot.findUniqueOrThrow({
      where: { id: gone.id },
      select: { spaceId: true, userId: true },
    });
    const goneSpend = await prisma.usageRecord.create({
      data: {
        spaceId: goneBotRow.spaceId,
        botId: gone.id,
        userId: goneBotRow.userId,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1200,
        outputTokens: 340,
      },
    });

    const stolen = await raw(app, bob, "bots/archive", { botId: gone.id });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).toContain(gone.id);

    await rpc(app, ada, "bots/archive", { botId: gone.id });
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).not.toContain(gone.id);
    expect((await rpc<Bot[]>(app, ada, "bots/listArchived")).map((bot) => bot.id)).toContain(
      gone.id,
    );
    expect(await prisma.artifact.findUnique({ where: { id: goneArtifact.id } })).not.toBeNull();
    expect(existsSync(home)).toBe(true);

    await rpc(app, ada, "bots/restore", { botId: gone.id });
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).toContain(gone.id);

    await rpc(app, ada, "bots/remove", { botId: gone.id, deleteMemories: false });
    const list = await rpc<Bot[]>(app, ada, "bots/list");
    expect(list.map((bot) => bot.id)).toEqual(expect.arrayContaining([keep.id, forget.id]));
    expect((await raw(app, ada, "bots/get", { botId: gone.id })).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(
      await prisma.memoryDocument.findUniqueOrThrow({ where: { id: goneMemory.id } }),
    ).toMatchObject({
      botId: null,
      scope: "user",
      content: "important retained context",
    });
    // The name is the half that makes a detached usage row readable: bot_deletions is keyed by
    // the bot id, so a per-bot spend report can still label spend that belongs to a bot that
    // no longer exists.
    expect(await prisma.botDeletion.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({
      name: "Gone",
      memoriesPreserved: true,
    });
    expect(await prisma.artifact.findUnique({ where: { id: goneArtifact.id } })).toBeNull();
    expect(existsSync(home)).toBe(false);
    // Deleting a bot must not erase what it cost, nor which bot cost it. botId has no foreign
    // key, so it outlives the bot and stays joinable against bot_deletions for the name.
    expect(
      await prisma.usageRecord.findUniqueOrThrow({ where: { id: goneSpend.id } }),
    ).toMatchObject({ botId: gone.id, inputTokens: 1200, outputTokens: 340 });

    await rpc(app, ada, "bots/remove", { botId: forget.id, deleteMemories: true });
    expect(await prisma.memoryDocument.findUnique({ where: { id: forgetMemory.id } })).toBeNull();
  });

  it("11: deleting an account removes the user and personal workspace data", async () => {
    const email = `account-delete-j-${stamp}@ardurbot.test`;
    const cookie = await signup(app, email, "Delete Account");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Temporary",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    const deleted = await app.request("/api/auth/delete-user", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ password: "password12" }),
    });

    expect(deleted.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: me.userId } })).toBeNull();
    expect(await prisma.organization.findUnique({ where: { id: me.spaceId } })).toBeNull();
    expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toBeNull();
    expect((await raw(app, cookie, "me")).status).toBeGreaterThanOrEqual(400);
  });

  it("12: a bot can spawn a regular bot and must confirm the name to delete it", async () => {
    const cookie = await signup(app, `spawn-j-${stamp}@ardurbot.test`, "Spawn");
    const parent = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, parent.id, "spawn a bot named Scout to research venues");
    const listed = await rpc<Bot[]>(app, cookie, "bots/list");
    const scout = listed.find((bot) => bot.name === "Scout");
    expect(scout).toBeTruthy();
    expect(listed.map((bot) => bot.name).sort()).toEqual(["Chief", "Scout"]);
    await waitFor(
      app,
      cookie,
      scout!.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: parent.id });
    expect(JSON.stringify(snap.messages)).toMatch(/child_bot|Scout/);

    await sendAndWait(app, cookie, scout!.id, "spawn a bot named Nested");
    const afterNested = await rpc<Bot[]>(app, cookie, "bots/list");
    const nested = afterNested.find((bot) => bot.name === "Nested");
    expect(nested).toBeTruthy();
    expect(afterNested.map((bot) => bot.name).sort()).toEqual(["Chief", "Nested", "Scout"]);
    await waitFor(
      app,
      cookie,
      nested!.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named Nested");
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).some((bot) => bot.id === nested!.id)).toBe(
      true,
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named WrongName");
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).some((bot) => bot.id === scout!.id)).toBe(
      true,
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named Scout");
    const afterScout = await rpc<Bot[]>(app, cookie, "bots/list");
    expect(afterScout.some((bot) => bot.id === scout!.id)).toBe(false);
    expect(afterScout.some((bot) => bot.id === nested!.id)).toBe(true);

    await rpc(app, cookie, "bots/remove", { botId: parent.id });
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).map((bot) => bot.name)).toEqual(["Nested"]);
  });

  it("12b: a bot can silence and resume its own finish notifications", async () => {
    const cookie = await signup(app, `notify-finish-j-${stamp}@ardurbot.test`, "Notify");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    expect(bot.notifyOnFinish).toBe(true);

    await sendAndWait(app, cookie, bot.id, "silence finish notifications");
    const silenced = (await rpc<Bot[]>(app, cookie, "bots/list")).find((row) => row.id === bot.id);
    expect(silenced?.notifyOnFinish).toBe(false);
    expect((await rpc<Bot>(app, cookie, "bots/get", { botId: bot.id })).notifyOnFinish).toBe(false);

    await sendAndWait(app, cookie, bot.id, "resume finish notifications");
    expect(
      (await rpc<Bot[]>(app, cookie, "bots/list")).find((row) => row.id === bot.id)?.notifyOnFinish,
    ).toBe(true);
    expect((await rpc<Bot>(app, cookie, "bots/get", { botId: bot.id })).notifyOnFinish).toBe(true);
  });

  it("13: a subagent shows up in the parent thread without creating a bot", async () => {
    const cookie = await signup(app, `subagent-j-${stamp}@ardurbot.test`, "Subagent");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = (await rpc<Bot[]>(app, cookie, "bots/list")).length;
    const snap = await sendAndWait(app, cookie, bot.id, "run a subagent to summarize the notes");
    expect(JSON.stringify(snap.messages)).toMatch(/subagent|helper/);
    expect(await rpc<Bot[]>(app, cookie, "bots/list")).toHaveLength(before);
  });

  it("11: compose backup docs and dump tooling exist", async () => {
    expect(existsSync(path.resolve("docs/self-host.md"))).toBe(true);
    expect(existsSync(path.resolve("infra/compose/docker-compose.yml"))).toBe(true);
    expect(existsSync(path.resolve("scripts/backup.sh"))).toBe(true);
    expect(existsSync(path.resolve("scripts/restore.sh"))).toBe(true);
    const docs = readFileSync(path.resolve("docs/self-host.md"), "utf8");
    expect(docs).toMatch(/pg_dump/);
    expect(docs).toMatch(/Restore/);
  });

  it("14: this-mac is refused unless the sandbox is docker", async () => {
    const cookie = await signup(app, `host-j-${stamp}@ardurbot.test`, "Host");
    const me = await rpc<Me>(app, cookie, "me");
    expect(me.canChooseHostComputer).toBe(false);
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: me.userId },
    });
    ownerCookie = cookie;
    const res = await raw(app, cookie, "deployment/update", { computerHost: "this-mac" });
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(text).toMatch(/This Mac mode is only available/i);
  });

  it("15: ask, answer, stop, follow-up, and clientNonce stay consistent", async () => {
    const cookie = await signup(app, `ask-j-${stamp}@ardurbot.test`, "Ask");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "bots/update", { botId: bot.id, title: "Updated chief" });
    expect((await rpc<Bot>(app, cookie, "bots/get", { botId: bot.id })).title).toBe(
      "Updated chief",
    );

    const asked = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "ask me which city to use",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(JSON.stringify(waiting.messages)).toMatch(/which city/i);
    const askMessage = waiting.messages.find((message) =>
      message.blocks.some((block) => block.kind === "ask"),
    );
    expect(askMessage).toBeTruthy();
    await rpc(app, cookie, "threads/answer", {
      botId: bot.id,
      runId: asked.runId,
      messageId: askMessage!.id,
      answer: "Paris",
    });
    const answered = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(answered.run?.status ?? "completed").toBe("completed");

    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "keep working until I stop you",
    });
    await waitFor(app, cookie, bot.id, (snap) =>
      ["queued", "leased", "running"].includes(snap.run?.status ?? ""),
    );
    const hanging = await prisma.run.findFirstOrThrow({
      where: { botId: bot.id },
      orderBy: { createdAt: "desc" },
    });
    await rpc(app, cookie, "threads/stop", { botId: bot.id });
    await waitFor(app, cookie, bot.id, (snap) => !snap.run);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: hanging.id } })).status).toBe(
      "cancelled",
    );

    await rpc(app, cookie, "threads/followUp", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says followup-ok",
    });
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    expect(
      (
        await rpc<{ content: string }>(app, cookie, "computer/readFile", {
          botId: bot.id,
          path: "notes/result.txt",
        })
      ).content,
    ).toContain("followup-ok");

    const first = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says nonce-ok",
      clientNonce: `nonce-${stamp}`,
    });
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says nonce-dup",
      clientNonce: `nonce-${stamp}`,
    });
    expect(second.runId).toBe(first.runId);
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const file = await rpc<{ content: string }>(app, cookie, "computer/readFile", {
      botId: bot.id,
      path: "notes/result.txt",
    });
    expect(file.content).toContain("nonce-ok");
    expect(file.content).not.toContain("nonce-dup");
  });

  it("15b: a free-text chat message answers a waiting ask", async () => {
    const cookie = await signup(app, `ask-freetext-j-${stamp}@ardurbot.test`, "Ask Free");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    const asked = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "ask me which city to use",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.id === asked.runId && snap.run.status === "waiting_input",
    );
    expect(
      waiting.messages.some((message) =>
        message.blocks.some((block) => block.kind === "ask" && block.status !== "answered"),
      ),
    ).toBe(true);

    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "Paris",
      clientNonce: `ask-freetext-${stamp}`,
    });
    const answered = await waitFor(app, cookie, bot.id, (snap) =>
      snap.messages.some((message) =>
        message.blocks.some(
          (block) =>
            block.kind === "ask" && block.status === "answered" && block.answer === "Paris",
        ),
      ),
    );
    expect(
      answered.messages.flatMap((message) => message.blocks).find((block) => block.kind === "ask"),
    ).toMatchObject({ status: "answered", answer: "Paris" });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: asked.runId } });
      return run?.status === "completed";
    });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: asked.runId } })).status).toBe(
      "completed",
    );
  });

  it("16: routine test-run and plugin connect/revoke", async () => {
    const ada = await signup(app, `plug-j-${stamp}@ardurbot.test`, "Plug Ada");
    const bob = await signup(app, `plug-bob-j-${stamp}@ardurbot.test`, "Plug Bob");
    const bot = await rpc<Bot>(app, ada, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, ada, "routines/create", {
      botId: bot.id,
      name: "Test now",
      prompt: "write a file in your home called notes/result.txt that says testrun-ok",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const tested = await rpc<{ runId: string }>(app, ada, "routines/testRun", {
      routineId: routine.id,
    });
    expect(tested.runId).toBeTruthy();
    await waitFor(
      app,
      ada,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const file = await rpc<{ content: string }>(app, ada, "computer/readFile", {
      botId: bot.id,
      path: "notes/result.txt",
    });
    expect(file.content).toContain("testrun-ok");

    const started = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
      app,
      ada,
      "connections/begin",
      { provider: "gmail", displayName: "Gmail" },
    );
    expect(started.authorizationUrl).toBeNull();
    const connected = await rpc<{ status: string }>(app, ada, "connections/complete", {
      connectionId: started.connectionId,
    });
    expect(connected.status).toBe("connected");
    await rpc(app, bob, "connections/revoke", { connectionId: started.connectionId });
    expect(
      (await rpc<Array<{ id: string; status: string }>>(app, ada, "connections/list")).find(
        (row) => row.id === started.connectionId,
      )?.status,
    ).toBe("connected");
    await rpc(app, ada, "connections/revoke", { connectionId: started.connectionId });
    expect(
      (await rpc<Array<{ id: string; status: string }>>(app, ada, "connections/list")).find(
        (row) => row.id === started.connectionId,
      )?.status,
    ).toBe("revoked");
  });

  it("54: a coordinator assigns two members and receives one wake per finished assignment", async () => {
    const instructionsByRun = new Map<string, string>();
    const originalRun = ScriptedAgentRuntime.prototype.run;
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) => {
        instructionsByRun.set(request.runId, request.instructions);
        return originalRun.call(new ScriptedAgentRuntime(), request, context);
      });
    onTestFinished(() => runtimeSpy.mockRestore());
    const owner = ownerCookie;
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Coordinator",
      title: "Lead",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const first = await rpc<Bot>(app, owner, "bots/create", {
      name: "BotA",
      title: "Reviewer",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const second = await rpc<Bot>(app, owner, "bots/create", {
      name: "BotB",
      title: "Reviewer",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Review room",
      botIds: [coordinator.id, first.id, second.id],
    });
    await rpc(app, owner, "groups/update", { groupId: group.id, coordinatorBotId: coordinator.id });
    const goal = await rpc<{ id: string; rootTaskId: string; tokenLimit: number }>(
      app,
      owner,
      "goals/start",
      {
        groupId: group.id,
        objective: "Coordinate BotA and BotB to review the repository",
        doneWhen: ["Both reviews are posted"],
      },
    );
    expect(goal.tokenLimit).toBe(600_000);
    const startRun = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    expect(startRun).toMatchObject({
      botId: coordinator.id,
      threadId: group.threadId,
      trigger: "follow_up",
      delegationRootTaskId: goal.rootTaskId,
      sourceMessageId: null,
    });
    await waitForDatabase(
      async () =>
        (await prisma.run.findUnique({ where: { id: startRun.id }, select: { status: true } }))
          ?.status === "completed",
    );
    expect(instructionsByRun.get(startRun.id)).toContain("Both reviews are posted");
    expect(
      await prisma.message.count({
        where: { threadId: group.threadId, runId: startRun.id, role: "bot" },
      }),
    ).toBeGreaterThan(0);
    await waitForDatabase(
      async () =>
        (await prisma.delegation.count({
          where: {
            rootTaskId: goal.rootTaskId,
            kind: "group-handoff",
            status: "completed",
            coordinatorWokenAt: { not: null },
          },
        })) === 2,
    );
    const assignments = await prisma.delegation.findMany({
      where: { rootTaskId: goal.rootTaskId, kind: "group-handoff" },
      orderBy: { createdAt: "asc" },
    });
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((assignment) => assignment.actingBotId))).toEqual(
      new Set([first.id, second.id]),
    );
    const root = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: goal.rootTaskId },
    });
    expect(root.tokenLimit).toBe(goal.tokenLimit);
    const workerRuns = await prisma.run.findMany({
      where: { id: { in: assignments.map((assignment) => assignment.runId!).filter(Boolean) } },
      select: { id: true, delegationId: true, delegationRootTaskId: true, goalId: true },
    });
    expect(workerRuns).toEqual(
      expect.arrayContaining(
        assignments.map((assignment) => ({
          id: assignment.runId,
          delegationId: assignment.id,
          delegationRootTaskId: goal.rootTaskId,
          goalId: goal.id,
        })),
      ),
    );
    const workerMessages = await prisma.message.findMany({
      where: {
        threadId: group.threadId,
        role: "bot",
      },
      select: { botId: true, runId: true },
    });
    expect(workerMessages).toEqual(
      expect.arrayContaining(
        assignments.map((assignment) => ({
          botId: assignment.actingBotId,
          runId: assignment.runId,
        })),
      ),
    );
    const wakes = await prisma.run.findMany({
      where: { goalId: goal.id, clientNonce: { startsWith: "goal-wake:" } },
      select: { clientNonce: true },
    });
    expect(new Set(wakes.map((wake) => wake.clientNonce))).toEqual(
      new Set(assignments.map((assignment) => `goal-wake:${assignment.id}`)),
    );
    const replay = createJobReconciler({ prisma, jobs }, { batchSize: 100 });
    await replay.reconcileOnce();
    expect(
      await prisma.run.count({
        where: { goalId: goal.id, clientNonce: { startsWith: "goal-wake:" } },
      }),
    ).toBe(2);
    const racingAssignment = assignments[0]!;
    const racingRun = await prisma.run.findUniqueOrThrow({
      where: { id: racingAssignment.runId! },
    });
    await prisma.run.update({
      where: { id: racingAssignment.runId! },
      data: {
        status: "running",
        completedAt: null,
        leaseOwner: "progress-fixture",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.delegation.update({
      where: { id: racingAssignment.id },
      data: { status: "running", coordinatorWokenAt: null },
    });
    // A real PostgreSQL pair: progress pauses immediately after its first row lock while
    // the coordinator wake takes the competing lock. Repeating catches order regressions.
    for (let index = 0; index < 12; index += 1) {
      let reachedFirstLock!: () => void;
      let reachedSecondLock!: () => void;
      let reachedWakeThread!: () => void;
      let resumeWorker!: () => void;
      let resumeWake!: () => void;
      const firstLock = new Promise<void>((resolve) => {
        reachedFirstLock = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumeWorker = resolve;
      });
      const wakeThread = new Promise<void>((resolve) => {
        reachedWakeThread = resolve;
      });
      const secondLock = new Promise<void>((resolve) => {
        reachedSecondLock = resolve;
      });
      const wakeResume = new Promise<void>((resolve) => {
        resumeWake = resolve;
      });
      const progress = prisma.$transaction(async (tx) => {
        let paused = false;
        const gated = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof tx.$queryRaw>) => {
              if (paused) reachedSecondLock();
              const result = await tx.$queryRaw(...args);
              if (!paused) {
                paused = true;
                reachedFirstLock();
                await resume;
              }
              return result;
            };
          },
        });
        return updateWorkerTask(gated, {
          runId: racingAssignment.runId!,
          spaceId: racingRun.spaceId,
          userId: racingRun.userId,
          botId: racingAssignment.actingBotId,
          executionId: `progress-race-${index}`,
          tool: "report_progress",
          args: { state: "progress", text: `Progress ${index}` },
        });
      });
      void progress.catch(() => undefined);
      await firstLock;
      const wakePrisma = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return (callback: (tx: Parameters<typeof updateWorkerTask>[0]) => Promise<unknown>) =>
            prisma.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(inner, key, innerReceiver) {
                    if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
                    return async (...args: Parameters<typeof tx.$queryRaw>) => {
                      const result = await tx.$queryRaw(...args);
                      if (args[0]?.[0]?.includes("FROM threads")) {
                        reachedWakeThread();
                        await wakeResume;
                      }
                      return result;
                    };
                  },
                }),
              ),
            );
        },
      });
      const wake = wakeGoalCoordinatorForDelegation(wakePrisma, racingAssignment.id);
      const wakeOwnsThread = await Promise.race([
        wakeThread.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      resumeWorker();
      if (wakeOwnsThread) await secondLock;
      resumeWake();
      const outcomes = await Promise.allSettled([progress, wake]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    }
    const stopped = await rpc<{ status: string }>(app, owner, "goals/stop", { goalId: goal.id });
    expect(stopped.status).toBe("stopped");
    expect(
      (
        await prisma.delegationRoot.findUniqueOrThrow({
          where: { rootTaskId: goal.rootTaskId },
        })
      ).cancelRequestedAt,
    ).not.toBeNull();
  });

  it("S1: a goal desk request returns through a distinct reviewer and one coordinator wake per card", async () => {
    const owner = await signup(app, `desk-loop-${stamp}@ardurbot.test`, "Desk loop owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerMe.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Chief of Staff",
      title: "Coordinator",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const worker = await rpc<Bot>(app, owner, "bots/create", {
      name: "Worker",
      title: "Research",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const reviewer = await rpc<Bot>(app, owner, "bots/create", {
      name: "Reviewer",
      title: "Review",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Fixture review",
      botIds: [coordinator.id, worker.id, reviewer.id],
    });
    await rpc(app, owner, "groups/update", {
      groupId: group.id,
      coordinatorBotId: coordinator.id,
    });
    const fixture = "Results show newest first; sort results by createdAt ascending";
    const workerResult =
      "The sort is ascending, so the corrected wording is: Results show oldest first; sort results by createdAt ascending.";
    const reviewerResult =
      "Independent check: Results show oldest first; sort results by createdAt ascending. The original wording contradicts the ascending sort.";
    const originalRuntime = ScriptedAgentRuntime.prototype.run;
    const deliverySpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) => {
        const history = request.history.map((message) => message.content).join("\n");
        if (request.prompt.includes("Review the completed assignment"))
          expect([workerResult, reviewerResult].some((result) => history.includes(result))).toBe(
            true,
          );
        return originalRuntime.call(new ScriptedAgentRuntime(), request, context);
      });
    onTestFinished(() => deliverySpy.mockRestore());
    const goal = await rpc<{ id: string; rootTaskId: string }>(app, owner, "goals/start", {
      groupId: group.id,
      objective: `You coordinate this goal. Use message_bot with a bounded task card to ask Worker to identify the contradiction in this fixture: ${fixture}. After Worker finishes, send its proposed correction to Reviewer with a card asking for an independent check against the fixture. Use the completion events rather than polling. Report the reviewed wording and any remaining uncertainty.`,
      doneWhen: [
        "Worker result exists; a different Reviewer checked it; the final report includes the corrected sentence.",
      ],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const startRun = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await waitForDatabase(
      async () =>
        (await prisma.delegation.count({
          where: {
            rootTaskId: goal.rootTaskId,
            kind: "message",
            status: "completed",
            coordinatorWokenAt: { not: null },
          },
        })) === 2,
    );
    const cards = await prisma.delegation.findMany({
      where: { rootTaskId: goal.rootTaskId, kind: "message" },
      orderBy: { createdAt: "asc" },
    });
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.actingBotId)).toEqual([worker.id, reviewer.id]);
    expect(cards.every((card) => card.depth === 1 && card.rootTaskId === goal.rootTaskId)).toBe(
      true,
    );
    const automatic = await prisma.botMessageDelivery.findMany({
      where: {
        sourceDelegationId: { in: cards.map((card) => card.id) },
        idempotencyKey: { startsWith: "auto-result:" },
      },
    });
    expect(automatic).toHaveLength(2);
    const wakes = await prisma.botMessageWake.findMany({
      where: { rootTaskId: goal.rootTaskId },
    });
    expect(wakes).toHaveLength(2);
    expect(wakes.flatMap((wake) => wake.deliveryIds).sort()).toEqual(
      automatic.map((delivery) => delivery.id).sort(),
    );
    await waitForDatabase(
      async () =>
        (await prisma.message.count({
          where: {
            threadId: group.threadId,
            botId: coordinator.id,
            role: "bot",
            blocks: { path: ["0", "text"], string_contains: "Results show oldest first" },
          },
        })) > 0,
    );
    deliverySpy.mockRestore();

    const recipientThreads = await prisma.bot.findMany({
      where: { id: { in: [worker.id, reviewer.id] } },
      select: { id: true, thread: { select: { id: true } } },
    });
    const threadIds = recipientThreads.map((bot) => bot.thread!.id);
    const delivered = await prisma.message.findMany({
      where: { threadId: { in: [group.threadId, ...threadIds] } },
      select: { threadId: true, botId: true, runId: true, blocks: true },
    });
    for (const card of cards) {
      const markers = delivered.flatMap((message) =>
        (Array.isArray(message.blocks) ? message.blocks : []).flatMap((block) =>
          block &&
          typeof block === "object" &&
          "delegationId" in block &&
          block.delegationId === card.id &&
          "deliveryState" in block &&
          block.deliveryState === "replied"
            ? [message]
            : [],
        ),
      );
      expect(markers).toHaveLength(2);
      const ledger = await prisma.botMessageDelivery.findFirstOrThrow({
        where: { delegationId: card.id, intent: "request" },
      });
      expect(ledger).toMatchObject({ state: "replied", replyDeliveryId: expect.any(String) });
      expect(
        await prisma.botMessageDelivery.count({
          where: { inReplyToDeliveryId: ledger.id, intent: "result" },
        }),
      ).toBe(1);
      const recipientThread = recipientThreads.find((bot) => bot.id === card.actingBotId)!.thread!
        .id;
      expect(new Set(markers.map((message) => message.threadId))).toEqual(
        new Set([group.threadId, recipientThread]),
      );
      expect(
        delivered.some(
          (message) =>
            message.threadId === recipientThread &&
            message.botId === card.actingBotId &&
            message.runId === card.runId &&
            JSON.stringify(message.blocks).includes("Results show oldest first"),
        ),
      ).toBe(true);
    }
    const usage = await prisma.usageRecord.findMany({
      where: {
        runId: {
          in: [
            startRun.id,
            ...cards.map((card) => card.runId!),
            ...wakes.flatMap((wake) => (wake.runId ? [wake.runId] : [])),
          ],
        },
      },
      select: { rootTaskId: true },
    });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((record) => record.rootTaskId === goal.rootTaskId)).toBe(true);

    const workerCard = {
      goal: `Identify the contradiction: ${fixture}`,
      inputs: [{ type: "text", text: fixture }],
      doneWhen: ["Propose corrected wording"],
      deadlineAt: null,
    };
    const replay = await messageBot(
      { prisma, events: createThreadEvents(prisma), jobs },
      startRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Worker",
        message: "Identify the contradiction in the fixture.",
        intent: "request",
        card: workerCard,
        deliveryKey: cards[0]!.admissionKey.slice("bot-message:".length),
      },
    );
    expect(replay).toMatchObject({ ok: true, replayed: true, delegationId: cards[0]!.id });
    const changedReplay = await messageBot(
      { prisma, events: createThreadEvents(prisma), jobs },
      startRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Worker",
        message: "Identify the contradiction in the fixture.",
        intent: "request",
        card: { ...workerCard, goal: "A different task" },
        deliveryKey: cards[0]!.admissionKey.slice("bot-message:".length),
      },
    );
    expect(changedReplay).toMatchObject({
      ok: false,
      error: "This delivery key belongs to a different request.",
    });
    expect(
      await prisma.delegation.count({ where: { rootTaskId: goal.rootTaskId, kind: "message" } }),
    ).toBe(2);
    expect(await wakeGoalCoordinatorForDelegation(prisma, cards[0]!.id)).toBeNull();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 100 });
    await reconciler.reconcileOnce();
    const settledWakes = await prisma.botMessageWake.findMany({
      where: { rootTaskId: goal.rootTaskId },
    });
    expect(settledWakes).toHaveLength(2);
    expect(
      await prisma.run.count({
        where: { goalId: goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(new Set(settledWakes.flatMap((wake) => (wake.runId ? [wake.runId] : []))).size);

    const fixturePin = {
      runtimeKind: "pi" as const,
      provider: "scripted",
      modelId: "scripted",
      effort: "off",
      credentialId: "scripted",
      revision: 0,
    };
    const createCoordinatorRun = async (label: string) => {
      const task = await prisma.task.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: startRun.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          prompt: label,
          status: "running",
        },
      });
      return prisma.run.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: startRun.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
          goalId: goal.id,
          delegationRootTaskId: goal.rootTaskId,
          runtimePin: fixturePin,
          runtimeDestination: startRun.runtimeDestination ?? undefined,
          runtimeComputer: startRun.runtimeComputer ?? undefined,
        },
      });
    };
    const quietJobs = { enqueue: async () => undefined } as typeof jobs;
    const quietDeps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: quietJobs,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin: fixturePin,
          provider: "scripted",
          id: "scripted",
          thinkingLevel: "off",
        }) as never,
    };
    const forgedRun = await createCoordinatorRun("Hidden tool fixture");
    const forged = await messageBot(
      quietDeps,
      forgedRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Reviewer",
        message: "Summarize this fixture from the card.",
        card: {
          goal: "Summarize this fixture from the card.",
          inputs: [{ type: "text", text: fixture }],
          doneWhen: ["Report the wording"],
          deadlineAt: null,
        },
        deliveryKey: `forged-tool:${forgedRun.id}`,
      },
    );
    if (!forged.ok || !forged.runId || !forged.delegationId)
      throw new Error(`The read-only fixture was not admitted: ${forged.error}`);
    const reviewerThread = await prisma.bot.findUniqueOrThrow({
      where: { id: reviewer.id },
      select: { thread: { select: { id: true } } },
    });
    const deskThreadId = reviewerThread.thread!.id;
    await createThreadMessage(prisma, {
      threadId: deskThreadId,
      role: "user",
      blocks: [{ kind: "text", text: "PRIVATE_HISTORY_SENTINEL" }],
    });
    await prisma.thread.update({
      where: { id: deskThreadId },
      data: { historyCompactionSummary: "PRIVATE_SUMMARY_SENTINEL" },
    });
    await prisma.bot.update({
      where: { id: reviewer.id },
      data: { instructions: "PRIVATE_INSTRUCTIONS_SENTINEL" },
    });
    await prisma.memoryDocument.create({
      data: {
        spaceId: startRun.spaceId,
        userId: startRun.userId,
        botId: reviewer.id,
        scope: "group",
        scopeKey: `${reviewer.id}:direct`,
        path: "briefs/direct.md",
        content: "PRIVATE_BRIEF_SENTINEL",
      },
    });
    const originalRun = ScriptedAgentRuntime.prototype.run;
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) => {
        if (request.runId !== forged.runId)
          return originalRun.call(new ScriptedAgentRuntime(), request, context);
        expect(request.tools.some((tool) => tool.name === "search_connectors")).toBe(false);
        expect(JSON.stringify([request.instructions, request.prompt, request.history])).not.toMatch(
          /PRIVATE_(HISTORY|SUMMARY|INSTRUCTIONS|BRIEF)_SENTINEL/,
        );
        expect(request.prompt).toContain("Summarize this fixture from the card.");
        return originalRun.call(
          new ScriptedAgentRuntime(),
          {
            ...request,
            script: [
              {
                toolCalls: [{ name: "search_connectors", args: { query: "mail" } }],
                complete: true,
              },
            ],
          },
          context,
        );
      });
    try {
      await executor.continueRun(forged.runId, "hidden-tool-fixture");
    } finally {
      runtimeSpy.mockRestore();
    }
    const blockedCard = await prisma.delegation.findUniqueOrThrow({
      where: { id: forged.delegationId },
    });
    expect(JSON.stringify(blockedCard.card)).toContain('"kind":"blocked"');
    const forgedMessages = await prisma.message.findMany({ where: { runId: forged.runId } });
    expect(JSON.stringify(forgedMessages)).not.toContain('"kind":"app_connect"');

    // The earlier request and result pairs have already been verified. Move their
    // admission times beyond S4's rolling pair window before exercising another card.
    await prisma.botMessageDelivery.updateMany({
      where: { goalId: goal.id },
      data: { createdAt: new Date(Date.now() - 2 * 60_000) },
    });

    const document = await prisma.memoryDocument.create({
      data: {
        spaceId: startRun.spaceId,
        userId: startRun.userId,
        scope: "user",
        path: `fixtures/desk-${goal.id}`,
        content: "The fixture sorts ascending.",
      },
    });
    await prisma.memoryRevision.create({
      data: { documentId: document.id, revision: 1, content: document.content },
    });
    const readRun = await createCoordinatorRun("Card read fixture");
    const read = await messageBot(
      quietDeps,
      readRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Reviewer",
        message: "Read the listed document.",
        card: {
          goal: "Read the listed document.",
          inputs: [{ type: "document", documentId: document.id, revision: 1 }],
          doneWhen: ["Report its wording"],
          deadlineAt: null,
        },
        deliveryKey: `card-read:${readRun.id}`,
      },
    );
    if (!read.ok || !read.runId)
      throw new Error(`The card read fixture was not admitted: ${read.ok ? "no run" : read.error}`);
    const readSpy = vi.spyOn(prisma.memoryRevision, "findFirst");
    const readRuntime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) => {
        if (request.runId !== read.runId)
          return originalRun.call(new ScriptedAgentRuntime(), request, context);
        return originalRun.call(
          new ScriptedAgentRuntime(),
          {
            ...request,
            script: [
              {
                toolCalls: [
                  { name: "read_file", args: { path: `document:${document.id}@1` } },
                  { name: "read_file", args: { path: "document:unlisted@1" } },
                ],
                complete: true,
              },
            ],
          },
          context,
        );
      });
    try {
      await executor.continueRun(read.runId, "card-read-fixture");
      expect(
        readSpy.mock.calls.filter(([args]) => args?.where?.documentId === document.id),
      ).toHaveLength(1);
    } finally {
      readRuntime.mockRestore();
      readSpy.mockRestore();
    }
    const readCard = await prisma.delegation.findUniqueOrThrow({
      where: { id: read.delegationId! },
    });
    expect(JSON.stringify(readCard.card)).toContain('"kind":"blocked"');

    const privateDocument = await prisma.memoryDocument.create({
      data: {
        spaceId: startRun.spaceId,
        userId: startRun.userId,
        botId: worker.id,
        scope: "bot",
        path: `fixtures/private-${goal.id}`,
        content: "Private fixture content.",
      },
    });
    await prisma.memoryRevision.create({
      data: { documentId: privateDocument.id, revision: 1, content: privateDocument.content },
    });
    const privateDocumentRun = await createCoordinatorRun("Private document reference");
    expect(
      await messageBot(
        quietDeps,
        privateDocumentRun,
        { id: coordinator.id, name: coordinator.name },
        {
          confirm_name: "Reviewer",
          message: "Read a private document.",
          card: {
            goal: "Read a private document.",
            inputs: [{ type: "document", documentId: privateDocument.id, revision: 1 }],
            doneWhen: [],
            deadlineAt: null,
          },
          deliveryKey: `private-document:${privateDocumentRun.id}`,
        },
      ),
    ).toMatchObject({ ok: false, error: "This card document is unavailable." });
    const privateArtifact = await prisma.artifact.create({
      data: {
        spaceId: startRun.spaceId,
        userId: startRun.userId,
        botId: worker.id,
        name: "private.txt",
        mimeType: "text/plain",
        size: 7,
        hash: "fixture",
        storageKey: "private-fixture",
      },
    });
    const privateArtifactRun = await createCoordinatorRun("Private artifact reference");
    expect(
      await messageBot(
        quietDeps,
        privateArtifactRun,
        { id: coordinator.id, name: coordinator.name },
        {
          confirm_name: "Reviewer",
          message: "Read a private artifact.",
          card: {
            goal: "Read a private artifact.",
            inputs: [{ type: "file", artifactId: privateArtifact.id }],
            doneWhen: [],
            deadlineAt: null,
          },
          deliveryKey: `private-artifact:${privateArtifactRun.id}`,
        },
      ),
    ).toMatchObject({ ok: false, error: "This card artifact is unavailable." });
    const otherGroup = await rpc<{ id: string }>(app, owner, "groups/create", {
      name: "Other fixture group",
      botIds: [coordinator.id, worker.id],
    });
    const otherGroupArtifact = await prisma.artifact.create({
      data: {
        spaceId: startRun.spaceId,
        userId: startRun.userId,
        botId: coordinator.id,
        groupId: otherGroup.id,
        name: "other-group.txt",
        mimeType: "text/plain",
        size: 7,
        hash: "fixture",
        storageKey: "other-group-fixture",
      },
    });
    const otherGroupRun = await createCoordinatorRun("Other group artifact reference");
    expect(
      await messageBot(
        quietDeps,
        otherGroupRun,
        { id: coordinator.id, name: coordinator.name },
        {
          confirm_name: "Reviewer",
          message: "Read an artifact from another group.",
          card: {
            goal: "Read an artifact from another group.",
            inputs: [{ type: "file", artifactId: otherGroupArtifact.id }],
            doneWhen: [],
            deadlineAt: null,
          },
          deliveryKey: `other-group-artifact:${otherGroupRun.id}`,
        },
      ),
    ).toMatchObject({ ok: false, error: "This card artifact is unavailable." });
    const lockedRun = await createCoordinatorRun("Membership race");
    let unlockGroup!: () => void;
    let groupLocked!: () => void;
    const groupLockReady = new Promise<void>((resolve) => {
      groupLocked = resolve;
    });
    const groupLockRelease = new Promise<void>((resolve) => {
      unlockGroup = resolve;
    });
    const removeWorker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${group.id} FOR UPDATE`;
      groupLocked();
      await groupLockRelease;
      await tx.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: worker.id } });
      await tx.chatGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });
    });
    await groupLockReady;
    const afterMembershipChange = messageBot(
      quietDeps,
      lockedRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Worker",
        message: "Check the fixture once more.",
        card: workerCard,
        deliveryKey: `membership-race:${lockedRun.id}`,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    unlockGroup();
    await removeWorker;
    expect(await afterMembershipChange).toMatchObject({ ok: false });
    expect(
      await prisma.delegation.count({
        where: { admissionKey: `bot-message:membership-race:${lockedRun.id}` },
      }),
    ).toBe(0);

    const stopRun = await createCoordinatorRun("Stop race");
    const reviewerCard = {
      goal: "Check the correction against the fixture",
      inputs: [{ type: "text", text: fixture }],
      doneWhen: ["Confirm the wording"],
      deadlineAt: null,
    };
    const stopKey = `stop-race:${stopRun.id}`;
    let reachedDeliveryLock!: () => void;
    let resumeDelivery!: () => void;
    const deliveryAtLock = new Promise<void>((resolve) => {
      reachedDeliveryLock = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      resumeDelivery = resolve;
    });
    const gatedPrisma = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Parameters<typeof updateWorkerTask>[0]) => Promise<unknown>) =>
          prisma.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(inner, key, innerReceiver) {
                  if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
                  return async (...args: Parameters<typeof tx.$queryRaw>) => {
                    reachedDeliveryLock();
                    await deliveryGate;
                    return tx.$queryRaw(...args);
                  };
                },
              }),
            ),
          );
      },
    });
    const sendDuringStop = messageBot(
      { ...quietDeps, prisma: gatedPrisma },
      stopRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Reviewer",
        message: "Check the corrected wording once more.",
        card: reviewerCard,
        deliveryKey: stopKey,
      },
    );
    void sendDuringStop.catch(() => undefined);
    await deliveryAtLock;
    try {
      expect(
        (await rpc<{ status: string }>(app, owner, "goals/stop", { goalId: goal.id })).status,
      ).toBe("stopped");
    } finally {
      resumeDelivery();
    }
    expect(await sendDuringStop).toMatchObject({ ok: false });
    expect(
      await prisma.delegation.findUnique({ where: { admissionKey: `bot-message:${stopKey}` } }),
    ).toBeNull();
    expect(
      await prisma.message.findFirst({ where: { clientNonce: `bot-message:${stopKey}` } }),
    ).toBeNull();
    const replayAfterStop = await messageBot(
      quietDeps,
      stopRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Reviewer",
        message: "Check the corrected wording once more.",
        card: reviewerCard,
        deliveryKey: stopKey,
      },
    );
    expect(replayAfterStop).toMatchObject({ ok: false });
    const newAfterStop = await messageBot(
      quietDeps,
      stopRun,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: "Reviewer",
        message: "A new request after Stop must fail.",
        card: reviewerCard,
        deliveryKey: `${stopKey}:new`,
      },
    );
    expect(newAfterStop).toMatchObject({ ok: false });
    expect(
      await prisma.delegation.count({ where: { admissionKey: `bot-message:${stopKey}:new` } }),
    ).toBe(0);
  });

  it("S1: archiving a desk recipient closes its card and wakes the coordinator once", async () => {
    const owner = await signup(app, `desk-archive-${stamp}@ardurbot.test`, "Desk archive owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerMe.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Coordinator",
      title: "Lead",
      description: "",
      instructions: "",
    });
    const worker = await rpc<Bot>(app, owner, "bots/create", {
      name: "Worker",
      title: "Research",
      description: "",
      instructions: "",
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Archive fixture",
      botIds: [coordinator.id, worker.id],
    });
    await rpc(app, owner, "groups/update", {
      groupId: group.id,
      coordinatorBotId: coordinator.id,
    });
    const goal = await rpc<{ id: string; rootTaskId: string }>(app, owner, "goals/start", {
      groupId: group.id,
      objective: "Acknowledge the archive fixture.",
      doneWhen: ["The coordinator has the result."],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const startRun = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await waitForDatabase(
      async () =>
        (await prisma.run.findUnique({ where: { id: startRun.id }, select: { status: true } }))
          ?.status === "completed",
    );
    const task = await prisma.task.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        prompt: "Ask the worker to check this fixture.",
        status: "running",
      },
    });
    const pin = {
      runtimeKind: "pi" as const,
      provider: "scripted",
      modelId: "scripted",
      effort: "off",
      credentialId: "scripted",
      revision: 0,
    };
    const run = await prisma.run.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        runtimePin: pin,
        runtimeDestination: startRun.runtimeDestination ?? undefined,
        runtimeComputer: startRun.runtimeComputer ?? undefined,
      },
    });
    const quietJobs = {
      enqueue: async () => undefined,
      cancel: async () => undefined,
    } as typeof jobs;
    const delivery = await messageBot(
      {
        prisma,
        events: createThreadEvents(prisma),
        jobs: quietJobs,
        resolveDelegationPin: async () =>
          ({
            kind: "resolved",
            pin,
            provider: "scripted",
            id: "scripted",
            thinkingLevel: "off",
          }) as never,
      },
      run,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: worker.name,
        message: "Check the fixture.",
        card: {
          goal: "Check the fixture.",
          inputs: [{ type: "text", text: "Fixture text" }],
          doneWhen: ["Report the result"],
          deadlineAt: null,
        },
        deliveryKey: `archive:${run.id}`,
      },
    );
    if (!delivery.ok || !delivery.delegationId || !delivery.runId)
      throw new Error("The archive fixture was not delivered.");
    await prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });
    await archiveBot(
      { prisma, jobs: quietJobs, sandbox: {} as never, home: {} as never },
      await prisma.bot.findUniqueOrThrow({ where: { id: worker.id } }),
      {} as never,
    );
    const card = await prisma.delegation.findUniqueOrThrow({
      where: { id: delivery.delegationId },
    });
    const root = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: goal.rootTaskId },
    });
    expect(card.status).toBe("cancelled");
    expect(card.coordinatorWokenAt).not.toBeNull();
    expect(root.activeDescendants).toBe(0);
    expect(root.reservedTokens).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.runId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.message.count({ where: { clientNonce: `delegation-summary:${card.id}` } }),
    ).toBe(1);
    await createJobReconciler({ prisma, jobs: quietJobs }, { batchSize: 100 }).reconcileOnce();
    expect(await prisma.run.count({ where: { clientNonce: `goal-wake:${card.id}` } })).toBe(1);
  });

  it("S1: clearing a queued desk request settles its card and wakes the coordinator once", async () => {
    const owner = await signup(app, `desk-clear-${stamp}@ardurbot.test`, "Desk clear owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerMe.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Coordinator",
      title: "Lead",
      description: "",
      instructions: "",
    });
    const worker = await rpc<Bot>(app, owner, "bots/create", {
      name: "Worker",
      title: "Research",
      description: "",
      instructions: "",
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Clear fixture",
      botIds: [coordinator.id, worker.id],
    });
    await rpc(app, owner, "groups/update", {
      groupId: group.id,
      coordinatorBotId: coordinator.id,
    });
    const goal = await rpc<{ id: string; rootTaskId: string }>(app, owner, "goals/start", {
      groupId: group.id,
      objective: "Acknowledge the clear fixture.",
      doneWhen: ["The coordinator has the result."],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const startRun = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await waitForDatabase(
      async () =>
        (await prisma.run.findUnique({ where: { id: startRun.id }, select: { status: true } }))
          ?.status === "completed",
    );
    const task = await prisma.task.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        prompt: "Ask the worker to check this fixture.",
        status: "running",
      },
    });
    const pin = {
      runtimeKind: "pi" as const,
      provider: "scripted",
      modelId: "scripted",
      effort: "off",
      credentialId: "scripted",
      revision: 0,
    };
    const run = await prisma.run.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        runtimePin: pin,
        runtimeDestination: startRun.runtimeDestination ?? undefined,
        runtimeComputer: startRun.runtimeComputer ?? undefined,
      },
    });
    const quietJobs = {
      enqueue: async () => undefined,
      cancel: async () => undefined,
    } as typeof jobs;
    const delivery = await messageBot(
      {
        prisma,
        events: createThreadEvents(prisma),
        jobs: quietJobs,
        resolveDelegationPin: async () =>
          ({
            kind: "resolved",
            pin,
            provider: "scripted",
            id: "scripted",
            thinkingLevel: "off",
          }) as never,
      },
      run,
      { id: coordinator.id, name: coordinator.name },
      {
        confirm_name: worker.name,
        message: "Check the fixture.",
        card: {
          goal: "Check the fixture.",
          inputs: [{ type: "text", text: "Fixture text" }],
          doneWhen: ["Report the result"],
          deadlineAt: null,
        },
        deliveryKey: `clear:${run.id}`,
      },
    );
    if (!delivery.ok || !delivery.delegationId || !delivery.runId)
      throw new Error("The clear fixture was not delivered.");
    await prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.runId } })).toMatchObject({
      status: "queued",
    });
    await rpc(app, owner, "threads/clear", { botId: worker.id });
    const card = await prisma.delegation.findUniqueOrThrow({
      where: { id: delivery.delegationId },
    });
    const root = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: goal.rootTaskId },
    });
    expect(card.status).toBe("cancelled");
    expect(card.result).toContain("recipient thread was cleared");
    expect(root.activeDescendants).toBe(0);
    expect(root.reservedTokens).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.runId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.message.count({ where: { clientNonce: `delegation-summary:${card.id}` } }),
    ).toBe(1);
    await createJobReconciler({ prisma, jobs: quietJobs }, { batchSize: 100 }).reconcileOnce();
    expect(await prisma.run.count({ where: { clientNonce: `goal-wake:${card.id}` } })).toBe(1);
    expect(
      (await prisma.delegation.findUniqueOrThrow({ where: { id: card.id } })).coordinatorWokenAt,
    ).not.toBeNull();
    await createJobReconciler({ prisma, jobs: quietJobs }, { batchSize: 100 }).reconcileOnce();
    expect(await prisma.run.count({ where: { clientNonce: `goal-wake:${card.id}` } })).toBe(1);
  });

  it("keeps released private steering out of a queued peer run and creates a private continuation", async () => {
    const pin = {
      runtimeKind: "pi" as const,
      provider: "scripted",
      modelId: "scripted",
      effort: "off",
      credentialId: "scripted",
      revision: 0,
    };
    const owner = await signup(app, `peer-steering-${stamp}@ardurbot.test`, "Peer steering owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerMe.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Coordinator",
      title: "Lead",
      description: "",
      instructions: "",
    });
    const peer = await rpc<Bot>(app, owner, "bots/create", {
      name: "Peer",
      title: "Worker",
      description: "",
      instructions: "",
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Steering room",
      botIds: [coordinator.id, peer.id],
    });
    await rpc(app, owner, "groups/update", {
      groupId: group.id,
      coordinatorBotId: coordinator.id,
    });
    const goal = await rpc<{ id: string; rootTaskId: string }>(app, owner, "goals/start", {
      groupId: group.id,
      objective: "Check a bounded fixture.",
      doneWhen: ["The result is reported."],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const startRun = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await prisma.run.update({ where: { id: startRun.id }, data: { status: "completed" } });
    await prisma.task.update({ where: { id: startRun.taskId }, data: { status: "done" } });
    const peerThread = await prisma.bot.findUniqueOrThrow({
      where: { id: peer.id },
      select: { thread: { select: { id: true } } },
    });
    const peerThreadId = peerThread.thread!.id;
    const privateTask = await prisma.task.create({
      data: {
        spaceId: peer.spaceId,
        userId: ownerMe.userId,
        botId: peer.id,
        threadId: peerThreadId,
        prompt: "Private work.",
        status: "running",
      },
    });
    const privateRun = await prisma.run.create({
      data: {
        spaceId: peer.spaceId,
        userId: ownerMe.userId,
        botId: peer.id,
        threadId: peerThreadId,
        taskId: privateTask.id,
        trigger: "user",
        status: "running",
        leaseOwner: "private-fixture",
        leaseFence: 1,
      },
    });
    const privateAttempt = await prisma.attempt.create({
      data: { runId: privateRun.id, fence: 1, status: "running" },
    });
    const coordinatorTask = await prisma.task.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        prompt: "Ask the peer.",
        status: "running",
      },
    });
    const coordinatorRun = await prisma.run.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        taskId: coordinatorTask.id,
        trigger: "user",
        status: "running",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        runtimePin: pin,
        runtimeDestination: startRun.runtimeDestination ?? undefined,
        runtimeComputer: startRun.runtimeComputer ?? undefined,
      },
    });
    const quietJobs = {
      enqueue: async () => undefined,
      cancel: async () => undefined,
    } as typeof jobs;
    const delivery = await messageBot(
      {
        prisma,
        events: createThreadEvents(prisma),
        jobs: quietJobs,
        resolveDelegationPin: async () =>
          ({
            kind: "resolved",
            pin,
            provider: "scripted",
            id: "scripted",
            thinkingLevel: "off",
          }) as never,
      },
      coordinatorRun,
      { id: coordinator.id, name: coordinator.name },
      {
        bot_id: peer.id,
        message: "Check the fixture.",
        card: {
          goal: "Check the fixture.",
          inputs: [{ type: "text", text: "Public fixture" }],
          doneWhen: ["Report the result"],
          deadlineAt: null,
        },
        deliveryKey: `peer-steering:${coordinatorRun.id}`,
      },
    );
    if (!delivery.ok) throw new Error(delivery.error);
    if (!delivery.runId) throw new Error("The peer request was not delivered.");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: delivery.runId } })).status).toBe(
      "queued",
    );
    const privateText = "PRIVATE_OWNER_FOLLOW_UP_SENTINEL";
    const sent = await sendUserMessage(prisma, {
      spaceId: peer.spaceId,
      threadId: peerThreadId,
      botId: peer.id,
      userId: ownerMe.userId,
      blocks: [{ kind: "text", text: privateText }],
      prompt: privateText,
      trigger: "follow_up",
    });
    expect(sent.runId).toBe(privateRun.id);
    const finished = await finalizeRun(prisma, {
      spaceId: peer.spaceId,
      threadId: peerThreadId,
      botId: peer.id,
      runId: privateRun.id,
      taskId: privateTask.id,
      attemptId: privateAttempt.id,
      leaseOwner: "private-fixture",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Private task finished." }],
    });
    expect(finished).not.toBe(false);
    const continuation = await prisma.run.findFirstOrThrow({
      where: {
        botId: peer.id,
        threadId: peerThreadId,
        trigger: "follow_up",
        id: { not: privateRun.id },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(continuation.sourceMessageId).toBe(sent.messageId);
    expect(
      await prisma.steeringMessage.findFirstOrThrow({ where: { messageId: sent.messageId } }),
    ).toMatchObject({ runId: continuation.id, claimedAt: null });
    // This owner-origin private fixture is deliberately unassigned so the peer could claim it.
    const unassignedText = "UNASSIGNED_PRIVATE_STEERING_SENTINEL";
    const unassignedMessage = await createThreadMessage(prisma, {
      threadId: peerThreadId,
      role: "user",
      origin: "user",
      actorId: ownerMe.userId,
      blocks: [{ kind: "text", text: unassignedText }],
    });
    const unassignedSteering = await prisma.steeringMessage.create({
      data: {
        messageId: unassignedMessage.id,
        botId: peer.id,
        userId: ownerMe.userId,
        runId: null,
        claimedAt: null,
      },
    });
    await prisma.run.update({
      where: { id: delivery.runId },
      data: { status: "running", leaseOwner: "peer-fixture", leaseFence: 1 },
    });
    const steering = await claimSteering(prisma, {
      threadId: peerThreadId,
      botId: peer.id,
      runId: delivery.runId,
      leaseOwner: "peer-fixture",
      leaseFence: 1,
      seenIds: [],
    });
    expect(steering).toEqual([]);
    expect(
      await prisma.steeringMessage.findUniqueOrThrow({ where: { id: unassignedSteering.id } }),
    ).toMatchObject({ runId: null, claimedAt: null });
    expect(promptWithInitialSteering("Read only the peer card.", steering)).not.toContain(
      privateText,
    );
    const originalDescribe = ScriptedAgentRuntime.prototype.describe;
    let describeCalls = 0;
    const describeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "describe")
      .mockImplementation(() => {
        const description = originalDescribe.call(new ScriptedAgentRuntime());
        describeCalls++;
        return {
          ...description,
          // Force the live steering callback branch from the first execution-time
          // descriptor read; admission must retain the runtime's startup capability.
          capabilities: { ...description.capabilities, scripted: false },
        };
      });
    const requests: Array<{ claimSteering: unknown; prompt: string; history: unknown }> = [];
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request) {
        if (request.runId === delivery.runId) {
          requests.push({
            claimSteering: request.claimSteering,
            prompt: request.prompt,
            history: request.history,
          });
        }
        yield { type: "done", text: "Peer fixture complete." };
      });
    try {
      await prisma.run.update({
        where: { id: delivery.runId },
        data: { status: "queued", leaseOwner: null },
      });
      await executor.continueRun(delivery.runId, "peer-steering-executor-fixture");
    } finally {
      runtimeSpy.mockRestore();
      describeSpy.mockRestore();
    }
    expect(
      requests,
      JSON.stringify({
        run: await prisma.run.findUnique({
          where: { id: delivery.runId },
          select: { status: true, error: true },
        }),
        describeCalls,
      }),
    ).toHaveLength(1);
    expect(describeCalls).toBeGreaterThan(0);
    expect(requests[0]?.claimSteering).toBeUndefined();
    expect(JSON.stringify([requests[0]?.prompt, requests[0]?.history])).not.toContain(
      unassignedText,
    );
    expect((await prisma.run.findUniqueOrThrow({ where: { id: delivery.runId } })).status).toBe(
      "completed",
    );
    expect(
      await prisma.steeringMessage.findUniqueOrThrow({ where: { id: unassignedSteering.id } }),
    ).toMatchObject({ runId: null, claimedAt: null });
    await settleFixtureWork([coordinator.id, peer.id], goal.id);
  });

  it("sends only claimed quiet deliveries after selection and through context assembly", async () => {
    const owner = await signup(app, `quiet-executor-${stamp}@ardurbot.test`, "Quiet owner");
    const actor = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: actor.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Coordinator",
      title: "Lead",
      description: "",
      instructions: "",
    });
    const worker = await rpc<Bot>(app, owner, "bots/create", {
      name: "Worker",
      title: "Member",
      description: "",
      instructions: "",
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Quiet delivery room",
      botIds: [coordinator.id, worker.id],
    });
    await rpc(app, owner, "groups/update", {
      groupId: group.id,
      coordinatorBotId: coordinator.id,
    });
    const untilAt = new Date(Date.now() + 60 * 60 * 1000);
    const goal = await rpc<{ id: string; rootTaskId: string }>(app, owner, "goals/start", {
      groupId: group.id,
      objective: "Review quiet updates.",
      doneWhen: ["Updates reviewed"],
      tokenLimit: 100_000,
      untilAt: untilAt.toISOString(),
    });
    const start = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await prisma.run.update({ where: { id: start.id }, data: { status: "completed" } });
    await prisma.task.update({ where: { id: start.taskId }, data: { status: "done" } });
    const workerThread = await prisma.thread.findFirstOrThrow({
      where: { botId: worker.id, spaceId: worker.spaceId },
    });

    for (const expiresDuringAssembly of [false, true]) {
      const task = await prisma.task.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: actor.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          prompt: "Review the current updates.",
          status: "queued",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: actor.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          taskId: task.id,
          status: "queued",
          trigger: "follow_up",
          goalId: goal.id,
          delegationRootTaskId: goal.rootTaskId,
        },
      });
      const deliveries = [];
      for (const label of ["expired", "claimed"]) {
        const id = randomUUID();
        const text = label === "claimed" ? `claimed-${id}: deadline Friday` : `${label}-${id}`;
        const outbound = await createThreadMessage(prisma, {
          threadId: workerThread.id,
          role: "bot",
          botId: worker.id,
          blocks: [
            {
              kind: "bot_message_sent",
              toBotId: coordinator.id,
              toBotName: coordinator.name,
              text,
              intent: "fyi",
              deliveryId: id,
              deliveryState: "delivered",
            },
          ],
          markUnread: false,
        });
        const inbound = await createThreadMessage(prisma, {
          threadId: group.threadId,
          role: "user",
          origin: "peer-bot",
          actorId: worker.id,
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: worker.id,
              fromBotName: worker.name,
              text,
              intent: "fyi",
              hop: 1,
              returnToMessageId: outbound.id,
              deliveryId: id,
              deliveryState: "delivered",
            },
          ],
          markUnread: false,
        });
        deliveries.push(
          await prisma.botMessageDelivery.create({
            data: {
              id,
              spaceId: coordinator.spaceId,
              userId: actor.userId,
              goalId: goal.id,
              rootTaskId: goal.rootTaskId,
              conversationId: id,
              senderBotId: worker.id,
              recipientBotId: coordinator.id,
              senderThreadId: workerThread.id,
              recipientThreadId: group.threadId,
              sourceRunId: start.id,
              intent: "fyi",
              outboundMessageId: outbound.id,
              inboundMessageId: inbound.id,
              state: "delivered",
              hop: 1,
              authorityFingerprint: "fixture",
              requestFingerprint: id,
              idempotencyKey: `quiet-executor:${id}`,
              expiresAt: untilAt,
            },
          }),
        );
      }
      const [expired, claimed] = deliveries;
      await createThreadMessage(prisma, {
        threadId: group.threadId,
        role: "user",
        blocks: [{ kind: "text", text: `AFTER_QUIET_${run.id}` }],
      });
      const expiredMessage = await prisma.message.findUniqueOrThrow({
        where: { id: expired.inboundMessageId! },
        select: { seq: true },
      });
      const summaryMarker = `SUMMARY_BEFORE_QUIET_${run.id}`;
      await prisma.thread.update({
        where: { id: group.threadId },
        data: {
          historyCompactedUpToSeq: expiredMessage.seq - 1,
          historyCompactionSummary: `${RECEIPT_FILTERED_SUMMARY_MARKER}${summaryMarker}`,
        },
      });
      let selectedBoth = false;
      let enterAssembly!: () => void;
      let resumeAssembly!: () => void;
      const assemblyEntered = new Promise<void>((resolve) => {
        enterAssembly = resolve;
      });
      const assemblyGate = new Promise<void>((resolve) => {
        resumeAssembly = resolve;
      });
      const selected = prisma.botMessageDelivery.findMany.bind(prisma.botMessageDelivery);
      const selectSpy = vi
        .spyOn(prisma.botMessageDelivery, "findMany")
        .mockImplementation(async (args) => {
          const rows = await selected(args);
          if (
            args.where?.recipientThreadId === group.threadId &&
            args.where.state &&
            args.select?.inboundMessageId
          ) {
            selectedBoth =
              rows.some((row) => row.id === expired.id) &&
              rows.some((row) => row.id === claimed.id);
            await prisma.botMessageDelivery.update({
              where: { id: expired.id },
              data: { expiresAt: new Date(Date.now() - 1_000) },
            });
            await expireQuietBotMessages(prisma);
          }
          return rows;
        });
      const assemble = turnContext.assembleTurnContext;
      const assemblySpy = vi
        .spyOn(turnContext, "assembleTurnContext")
        .mockImplementation(async (args) => {
          const assembled = await assemble(args);
          if (expiresDuringAssembly && args.requiredContext?.id === `quiet-deliveries:${run.id}`) {
            enterAssembly();
            await assemblyGate;
          }
          return assembled;
        });
      const requests: Array<{
        prompt: string;
        history: Array<{ id?: string; content: string }>;
      }> = [];
      const runtimeSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request) {
          if (request.runId === run.id)
            requests.push({ prompt: request.prompt, history: request.history });
          yield { type: "done", text: "Updates reviewed." };
        });
      try {
        const execution = executor.continueRun(run.id, `quiet-executor-${run.id}`);
        if (expiresDuringAssembly) {
          await Promise.race([
            assemblyEntered,
            execution.then(() => {
              throw new Error("The turn completed before context assembly was reached.");
            }),
          ]);
          await prisma.botMessageDelivery.update({
            where: { id: claimed.id },
            data: { expiresAt: new Date(Date.now() - 1_000) },
          });
          await expireQuietBotMessages(prisma);
          expect(
            await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: claimed.id } }),
          ).toMatchObject({ state: "delivered", outcome: null, quietClaimRunId: run.id });
          resumeAssembly();
        }
        await execution;
      } finally {
        resumeAssembly();
        runtimeSpy.mockRestore();
        assemblySpy.mockRestore();
        selectSpy.mockRestore();
      }
      expect(selectedBoth).toBe(true);
      expect(requests).toHaveLength(1);
      const runtimeInput = [
        requests[0]?.prompt,
        ...(requests[0]?.history ?? []).map((message) => message.content),
      ].join("\n");
      expect(runtimeInput).toContain(summaryMarker);
      expect(requests[0]?.history.some((message) => message.id === expired.inboundMessageId)).toBe(
        true,
      );
      expect(runtimeInput).not.toContain(`expired-${expired.id}`);
      expect(runtimeInput).not.toContain(expired.id);
      expect(runtimeInput.split(`claimed-${claimed.id}`)).toHaveLength(2);
      const quiet = requests[0]?.history.find(
        (message) => message.id === `quiet-deliveries:${run.id}`,
      );
      expect(quiet?.content).toContain(claimed.id);
      expect(quiet?.content).toContain(`claimed-${claimed.id}`);
      expect(
        await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: expired.id } }),
      ).toMatchObject({ state: "expired", outcome: "expired", quietClaimRunId: null });
      expect(
        (await prisma.message.findUniqueOrThrow({ where: { id: expired.inboundMessageId! } }))
          .blocks,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "bot_message_received",
            deliveryId: expired.id,
            deliveryState: "expired",
          }),
        ]),
      );
      expect(
        await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: claimed.id } }),
      ).toMatchObject({ outcome: "consumed", quietClaimRunId: null });

      if (!expiresDuringAssembly) {
        await markBriefPending(prisma, run.id);
        await prisma.botBrief.update({
          where: { botId_threadId: { botId: coordinator.id, threadId: group.threadId } },
          data: { lastMessageSeq: -1, attemptedAt: null },
        });
        const briefInputs: string[] = [];
        const briefRuntime = {
          describe: () => ({
            id: "brief-fixture",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { streaming: true, tools: false },
          }),
          async *run(request: { prompt: string }) {
            briefInputs.push(request.prompt);
            const contaminated = request.prompt.includes(`expired-${expired.id}`);
            yield {
              type: "done" as const,
              text: `## Goal\n${contaminated ? `expired-${expired.id}` : "Verified brief"}`,
            };
          },
        } as unknown as AgentRuntime;
        const memoryDocuments = {
          list: async () => ({ items: [] }),
          commit: async (input: { content: string }) => {
            const document = await prisma.memoryDocument.create({
              data: {
                spaceId: coordinator.spaceId,
                userId: actor.userId,
                botId: coordinator.id,
                scope: "group",
                scopeKey: `${coordinator.id}:${group.id}`,
                path: `briefs/${group.id}.md`,
                content: input.content,
              },
            });
            return document;
          },
        } as unknown as MemoryService;
        await refreshRunBrief(
          {
            prisma,
            memoryDocuments,
            secrets: [],
            claim: ({ claim }) => prisma.$transaction((tx) => claim(tx)),
            resolve: async () => ({
              runtime: briefRuntime,
              model: { provider: "fixture", id: "fixture" },
            }),
          },
          run.id,
        );
        const briefState = await prisma.botBrief.findUniqueOrThrow({
          where: { botId_threadId: { botId: coordinator.id, threadId: group.threadId } },
        });
        expect(
          briefInputs,
          JSON.stringify({
            reason: briefState.reason,
            pendingRunId: briefState.pendingRunId,
            attemptedAt: briefState.attemptedAt,
          }),
        ).toHaveLength(1);
        expect(briefInputs[0]).not.toContain(`expired-${expired.id}`);
      }

      const followUpTask = await prisma.task.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: actor.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          prompt: "What deadline did the earlier update give?",
          status: "queued",
        },
      });
      const followUpRun = await prisma.run.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: actor.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          taskId: followUpTask.id,
          status: "queued",
          trigger: "follow_up",
          goalId: goal.id,
          delegationRootTaskId: goal.rootTaskId,
        },
      });
      const followUpInputs: string[] = [];
      const followUpSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request) {
          if (request.runId === followUpRun.id)
            followUpInputs.push(
              [request.prompt, ...request.history.map((message) => message.content)].join("\n"),
            );
          yield { type: "done", text: "The deadline was Friday." };
        });
      try {
        await executor.continueRun(followUpRun.id, `quiet-follow-up-${followUpRun.id}`);
      } finally {
        followUpSpy.mockRestore();
      }
      expect(followUpInputs).toHaveLength(1);
      expect(followUpInputs[0]).toContain(`claimed-${claimed.id}: deadline Friday`);
      expect(followUpInputs[0]).not.toContain(`quiet-deliveries:${followUpRun.id}`);
      if (!expiresDuringAssembly) {
        expect(followUpInputs[0]).toContain("<group_brief>");
        expect(followUpInputs[0]).not.toContain(`expired-${expired.id}`);
      }
    }
    await settleFixtureWork([coordinator.id, worker.id], goal.id);
  });

  it("omits an expired private quiet receipt on a direct turn without a goal", async () => {
    const owner = await signup(app, `private-quiet-${stamp}@ardurbot.test`, "Private owner");
    const actor = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: actor.userId },
    });
    const sender = await rpc<Bot>(app, owner, "bots/create", {
      name: "Sender",
      title: "Member",
      description: "",
      instructions: "",
    });
    const recipient = await rpc<Bot>(app, owner, "bots/create", {
      name: "Recipient",
      title: "Member",
      description: "",
      instructions: "",
    });
    const senderThread = await prisma.thread.findFirstOrThrow({
      where: { botId: sender.id, spaceId: sender.spaceId },
    });
    const recipientThread = await prisma.thread.findFirstOrThrow({
      where: { botId: recipient.id, spaceId: recipient.spaceId },
    });
    const deliveryId = randomUUID();
    const receiptText = `EXPIRED_PRIVATE_QUIET_${deliveryId}`;
    const outbound = await createThreadMessage(prisma, {
      threadId: senderThread.id,
      role: "bot",
      botId: sender.id,
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: recipient.id,
          toBotName: recipient.name,
          text: receiptText,
          intent: "fyi",
          deliveryId,
          deliveryState: "delivered",
        },
      ],
    });
    const inbound = await createThreadMessage(prisma, {
      threadId: recipientThread.id,
      role: "user",
      origin: "peer-bot",
      actorId: sender.id,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text: receiptText,
          intent: "fyi",
          deliveryId,
          deliveryState: "expired",
        },
        { kind: "text", text: "Keep this adjacent note" },
      ],
      markUnread: false,
    });
    const userMessage = await createThreadMessage(prisma, {
      threadId: recipientThread.id,
      role: "user",
      origin: "user",
      actorId: actor.userId,
      blocks: [{ kind: "text", text: "Review my direct request" }],
    });
    const task = await prisma.task.create({
      data: {
        spaceId: recipient.spaceId,
        userId: actor.userId,
        botId: recipient.id,
        threadId: recipientThread.id,
        prompt: "Review my direct request",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: recipient.spaceId,
        userId: actor.userId,
        botId: recipient.id,
        threadId: recipientThread.id,
        taskId: task.id,
        sourceMessageId: userMessage.id,
        status: "queued",
        trigger: "user",
      },
    });
    await prisma.botMessageDelivery.create({
      data: {
        id: deliveryId,
        spaceId: recipient.spaceId,
        userId: actor.userId,
        rootTaskId: task.id,
        conversationId: deliveryId,
        senderBotId: sender.id,
        recipientBotId: recipient.id,
        senderThreadId: senderThread.id,
        recipientThreadId: recipientThread.id,
        sourceRunId: run.id,
        intent: "fyi",
        outboundMessageId: outbound.id,
        inboundMessageId: inbound.id,
        state: "expired",
        outcome: "expired",
        hop: 1,
        authorityFingerprint: "fixture",
        requestFingerprint: deliveryId,
        idempotencyKey: `private-quiet:${deliveryId}`,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const requests: Array<{ prompt: string; history: Array<{ content: string }> }> = [];
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request) {
        if (request.runId === run.id)
          requests.push({ prompt: request.prompt, history: request.history });
        yield { type: "done", text: "Direct request reviewed." };
      });
    try {
      await executor.continueRun(run.id, `private-quiet-${run.id}`);
    } finally {
      runtimeSpy.mockRestore();
    }
    expect(requests).toHaveLength(1);
    const runtimeInput = [
      requests[0]?.prompt,
      ...requests[0]!.history.map((row) => row.content),
    ].join("\n");
    expect(runtimeInput).not.toContain(receiptText);
    expect(runtimeInput).toContain("Keep this adjacent note");
    expect(runtimeInput).toContain("Review my direct request");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).goalId).toBeNull();
    await settleFixtureWork([sender.id, recipient.id]);
  });

  it("keeps a goal wake's source result after a newer room message fills history", async () => {
    const pin = {
      runtimeKind: "pi" as const,
      provider: "scripted",
      modelId: "scripted",
      effort: "off",
      credentialId: "scripted",
      revision: 0,
    };
    const owner = await signup(app, `wake-budget-${stamp}@ardurbot.test`, "Wake owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerMe.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Coordinator",
      title: "Lead",
      description: "",
      instructions: "",
    });
    const worker = await rpc<Bot>(app, owner, "bots/create", {
      name: "Worker",
      title: "Research",
      description: "",
      instructions: "",
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Wake budget room",
      botIds: [coordinator.id, worker.id],
    });
    await rpc(app, owner, "groups/update", {
      groupId: group.id,
      coordinatorBotId: coordinator.id,
    });
    const goal = await rpc<{ id: string; rootTaskId: string }>(app, owner, "goals/start", {
      groupId: group.id,
      objective: "Review one completed result.",
      doneWhen: ["The result is reviewed."],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const startRun = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await executor.continueRun(startRun.id, "wake-start-fixture");
    await waitForDatabase(async () => {
      const current = await prisma.run.findUnique({
        where: { id: startRun.id },
        select: { status: true },
      });
      return current?.status === "completed";
    });
    const completedStart = await prisma.run.findUniqueOrThrow({ where: { id: startRun.id } });
    expect(completedStart.status).toBe("completed");
    const distinctResult = "WORKER_RESULT_OLDEST_FIRST_SENTINEL";
    const coordinatorTask = await prisma.task.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        prompt: "Ask the worker to check the fixture.",
        status: "running",
      },
    });
    const coordinatorRun = await prisma.run.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        taskId: coordinatorTask.id,
        status: "running",
        trigger: "user",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        runtimePin: completedStart.runtimePin ?? pin,
        runtimeDestination: completedStart.runtimeDestination ?? undefined,
        runtimeComputer: completedStart.runtimeComputer ?? undefined,
      },
    });
    const quietJobs = {
      enqueue: async () => undefined,
      cancel: async () => undefined,
    } as typeof jobs;
    const delivery = await messageBot(
      {
        prisma,
        events: createThreadEvents(prisma),
        jobs: quietJobs,
        resolveDelegationPin: async () =>
          ({
            kind: "resolved",
            pin,
            provider: "scripted",
            id: "scripted",
            thinkingLevel: "off",
          }) as never,
      },
      coordinatorRun,
      { id: coordinator.id, name: coordinator.name },
      {
        bot_id: worker.id,
        message: "Check the fixture.",
        card: {
          goal: "Check the fixture.",
          inputs: [{ type: "text", text: "Public fixture" }],
          doneWhen: ["Report the result"],
          deadlineAt: null,
        },
        deliveryKey: `wake-budget:${coordinatorRun.id}`,
      },
    );
    if (!delivery.ok) throw new Error(delivery.error);
    if (!delivery.delegationId || !delivery.runId)
      throw new Error("The worker request was not queued.");
    await prisma.run.update({ where: { id: coordinatorRun.id }, data: { status: "completed" } });
    await prisma.task.update({ where: { id: coordinatorTask.id }, data: { status: "done" } });
    const workerRun = await prisma.run.findUniqueOrThrow({ where: { id: delivery.runId } });
    await prisma.run.update({
      where: { id: workerRun.id },
      data: { status: "running", leaseOwner: "wake-worker-fixture", leaseFence: 1 },
    });
    const workerAttempt = await prisma.attempt.create({
      data: { runId: workerRun.id, fence: 1, status: "running" },
    });
    // This fixture tests the source result in one manually constructed wake.
    // Reserve the completion claim so reconciliation cannot create a competing wake.
    await prisma.delegation.update({
      where: { id: delivery.delegationId },
      data: { coordinatorWokenAt: new Date() },
    });
    const workerThreadId = workerRun.threadId;
    const finished = await finalizeRun(prisma, {
      spaceId: worker.spaceId,
      threadId: workerThreadId,
      botId: worker.id,
      runId: workerRun.id,
      taskId: workerRun.taskId,
      attemptId: workerAttempt.id,
      leaseOwner: "wake-worker-fixture",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: distinctResult }],
    });
    expect(finished).not.toBe(false);
    const summary = await prisma.delegation.findUniqueOrThrow({
      where: { id: delivery.delegationId },
      select: { summaryMessageId: true },
    });
    expect(summary.summaryMessageId).toBeTruthy();
    const wakeTask = await prisma.task.create({
      data: {
        spaceId: coordinator.spaceId,
        userId: ownerMe.userId,
        botId: coordinator.id,
        threadId: group.threadId,
        prompt: "Review the completed assignment.",
        status: "queued",
      },
    });
    const requests: string[] = [];
    const originalRun = ScriptedAgentRuntime.prototype.run;
    let wakeId: string | null = null;
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) => {
        if (request.runId === wakeId) {
          requests.push(
            toHistory(request.history, request.prompt, request.sourceMessageId)
              .map((message) => message.content)
              .join("\n"),
          );
        }
        return originalRun.call(new ScriptedAgentRuntime(), request, context);
      });
    try {
      // The reconciler only dispatches queued runs. Hold this fixture in waiting_input
      // until the explicit continuation so the spy observes its sole execution.
      const wake = await prisma.run.create({
        data: {
          spaceId: coordinator.spaceId,
          userId: ownerMe.userId,
          botId: coordinator.id,
          threadId: group.threadId,
          taskId: wakeTask.id,
          status: "waiting_input",
          trigger: "follow_up",
          sourceMessageId: summary.summaryMessageId,
          clientNonce: `goal-wake:wake-budget-${stamp}`,
          goalId: goal.id,
          delegationRootTaskId: goal.rootTaskId,
          runtimePin: completedStart.runtimePin ?? pin,
          runtimeDestination: completedStart.runtimeDestination ?? undefined,
          runtimeComputer: completedStart.runtimeComputer ?? undefined,
        },
      });
      wakeId = wake.id;
      await createThreadMessage(prisma, {
        threadId: group.threadId,
        role: "user",
        blocks: [{ kind: "text", text: `Later room context: ${"x".repeat(12_100)}` }],
      });
      await executor.continueRun(wake.id, "wake-budget-fixture");
    } finally {
      runtimeSpy.mockRestore();
    }
    if (requests.length === 0) {
      const skipped = await prisma.run.findUniqueOrThrow({ where: { id: wakeId! } });
      throw new Error(
        `Wake runtime was not entered: ${skipped.status}: ${skipped.error ?? "none"}`,
      );
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(distinctResult);
    expect(requests[0]!.match(new RegExp(distinctResult, "g"))).toHaveLength(1);
    await settleFixtureWork([coordinator.id, worker.id], goal.id);
  });

  it("delivers a non-goal message beside an owner send without a deadlock or lost send", async () => {
    const owner = await signup(app, `delivery-send-${stamp}@ardurbot.test`, "Delivery owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    const sender = await rpc<Bot>(app, owner, "bots/create", {
      name: "Sender",
      title: "Worker",
      description: "",
      instructions: "",
    });
    const recipient = await rpc<Bot>(app, owner, "bots/create", {
      name: "Recipient",
      title: "Worker",
      description: "",
      instructions: "",
    });
    const [senderRow, recipientRow] = await Promise.all([
      prisma.bot.findUniqueOrThrow({ where: { id: sender.id }, select: { thread: true } }),
      prisma.bot.findUniqueOrThrow({ where: { id: recipient.id }, select: { thread: true } }),
    ]);
    const task = await prisma.task.create({
      data: {
        spaceId: sender.spaceId,
        userId: ownerMe.userId,
        botId: sender.id,
        threadId: senderRow.thread!.id,
        prompt: "Send the result.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: sender.spaceId,
        userId: ownerMe.userId,
        botId: sender.id,
        threadId: senderRow.thread!.id,
        taskId: task.id,
        trigger: "user",
        status: "running",
        runtimePin: {
          runtimeKind: "pi",
          provider: "scripted",
          modelId: "scripted",
          effort: "off",
          credentialId: "scripted",
          revision: 0,
        },
      },
    });
    const recipientThreadId = recipientRow.thread!.id;
    let reachedRecipientThread!: () => void;
    let releaseDelivery!: () => void;
    const lockedRecipientThread = new Promise<void>((resolve) => {
      reachedRecipientThread = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const transactionErrors: unknown[] = [];
    const deliveryPrisma = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: typeof prisma) => Promise<unknown>) =>
          prisma
            .$transaction(async (tx) =>
              work(
                new Proxy(tx, {
                  get(txTarget, operation) {
                    if (operation !== "$queryRaw") return Reflect.get(txTarget, operation);
                    return async (...args: unknown[]) => {
                      const result = await (
                        txTarget.$queryRaw as (...args: unknown[]) => Promise<unknown>
                      )(...args);
                      if (
                        String(args[0]).includes("FROM threads") &&
                        args.includes(recipientThreadId)
                      ) {
                        reachedRecipientThread();
                        await deliveryGate;
                      }
                      return result;
                    };
                  },
                }) as typeof prisma,
              ),
            )
            .catch((error: unknown) => {
              transactionErrors.push(error);
              throw error;
            });
      },
    }) as typeof prisma;
    const quietJobs = {
      enqueue: async () => undefined,
      cancel: async () => undefined,
    } as typeof jobs;
    const delivery = messageBot(
      {
        prisma: deliveryPrisma,
        events: createThreadEvents(deliveryPrisma),
        jobs: quietJobs,
        resolveDelegationPin: async () =>
          ({
            kind: "resolved",
            pin: {
              runtimeKind: "pi",
              provider: "scripted",
              modelId: "scripted",
              effort: "off",
              credentialId: "scripted",
              revision: 0,
            },
            provider: "scripted",
            id: "scripted",
            thinkingLevel: "off",
          }) as never,
      },
      run,
      { id: sender.id, name: sender.name },
      {
        bot_id: recipient.id,
        confirm_name: recipient.name,
        message: "Delivered result.",
        deliveryKey: `delivery-send:${run.id}`,
      },
    );
    await lockedRecipientThread;
    const send = sendUserMessage(prisma, {
      spaceId: recipient.spaceId,
      threadId: recipientThreadId,
      botId: recipient.id,
      userId: ownerMe.userId,
      blocks: [{ kind: "text", text: "Owner follow-up." }],
      prompt: "Owner follow-up.",
      trigger: "follow_up",
      clientNonce: `owner-send:${run.id}`,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      releaseDelivery();
    }
    const [delivered, submitted] = await Promise.all([delivery, send]);
    if (!delivered.ok) throw new Error(delivered.error);
    expect(transactionErrors).toEqual([]);
    expect(submitted.messageId).toBeTruthy();
    expect(
      await prisma.message.count({
        where: { threadId: recipientThreadId, clientNonce: `owner-send:${run.id}` },
      }),
    ).toBe(1);
    await settleFixtureWork([sender.id, recipient.id]);
  });

  it("submits steering while finalization waits without a database deadlock", async () => {
    const owner = await signup(app, `finalize-send-${stamp}@ardurbot.test`, "Concurrent owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    const bot = await rpc<Bot>(app, owner, "bots/create", {
      name: "Concurrent worker",
      title: "Worker",
      description: "",
      instructions: "",
    });
    const thread = await prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { thread: { select: { id: true } } },
    });
    const threadId = thread.thread!.id;
    const task = await prisma.task.create({
      data: {
        spaceId: bot.spaceId,
        userId: ownerMe.userId,
        botId: bot.id,
        threadId,
        prompt: "Finish the first request.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: bot.spaceId,
        userId: ownerMe.userId,
        botId: bot.id,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseOwner: "concurrent-test",
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    let reachedBusy!: () => void;
    const busyRead = new Promise<void>((resolve) => {
      reachedBusy = resolve;
    });
    let releaseBusy!: () => void;
    const continueSend = new Promise<void>((resolve) => {
      releaseBusy = resolve;
    });
    const sendPrisma = {
      message: prisma.message,
      $transaction: (work: (tx: typeof prisma) => Promise<unknown>) =>
        prisma.$transaction(async (tx) =>
          work(
            new Proxy(tx, {
              get(target, key) {
                if (key !== "run") return Reflect.get(target, key);
                return new Proxy(target.run, {
                  get(runClient, operation) {
                    if (operation !== "findFirst") return Reflect.get(runClient, operation);
                    return async (...args: Parameters<typeof runClient.findFirst>) => {
                      const busy = await runClient.findFirst(...args);
                      if (busy?.id === run.id) {
                        reachedBusy();
                        await continueSend;
                      }
                      return busy;
                    };
                  },
                });
              },
            }) as typeof prisma,
          ),
        ),
    } as typeof prisma;
    const send = sendUserMessage(sendPrisma, {
      spaceId: bot.spaceId,
      threadId,
      botId: bot.id,
      userId: ownerMe.userId,
      blocks: [{ kind: "text", text: "One more detail." }],
      prompt: "One more detail.",
      trigger: "follow_up",
    });
    await busyRead;
    const finish = finalizeRun(prisma, {
      spaceId: bot.spaceId,
      threadId,
      botId: bot.id,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      leaseOwner: "concurrent-test",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Finished." }],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      releaseBusy();
    }
    const [submitted, finalized] = await Promise.all([send, finish]);
    expect(submitted.runId).toBe(run.id);
    expect(finalized).not.toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
    });
    expect(await prisma.steeringMessage.count({ where: { botId: bot.id } })).toBe(1);
  });

  it("a spent goal cancels a waiting coordinator and releases new room messages", async () => {
    const owner = await signup(app, `budget-j-${stamp}@ardurbot.test`, "Budget owner");
    const ownerMe = await rpc<Me>(app, owner, "me");
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerMe.userId },
    });
    const coordinator = await rpc<Bot>(app, owner, "bots/create", {
      name: "Budget Lead",
      title: "Lead",
      description: "",
      instructions: "",
    });
    const peer = await rpc<Bot>(app, owner, "bots/create", {
      name: "Budget Peer",
      title: "Reviewer",
      description: "",
      instructions: "",
    });
    const group = await rpc<{ id: string; threadId: string }>(app, owner, "groups/create", {
      name: "Budget room",
      botIds: [coordinator.id, peer.id],
    });
    await rpc(app, owner, "groups/update", { groupId: group.id, coordinatorBotId: coordinator.id });
    const goal = await rpc<{ id: string; rootTaskId: string; tokenLimit: number }>(
      app,
      owner,
      "goals/start",
      {
        groupId: group.id,
        objective: "Ask me which city before reporting readiness",
        tokenLimit: 100,
      },
    );
    const first = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-start:${goal.id}` },
    });
    await waitForDatabase(
      async () =>
        (await prisma.run.findUnique({ where: { id: first.id }, select: { status: true } }))
          ?.status === "waiting_input",
    );
    // Model A's recorded screen ownership before B takes over the bot-scoped screen.
    const oldScreenLeaseId = `${first.id}:1`;
    await prisma.run.update({
      where: { id: first.id },
      data: { screenLeaseId: oldScreenLeaseId },
    });
    const computer = (
      await prisma.bot.findUniqueOrThrow({
        where: { id: coordinator.id },
        include: { computer: true },
      })
    ).computer!;
    const computerRef = toComputerRef(computer);
    const screen = (await owningSandbox(sandbox, computer, {
      operationId: first.id,
      traceId: first.id,
      spaceId: first.spaceId,
      userId: first.userId,
      botId: coordinator.id,
      screenLeaseId: oldScreenLeaseId,
      signal: new AbortController().signal,
    })) as FakeSandboxProvider;
    await screen.observe(computerRef, {
      operationId: first.id,
      traceId: first.id,
      spaceId: first.spaceId,
      userId: first.userId,
      botId: coordinator.id,
      screenLeaseId: oldScreenLeaseId,
      signal: new AbortController().signal,
    });
    await prisma.delegationRoot.update({
      where: { rootTaskId: goal.rootTaskId },
      data: { usedTokens: goal.tokenLimit },
    });
    const reconciler = createJobReconciler({ prisma, jobs });
    await reconciler.reconcileOnce();
    expect(
      (await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: goal.rootTaskId } }))
        .cancelRequestedAt,
    ).not.toBeNull();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      "waiting_input",
    );
    let resumeOrdinary!: () => void;
    let ordinaryStarted!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      resumeOrdinary = resolve;
    });
    const ordinaryReady = new Promise<void>((resolve) => {
      ordinaryStarted = resolve;
    });
    const originalRun = ScriptedAgentRuntime.prototype.run;
    const runtimeSpy = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation((request, context) =>
        (async function* () {
          ordinaryStarted();
          await ordinaryGate;
          yield* originalRun.call(new ScriptedAgentRuntime(), request, context);
        })(),
      );
    onTestFinished(() => {
      resumeOrdinary();
      runtimeSpy.mockRestore();
    });
    const { runId } = await rpc<{ runId: string }>(app, owner, "threads/send", {
      groupId: group.id,
      text: "Say hello to the room",
    });
    expect(runId).not.toBe(first.id);
    await ordinaryReady;
    await waitForDatabase(
      async () =>
        (await prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))
          ?.status === "running",
    );
    const newerScreenLeaseId = `${runId}:2`;
    await screen.observe(computerRef, {
      operationId: runId,
      traceId: runId,
      spaceId: first.spaceId,
      userId: first.userId,
      botId: coordinator.id,
      screenLeaseId: newerScreenLeaseId,
      signal: new AbortController().signal,
    });
    const release = vi.spyOn(screen, "releaseScreen");
    try {
      expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("running");
      await executor.continueRun(first.id, "goal-stop-fixture");
      expect(release).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ screenLeaseId: oldScreenLeaseId }),
      );
      expect(screen.boxes.get(computerRef.id)?.screenLeases.get(coordinator.id)).toBe(
        newerScreenLeaseId,
      );
    } finally {
      release.mockRestore();
      resumeOrdinary();
      runtimeSpy.mockRestore();
    }
    await waitForDatabase(
      async () =>
        (await prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))
          ?.status === "completed",
    );
    const ordinary = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(ordinary.goalId).toBeNull();
    expect(ordinary.delegationRootTaskId).toBeNull();
    await reconciler.reconcileOnce();
    expect(
      await prisma.run.findUnique({
        where: { id: first.id },
        select: { status: true, cancelRequestedAt: true, leaseOwner: true },
      }),
    ).toMatchObject({ status: "cancelled", cancelRequestedAt: expect.any(Date) });
    await reconciler.reconcileOnce();
    const current = await rpc<{ status: string }>(app, owner, "goals/get", {
      groupId: group.id,
    });
    expect(current.status).toBe("exhausted");
    await prisma.delegationRoot.update({
      where: { rootTaskId: goal.rootTaskId },
      data: { cancelRequestedAt: null },
    });
    expect(
      (await rpc<{ status: string }>(app, owner, "goals/stop", { goalId: goal.id })).status,
    ).toBe("exhausted");
    expect(
      (await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: goal.rootTaskId } }))
        .cancelRequestedAt,
    ).not.toBeNull();
    expect(
      await prisma.event.count({
        where: { threadId: group.threadId, type: "goal.exhausted" },
      }),
    ).toBe(1);
  });

  it("55: group chats share one transcript with mentions and handoffs", async () => {
    const ada = await signup(app, `ada-g-${stamp}@ardurbot.test`, "Ada Groups");
    const adaMe = await rpc<Me>(app, ada, "me");
    const botA = await rpc<Bot>(app, ada, "bots/create", {
      name: "BotA",
      title: "Researcher",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<Bot>(app, ada, "bots/create", {
      name: "BotB",
      title: "Writer",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botC = await rpc<Bot>(app, ada, "bots/create", {
      name: "Writer",
      title: "Editor",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botD = await rpc<Bot>(app, ada, "bots/create", {
      name: "Research Writer",
      title: "Analyst",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string; members: Array<{ botId: string }> }>(
      app,
      ada,
      "groups/create",
      { name: "Research squad", botIds: [botA.id, botB.id, botC.id, botD.id] },
    );
    const listed = await rpc<Array<{ id: string }>>(app, ada, "groups/list");
    expect(listed.some((row) => row.id === group.id)).toBe(true);
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((b) => b.id)).toEqual(
      expect.arrayContaining([botA.id, botB.id, botC.id, botD.id]),
    );

    await sendGroupAndWait(app, ada, group.id, "@BotA gather sources. @BotB summarize.");
    const mentioned = await rpc<Snap & { threadId: string }>(app, ada, "threads/get", {
      groupId: group.id,
    });
    expect(new Set(mentioned.messages.map((m) => m.seq)).size).toBeGreaterThan(0);
    const runsAfterMention = await prisma.run.findMany({
      where: { threadId: group.threadId, botId: { in: [botA.id, botB.id] } },
      orderBy: { createdAt: "desc" },
      take: 4,
    });
    expect(runsAfterMention.some((run) => run.botId === botA.id)).toBe(true);
    expect(runsAfterMention.some((run) => run.botId === botB.id)).toBe(true);

    const countUserRuns = async (botId: string) =>
      prisma.run.count({
        where: { threadId: group.threadId, trigger: "user", botId },
      });
    const botABefore = await countUserRuns(botA.id);
    const botBBefore = await countUserRuns(botB.id);
    const botCBefore = await countUserRuns(botC.id);
    const botDBefore = await countUserRuns(botD.id);
    await sendGroupAndWait(app, ada, group.id, "hello team");
    expect(
      (await countUserRuns(botA.id)) +
        (await countUserRuns(botB.id)) +
        (await countUserRuns(botC.id)) +
        (await countUserRuns(botD.id)),
    ).toBe(botABefore + botBBefore + botCBefore + botDBefore + 1);

    await sendGroupAndWait(app, ada, group.id, "@BotA hand this to Writer for the draft", botA.id);
    const handoffSnap = await rpc<Snap>(app, ada, "threads/get", { groupId: group.id });
    expect(
      handoffSnap.messages.some((message) =>
        (message.blocks as Array<{ kind?: string }>).some((block) => block.kind === "handoff"),
      ),
    ).toBe(true);

    const groupAsk = await rpc<{ runId: string }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "@Research Writer ask me which city to use",
    });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: groupAsk.runId } });
      return run?.status === "waiting_input";
    });
    const groupsWithActiveMember = await rpc<
      Array<{ id: string; members: Array<{ botId: string; status?: string }> }>
    >(app, ada, "groups/list");
    expect(
      groupsWithActiveMember
        .find((listedGroup) => listedGroup.id === group.id)
        ?.members.find((member) => member.botId === botD.id)?.status,
    ).toBe("waiting_input");
    const activeGroupSnapshot = await rpc<{
      members?: Array<{ botId: string; status?: string }>;
    }>(app, ada, "threads/get", { groupId: group.id });
    expect(activeGroupSnapshot.members?.find((member) => member.botId === botD.id)?.status).toBe(
      "waiting_input",
    );
    const concurrentTask = await prisma.task.create({
      data: {
        spaceId: botA.spaceId,
        botId: botA.id,
        threadId: group.threadId,
        userId: adaMe.userId,
        prompt: "concurrent work",
        status: "running",
      },
    });
    const concurrentRun = await prisma.run.create({
      data: {
        spaceId: botA.spaceId,
        botId: botA.id,
        threadId: group.threadId,
        taskId: concurrentTask.id,
        userId: adaMe.userId,
        status: "running",
        trigger: "user",
        createdAt: new Date(Date.now() + 1_000),
      },
    });
    const askSnapshot = await rpc<Snap>(app, ada, "threads/get", { groupId: group.id });
    // Waiting asks win the headline run even when a newer busy run exists.
    expect(askSnapshot.run?.id).toBe(groupAsk.runId);
    expect(askSnapshot.activeRuns?.some((run) => run.id === concurrentRun.id)).toBe(true);
    expect(askSnapshot.activeRuns?.some((run) => run.id === groupAsk.runId)).toBe(true);
    const askMessage = askSnapshot.messages.find(
      (message) =>
        message.runId === groupAsk.runId &&
        message.blocks.some((block) => block.kind === "ask" && block.status !== "answered"),
    );
    expect(askMessage).toBeTruthy();
    await rpc(app, ada, "threads/answer", {
      groupId: group.id,
      runId: groupAsk.runId,
      messageId: askMessage!.id,
      answer: "Paris",
    });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: groupAsk.runId } });
      return run?.status === "completed";
    });
    const answerEvent = await prisma.event.findFirstOrThrow({
      where: {
        threadId: group.threadId,
        runId: groupAsk.runId,
        type: "thread.message.updated",
      },
      orderBy: { seq: "desc" },
    });
    expect(answerEvent.botId).toBe(botD.id);
    await prisma.$transaction([
      prisma.run.update({
        where: { id: concurrentRun.id },
        data: { status: "cancelled", completedAt: new Date() },
      }),
      prisma.task.update({ where: { id: concurrentTask.id }, data: { status: "cancelled" } }),
    ]);

    const staleTask = await prisma.task.create({
      data: {
        spaceId: botB.spaceId,
        botId: botB.id,
        threadId: group.threadId,
        userId: adaMe.userId,
        prompt: "stale handoff",
        status: "running",
      },
    });
    const staleRun = await prisma.run.create({
      data: {
        spaceId: botB.spaceId,
        botId: botB.id,
        threadId: group.threadId,
        taskId: staleTask.id,
        userId: adaMe.userId,
        status: "running",
        trigger: "user",
      },
    });
    const replayNonce = `group-replay-${stamp}`;
    const firstSend = await rpc<{ runId: string; runIds?: string[] }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "@BotA gather updates. @BotB compare them.",
      clientNonce: replayNonce,
    });
    await rpc(app, ada, "groups/update", {
      groupId: group.id,
      botIds: [botA.id, botC.id, botD.id],
    });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: staleRun.id } })).status).toBe(
      "cancelled",
    );
    const replayedSend = await rpc<{ runId: string; runIds?: string[] }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "this changed text must not create another message",
      clientNonce: replayNonce,
    });
    expect(replayedSend.runId).toBe(firstSend.runId);
    expect(replayedSend.runIds).toEqual(firstSend.runIds);
    const replayMessage = await prisma.message.findUniqueOrThrow({
      where: { threadId_clientNonce: { threadId: group.threadId, clientNonce: replayNonce } },
      include: { sourceRuns: true },
    });
    expect(replayMessage.sourceRuns).toHaveLength(1);
    await expect(
      prisma.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: replayMessage.id, botId: botB.id } },
      }),
    ).resolves.toMatchObject({ runId: staleRun.id, claimedAt: null });
    expect(
      await prisma.message.count({ where: { threadId: group.threadId, clientNonce: replayNonce } }),
    ).toBe(1);
    const messageEvents = await prisma.event.findMany({
      where: { threadId: group.threadId, type: "thread.message.created" },
      select: { payload: true },
    });
    expect(
      messageEvents.filter(
        (event) => (event.payload as { messageId?: string } | null)?.messageId === replayMessage.id,
      ),
    ).toHaveLength(1);

    const staleHandoff = await handoffToGroupBot(
      { prisma, events: createThreadEvents(prisma), jobs },
      {
        id: staleRun.id,
        spaceId: botB.spaceId,
        threadId: group.threadId,
        botId: botB.id,
        userId: staleTask.userId,
      },
      group.id,
      { bot_id: botC.id, message: "should be rejected" },
    );
    expect(staleHandoff).toEqual({ error: "source run is no longer active" });

    const crossThread = await rpc<{ runId: string }>(app, ada, "threads/send", {
      botId: botC.id,
      text: "the same nonce is valid in a different thread",
      clientNonce: replayNonce,
    });
    expect(crossThread.runId).not.toBe(firstSend.runId);

    const attachmentText = "group attachment content";
    const artifact = await rpc<{ id: string }>(app, ada, "artifacts/create", {
      groupId: group.id,
      name: "group-note.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from(attachmentText).toString("base64"),
    });
    const attached = await rpc<{ runId: string }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "@Research Writer inspect the attachment",
      artifactIds: [artifact.id],
    });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: attached.runId } });
      return Boolean(run && ["completed", "failed", "cancelled"].includes(run.status));
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: attached.runId } })).toMatchObject({
      botId: botD.id,
      status: "completed",
      error: null,
    });
    const downloaded = await rpc<{ contentBase64: string }>(app, ada, "artifacts/get", {
      groupId: group.id,
      artifactId: artifact.id,
    });
    expect(Buffer.from(downloaded.contentBase64, "base64").toString()).toBe(attachmentText);

    const artifactOwnerId = (
      await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })
    ).botId;
    if (!artifactOwnerId) throw new Error("Group artifact is missing its uploader");
    const remainingGroupBotIds = [botA.id, botC.id, botD.id].filter(
      (botId) => botId !== artifactOwnerId,
    );
    expect(remainingGroupBotIds).toHaveLength(2);
    await rpc(app, ada, "groups/update", {
      groupId: group.id,
      botIds: remainingGroupBotIds,
    });
    await rpc(app, ada, "bots/remove", { botId: artifactOwnerId, deleteMemories: true });
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({
      botId: null,
      groupId: group.id,
    });
    const downloadedAfterUploaderRemoval = await rpc<{ contentBase64: string }>(
      app,
      ada,
      "artifacts/get",
      { groupId: group.id, artifactId: artifact.id },
    );
    expect(Buffer.from(downloadedAfterUploaderRemoval.contentBase64, "base64").toString()).toBe(
      attachmentText,
    );

    const archiveMember = await rpc<Bot>(app, ada, "bots/create", {
      name: "Archive Member",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const archivePartner = await rpc<Bot>(app, ada, "bots/create", {
      name: "Archive Partner",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const archiveGroup = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Archive invariant",
      botIds: [archiveMember.id, archivePartner.id],
    });
    const archiveThread = await prisma.thread.findUniqueOrThrow({
      where: { groupId: archiveGroup.id },
      select: { id: true },
    });
    await rpc(app, ada, "bots/archive", { botId: archiveMember.id });
    expect(
      await prisma.chatGroup.findUniqueOrThrow({
        where: { id: archiveGroup.id },
        include: { members: true, thread: { select: { id: true } } },
      }),
    ).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ botId: archiveMember.id }),
        expect.objectContaining({ botId: archivePartner.id }),
      ]),
      thread: archiveThread,
    });
    const groupsWhileUndersized = await rpc<Array<{ id: string }>>(app, ada, "groups/list");
    expect(groupsWhileUndersized.some((row) => row.id === archiveGroup.id)).toBe(false);
    await expect(rpc(app, ada, "threads/get", { groupId: archiveGroup.id })).rejects.toThrow();
    await expect(
      rpc(app, ada, "threads/send", {
        groupId: archiveGroup.id,
        text: "This hidden group must not run with one active member",
      }),
    ).rejects.toThrow();
    await rpc(app, ada, "bots/restore", { botId: archiveMember.id });
    const restoredArchiveGroup = await rpc<
      Array<{ id: string; members: Array<{ botId: string }> }>
    >(app, ada, "groups/list");
    expect(restoredArchiveGroup.find((row) => row.id === archiveGroup.id)?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ botId: archiveMember.id }),
        expect.objectContaining({ botId: archivePartner.id }),
      ]),
    );
    const archiveThird = await rpc<Bot>(app, ada, "bots/create", {
      name: "Archive Third",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, ada, "groups/update", {
      groupId: archiveGroup.id,
      botIds: [archiveMember.id, archivePartner.id, archiveThird.id],
    });
    await rpc(app, ada, "bots/archive", { botId: archiveMember.id });
    const dissolvingTask = await prisma.task.create({
      data: {
        spaceId: archivePartner.spaceId,
        botId: archivePartner.id,
        threadId: archiveThread.id,
        userId: adaMe.userId,
        prompt: "fake active work while deleting a group member",
        status: "running",
      },
    });
    const dissolvingRun = await prisma.run.create({
      data: {
        spaceId: archivePartner.spaceId,
        botId: archivePartner.id,
        threadId: archiveThread.id,
        taskId: dissolvingTask.id,
        userId: adaMe.userId,
        status: "running",
        trigger: "user",
      },
    });
    await rpc(app, ada, "bots/remove", { botId: archiveThird.id, deleteMemories: true });
    expect(await prisma.chatGroup.findUnique({ where: { id: archiveGroup.id } })).toBeNull();
    expect(await prisma.run.findUnique({ where: { id: dissolvingRun.id } })).toBeNull();
    await rpc(app, ada, "bots/restore", { botId: archiveMember.id });
    expect(await prisma.chatGroup.findUnique({ where: { id: archiveGroup.id } })).toBeNull();

    const deletionPartner = await rpc<Bot>(app, ada, "bots/create", {
      name: "Deletion Partner",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const deletionGroup = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Deletion invariant",
      botIds: [botB.id, deletionPartner.id],
    });
    await expect(prisma.bot.delete({ where: { id: botB.id } })).rejects.toThrow();
    expect(await prisma.chatGroup.findUnique({ where: { id: deletionGroup.id } })).not.toBeNull();
    await rpc(app, ada, "bots/remove", { botId: botB.id, deleteMemories: true });
    expect(await prisma.chatGroup.findUnique({ where: { id: deletionGroup.id } })).toBeNull();

    await rpc(app, ada, "groups/remove", { groupId: group.id });
    expect(await prisma.artifact.findUnique({ where: { id: artifact.id } })).toBeNull();
    const remainingBotIds = (await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id);
    expect(remainingBotIds).toEqual(
      expect.arrayContaining([
        ...remainingGroupBotIds,
        deletionPartner.id,
        archiveMember.id,
        archivePartner.id,
      ]),
    );
    expect(remainingBotIds).not.toContain(artifactOwnerId);
  });

  it("17: teach a task end to end", async () => {
    const cookie = await signup(app, `teach-j-${stamp}@ardurbot.test`, "Teach Ada");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Teacher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    void rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "keep working until I stop you",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const skill = await rpc<{
      id: string;
      status: string;
      playbook: { steps: string[] };
      recording: { events: Array<{ kind: string }> };
    }>(app, cookie, "skills/start", {
      botId: bot.id,
      goal: "Export weekly CRM list",
    });
    expect(skill.status).toBe("recording");
    await rpc(app, cookie, "computer/input", {
      botId: bot.id,
      kind: "pointer",
      payload: { x: 120, y: 40, button: "left", type: "click" },
    });
    await rpc(app, cookie, "computer/input", {
      botId: bot.id,
      kind: "key",
      payload: { key: "x" },
    });
    const blocked = await raw(app, cookie, "threads/send", {
      botId: bot.id,
      text: "please act now",
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    const stopped = await rpc<TaughtSkill>(app, cookie, "skills/stop", { skillId: skill.id });
    expect(stopped.status).toBe("draft");
    expect(stopped.playbook.steps.join(" ")).toMatch(/Click|120|40|x/i);
    expect(stopped.recording.events.some((event) => event.kind === "pointer")).toBe(true);
    expect(stopped.recording.snapshots.length).toBeGreaterThanOrEqual(2);
    const computerAfterStop = await rpc<{ controlHolder: string; controlBotId: string | null }>(
      app,
      cookie,
      "computer/status",
      { botId: bot.id },
    );
    expect(computerAfterStop.controlHolder).toBe("bot");
    expect(computerAfterStop.controlBotId).toBeNull();
    await rpc(app, cookie, "skills/updateDraft", {
      skillId: skill.id,
      name: "Export weekly CRM list",
      playbook: stopped.playbook,
      expectedRevision: stopped.activeRevision,
    });
    const saved = await rpc<{ status: string; name: string }>(app, cookie, "skills/save", {
      skillId: skill.id,
      name: "Export weekly CRM list",
    });
    expect(saved.status).toBe("saved");
    const listed = await rpc<Array<{ id: string; name: string }>>(app, cookie, "skills/list", {
      botId: bot.id,
    });
    expect(listed.some((row) => row.id === skill.id)).toBe(true);
    const testRun = await rpc<{ runId: string }>(app, cookie, "skills/testRun", {
      skillId: skill.id,
    });
    expect(testRun.runId).toBeTruthy();
    const tested = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) =>
        snap.contextRun?.id === testRun.runId &&
        ["completed", "failed", "cancelled"].includes(snap.contextRun.status),
    );
    expect(tested.contextRun).toMatchObject({ id: testRun.runId, status: "completed" });
    await sendAndWait(app, cookie, bot.id, "run Export weekly CRM list");
    const messages = (await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id })).messages;
    const botText = JSON.stringify(messages);
    expect(botText.toLowerCase()).toContain("taught skill");
  });

  it("18: teaching expiry auto-stops recording", async () => {
    const previousTtl = process.env.TEACH_RECORDING_TTL_MS;
    process.env.TEACH_RECORDING_TTL_MS = "1000";
    try {
      const cookie = await signup(app, `teach-exp-j-${stamp}@ardurbot.test`, "Teach Exp Ada");
      const bot = await rpc<Bot>(app, cookie, "bots/create", {
        name: "Timer",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      await rpc(app, cookie, "computer/boot", { botId: bot.id });
      await rpc(app, cookie, "computer/takeover", { botId: bot.id });
      const skill = await rpc<{ id: string; status: string }>(app, cookie, "skills/start", {
        botId: bot.id,
        goal: "Timed demo",
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const current = await rpc<{ status: string }>(app, cookie, "skills/get", {
        skillId: skill.id,
      });
      expect(["draft", "drafting"].includes(current.status)).toBe(true);
    } finally {
      if (previousTtl === undefined) delete process.env.TEACH_RECORDING_TTL_MS;
      else process.env.TEACH_RECORDING_TTL_MS = previousTtl;
    }
  });

  it("19: destination writes pause for approval before side effects", async () => {
    const cookie = await signup(app, `approval-j-${stamp}@ardurbot.test`, "Approval");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const recordsBefore = connector.records.length;
    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "destination.write",
    });

    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(JSON.stringify(waiting.messages)).toMatch(/allow once|review before/i);
    expect(connector.records).toHaveLength(recordsBefore);
    await answerPendingApproval(app, cookie, bot.id, sent.runId, "allow", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBeGreaterThan(recordsBefore);

    const task = await prisma.task.findFirstOrThrow({
      where: { runs: { some: { id: sent.runId } } },
    });
    expect(task.prompt).toBe("write this to the destination crm as a note");

    const recordsAfterAllow = connector.records.length;
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note again",
    });
    const waitingAgain = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    await answerPendingApproval(app, cookie, bot.id, second.runId, "deny", waitingAgain);
    const denied = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records).toHaveLength(recordsAfterAllow);
    expect(denied.run?.status ?? "completed").toBe("completed");
    const deniedEffect = await prisma.externalEffect.findFirst({
      where: { runId: second.runId, kind: "destination.write" },
    });
    expect(deniedEffect?.status).toBe("denied");
  });

  it("20: actions run by default and specific exceptions override broad review rules", async () => {
    const cookie = await signup(app, `always-j-${stamp}@ardurbot.test`, "Always");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const prompt = "write this to the destination crm as a note";
    const recordsBefore = connector.records.length;

    await sendAndWait(app, cookie, bot.id, prompt);
    expect(connector.records.length).toBeGreaterThan(recordsBefore);
    const recordsAfterDefault = connector.records.length;

    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "connector",
      matchValue: "destination.write",
    });
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note again",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    await answerPendingApproval(app, cookie, bot.id, second.runId, "always", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBe(recordsAfterDefault + 1);

    await sendAndWait(app, cookie, bot.id, "write this to the destination crm once more");
    expect(connector.records.length).toBe(recordsAfterDefault + 2);

    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    const fourth = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm one final time",
    });
    const waitingAgain = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(connector.records.length).toBe(recordsAfterDefault + 2);
    await answerPendingApproval(app, cookie, bot.id, fourth.runId, "allow", waitingAgain);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBe(recordsAfterDefault + 3);
  });

  it("21: routine destination writes pause on the same approval card", async () => {
    const cookie = await signup(
      app,
      `routine-approval-j-${stamp}@ardurbot.test`,
      "Routine Approval",
    );
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Send note",
      prompt: "write this to the destination crm as a note",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const recordsBefore = connector.records.length;
    const tested = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(connector.records).toHaveLength(recordsBefore);
    await answerPendingApproval(app, cookie, bot.id, tested.runId, "allow", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBeGreaterThan(recordsBefore);
  });

  it("22: a routine schedule with any malformed or mixed one-shot cron is rejected", async () => {
    const cookie = await signup(app, `routine-crons-j-${stamp}@ardurbot.test`, "Routine Crons");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Scheduler",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const partiallyInvalid = await raw(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Bad schedule",
      prompt: "check the fixture",
      crons: ["0 9 * * *", "not-a-cron"],
      timezone: "UTC",
      notify: false,
      active: true,
    });
    expect(partiallyInvalid.status).toBeGreaterThanOrEqual(400);
    const mixedOneShot = await raw(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Mixed schedule",
      prompt: "check the fixture",
      crons: ["@once", "0 9 * * *"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    expect(mixedOneShot.status).toBeGreaterThanOrEqual(400);
  });

  it("23: never-run one-shot templates can be armed with a future runAt", async () => {
    const cookie = await signup(app, `once-arm-j-${stamp}@ardurbot.test`, "Once Arm");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Once Bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await prisma.routine.create({
      data: {
        spaceId: me.spaceId,
        userId: me.userId,
        botId: bot.id,
        name: "Remind once",
        prompt: "Ping me once",
        crons: ["@once"],
        timezone: "UTC",
        notify: true,
        active: false,
        nextRunAt: null,
      },
    });

    const withoutTime = await raw(app, cookie, "routines/update", {
      routineId: routine.id,
      active: true,
    });
    expect(withoutTime.status).toBeGreaterThanOrEqual(400);

    const runAt = new Date(Date.now() + 120_000).toISOString();
    const armed = await rpc<{ active: boolean; nextRunAt: string | null }>(
      app,
      cookie,
      "routines/update",
      {
        routineId: routine.id,
        active: true,
        runAt,
      },
    );
    expect(armed.active).toBe(true);
    expect(armed.nextRunAt).toBe(runAt);

    await prisma.routine.update({
      where: { id: routine.id },
      data: { active: false, nextRunAt: null, lastRunAt: new Date() },
    });
    const afterFire = await raw(app, cookie, "routines/update", {
      routineId: routine.id,
      active: true,
      runAt: new Date(Date.now() + 180_000).toISOString(),
    });
    expect(afterFire.status).toBeGreaterThanOrEqual(400);
  });

  it("24: chat creates a space only after explicit approval", async () => {
    const cookie = await signup(app, `space-chat-j-${stamp}@ardurbot.test`, "Space Chat");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const membershipsBefore = await prisma.spaceMember.count({ where: { userId: me.userId } });
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "create a space named Customer support",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.id === sent.runId && snap.run.status === "waiting_input",
    );
    const approval = JSON.stringify(waiting.messages);
    expect(approval).toContain("Create space");
    expect(approval).toContain("Customer support");
    expect(approval).toContain("Cancel");
    expect(approval).not.toContain("Always allow this tool");
    expect(await prisma.spaceMember.count({ where: { userId: me.userId } })).toBe(
      membershipsBefore,
    );

    await answerPendingApproval(app, cookie, bot.id, sent.runId, "allow", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    const navigation = await rpc<{ spaces: Array<{ name: string }> }>(app, cookie, "spaces/list");
    expect(navigation.spaces.map((space) => space.name)).toContain("Customer support");
    expect(await prisma.spaceMember.count({ where: { userId: me.userId } })).toBe(
      membershipsBefore + 1,
    );

    const denied = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "create a space named Finance",
    });
    const deniedWaiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.id === denied.runId && snap.run.status === "waiting_input",
    );
    await answerPendingApproval(app, cookie, bot.id, denied.runId, "deny", deniedWaiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(await prisma.spaceMember.count({ where: { userId: me.userId } })).toBe(
      membershipsBefore + 1,
    );
  });
});

type Me = { spaceId: string; userId: string; canChooseHostComputer: boolean };
type Bot = {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  color: string;
  pinned: boolean;
  sectionId: string | null;
  unread: boolean;
  computerMode: "team" | "dedicated";
  parentBotId?: string | null;
};
type Snap = {
  messages: Array<{
    id: string;
    seq: number;
    runId?: string | null;
    blocks: Array<{ kind?: string; status?: string; answer?: string; actions?: unknown[] }>;
  }>;
  run: { id: string; status: string } | null;
  contextRun?: { id: string; status: string } | null;
  activeRuns?: Array<{ id: string; status: string }>;
};

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return sessionCookieHeader(res);
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function answerPendingApproval(
  app: App,
  cookie: string,
  botId: string,
  runId: string,
  answer: "allow" | "always" | "deny",
  current?: Snap,
) {
  const waiting =
    current ??
    (await waitFor(
      app,
      cookie,
      botId,
      (snap) => snap.run?.id === runId && snap.run.status === "waiting_input",
    ));
  const message = [...waiting.messages]
    .reverse()
    .find(
      (candidate) =>
        candidate.runId === runId &&
        candidate.blocks.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            "kind" in block &&
            block.kind === "ask" &&
            "approvalEffectId" in block &&
            typeof block.approvalEffectId === "string" &&
            "actions" in block &&
            Array.isArray(block.actions),
        ),
    );
  if (!message) throw new Error(`run ${runId} did not expose an approval card`);
  await rpc(app, cookie, "threads/answer", {
    botId,
    runId,
    messageId: message.id,
    answer,
  });
}

async function waitFor(app: App, cookie: string, botId: string, pred: (snap: Snap) => boolean) {
  const start = Date.now();
  let last: Snap | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<Snap>(app, cookie, "threads/get", { botId });
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
}

async function waitForDatabase(pred: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
