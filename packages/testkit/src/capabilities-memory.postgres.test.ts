import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, EncryptedSecretStore } from "@ardurbot/adapters";
import type { Actor, CapabilitySettings, LearningProposal, MemoryPage } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

describe.skipIf(!databaseAvailable)("capabilities and memory through persisted RPCs", () => {
  it("requires approval for import and coordinator removal, supports Undo, and only proposes connections", async () => {
    let documentId = "";
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(request.tools ?? []).toHaveLength(0);
            expect(JSON.stringify(request.messages)).toContain("memory-edit");
            expect(JSON.stringify(request.messages)).toContain(documentId);
          },
          response: () => ({
            type: "text",
            text: JSON.stringify({
              proposals: [
                {
                  action: "delete",
                  documentId,
                  expectedRevision: 1,
                  kind: "preferences",
                  content: "",
                },
              ],
            }),
          }),
        },
        {
          expect(request) {
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "search_connectors" }),
              }),
            );
            expect(request.tools?.some((tool) => tool.function.name === "render_plot")).toBe(false);
          },
          response: {
            type: "tool",
            id: "catalog-search",
            name: "search_connectors",
            arguments: { query: "github" },
          },
        },
        { expect() {}, response: { type: "text", text: "Review the suggested connection." } },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "ardurbot-capmem-test-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-capmem-fixture-encryption-key",
      });
      stop = handles.stop;
      // Background brief turns are separate from the finite task conversation.
      vi.spyOn(handles.executor, "refreshBrief").mockResolvedValue(undefined);
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `capmem-${randomUUID()}@ardurbot.test`,
          password: "password12",
          name: "Settings fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const settings = await rpc<CapabilitySettings>(handles.app, cookie, "capabilities/settings");
      expect(settings).toMatchObject({
        canConfigure: true,
        settings: {
          toolAccessMode: "when-needed",
          connectorSearch: false,
          inlineVisualizations: true,
        },
      });
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "local",
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Coordinator fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const list = () => rpc<MemoryPage>(handles.app, cookie, "memory/list", { scope: "user" });
      const snapshot = async () =>
        (await list()).items.map(({ id, revision, content }) => ({ id, revision, content }));
      const beforeImport = await snapshot();
      const importInput = {
        intent: "import",
        text: "Preferences\n- Use short answers.",
        requestId: "import-fixture",
      };
      const imported = await rpc<LearningProposal[]>(
        handles.app,
        cookie,
        "memory/propose",
        importInput,
      );
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({
        status: "pending",
        operation: "memory-import",
        documentKind: "preferences",
      });
      expect(await rpc(handles.app, cookie, "memory/propose", importInput)).toEqual(imported);
      expect(await snapshot()).toEqual(beforeImport);
      expect(await handles.prisma.learningGrant.count()).toBe(0);
      await rpc(handles.app, cookie, "learning/approve", { proposalId: imported[0]!.id });
      const document = (await list()).items.find((item) => item.kind === "preferences")!;
      documentId = document.id;
      expect(document).toMatchObject({
        kind: "preferences",
        revision: 1,
        content: "- Use short answers.",
      });
      const edited = await rpc<LearningProposal[]>(handles.app, cookie, "memory/propose", {
        intent: "edit",
        text: "Remove my preference for short answers.",
        requestId: "edit-fixture",
      });
      expect(edited[0]).toMatchObject({
        status: "pending",
        memoryAction: "delete",
        target: { documentId },
      });
      expect((await list()).items.find((item) => item.id === documentId)).toMatchObject({
        revision: 1,
        content: document.content,
      });
      await rpc(handles.app, cookie, "learning/approve", { proposalId: edited[0]!.id });
      expect(await snapshot()).toEqual(beforeImport);
      await rpc(handles.app, cookie, "learning/revert", { proposalId: edited[0]!.id });
      expect((await list()).items.find((item) => item.id === documentId)).toMatchObject({
        kind: "preferences",
        content: document.content,
      });
      const source = [
        "Profile",
        "- I keep reports in ~/repos/.",
        "  - Projects contain code and plain prose.",
        "",
        "Preferences",
        "- Leave out passwords, API keys",
        "  - Keep every word in this longer clause intact.",
        "",
        "Topics",
        "- File research topics by date.",
      ].join("\n");
      const verbatim = await rpc<LearningProposal[]>(handles.app, cookie, "memory/propose", {
        intent: "import",
        text: source,
        requestId: "verbatim-journey",
      });
      expect(verbatim.map((item) => item.proposedContent)).toEqual([
        "- I keep reports in ~/repos/.\n  - Projects contain code and plain prose.\n\n",
        "- Leave out passwords, API keys\n  - Keep every word in this longer clause intact.\n\n",
        "- File research topics by date.",
      ]);
      for (const proposal of verbatim)
        await rpc(handles.app, cookie, "learning/approve", { proposalId: proposal.id });
      for (const proposal of verbatim)
        expect((await list()).items).toContainEqual(
          expect.objectContaining({
            kind: proposal.documentKind,
            content: proposal.proposedContent,
          }),
        );
      const owner = await rpc<Actor>(handles.app, cookie, "me");
      const secret = "ab12cd";
      const encrypted = await new EncryptedSecretStore("offline-capmem-fixture-encryption-key").put(
        secret,
        {} as never,
      );
      await handles.prisma.secret.create({
        data: {
          id: encrypted.id,
          userId: owner.userId,
          spaceId: owner.spaceId,
          kind: "fixture",
          ciphertext: encrypted.ciphertext,
        },
      });
      const proposalCount = await handles.prisma.learningProposal.count();
      const evidenceCount = await handles.prisma.proposalEvidence.count();
      const reviewCount = await handles.prisma.reviewExecution.count();
      const rejected = await handles.app.request("/rpc/memory/propose", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({
          json: {
            intent: "import",
            text: `Profile\n- Safe line.\n- Key ${secret} in prose.\nPreferences\n- Another safe line.`,
            requestId: "guarded-journey",
          },
        }),
      });
      expect(rejected.status).toBe(400);
      const rejection = (await rejected.json()) as { json: { data: Record<string, unknown> } };
      expect(rejection.json.data).toMatchObject({
        code: "MEMORY_CREDENTIAL_LINE",
        lineNumber: 3,
        maskedLine: "- Key [redacted] in prose.",
      });
      expect(JSON.stringify(rejection)).not.toContain(secret);
      expect(await handles.prisma.learningProposal.count()).toBe(proposalCount);
      expect(await handles.prisma.proposalEvidence.count()).toBe(evidenceCount);
      expect(await handles.prisma.reviewExecution.count()).toBe(reviewCount);
      const stored = await Promise.all([
        handles.prisma.learningProposal.findMany({ select: { body: true } }),
        handles.prisma.proposalEvidence.findMany({ select: { body: true } }),
        handles.prisma.event.findMany({ select: { payload: true } }),
      ]);
      expect(JSON.stringify(stored)).not.toContain(secret);
      const guarded = await rpc<LearningProposal[]>(handles.app, cookie, "memory/propose", {
        intent: "import",
        text: "Profile\n- Safe line.\nPreferences\n- Another safe line.",
        requestId: "corrected-journey",
      });
      expect(guarded.map((item) => item.proposedContent)).toEqual([
        "- Safe line.\n",
        "- Another safe line.",
      ]);
      await rpc(handles.app, cookie, "learning/approve", { proposalId: guarded[1]!.id });
      expect((await list()).items).toContainEqual(
        expect.objectContaining({
          content: guarded[1]!.proposedContent,
        }),
      );
      expect(await handles.prisma.learningGrant.count()).toBe(0);
      await rpc(handles.app, cookie, "capabilities/configure", { inlineVisualizations: false });
      await rpc(handles.app, cookie, "capabilities/configure", { connectorSearch: true });
      expect(
        (await rpc<CapabilitySettings>(handles.app, cookie, "capabilities/settings")).settings,
      ).toMatchObject({ connectorSearch: true, inlineVisualizations: false });
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Find a GitHub connector.",
      });
      await expect
        .poll(
          async () =>
            (
              await handles.prisma.run.findUnique({
                where: { id: sent.runId },
                select: { status: true },
              })
            )?.status,
          { timeout: 20000 },
        )
        .toBe("completed");
      const thread = await rpc<{ messages: Array<{ blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      expect(thread.messages.flatMap((message) => message.blocks)).toContainEqual(
        expect.objectContaining({
          kind: "app_connect",
          connectorId: "trusted-catalog",
          provider: "github",
          status: "pending",
        }),
      );
      model.assertComplete();
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60000);
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
