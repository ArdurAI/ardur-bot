import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp as CreateApp } from "../../../../../apps/api/src/app.js";
import type { ModelEmulatorResponse } from "../../model-emulator.js";
import { startModelEmulator } from "../../model-emulator.js";
import { getTask } from "../tasks/catalog.js";
import { referenceSolution } from "../tasks/reference.js";
import { denyExternalTcp } from "./offline.js";
import { FIXTURE_ENCRYPTION_KEY, runProductionTask } from "./production.js";
import { DepartmentSandbox, DepartmentServices } from "./services.js";

const databaseUrl = process.env.SCOREBOARD_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("production reply redaction on disposable PostgreSQL", () => {
  let createApp: typeof CreateApp;
  beforeAll(async () => {
    ({ createApp } = await import("../../../../../apps/api/src/app.js"));
  });

  it.each([false, true])(
    "grades task-23 with a correct saved result and leaking reply=%s",
    async (leaks) => {
      const task = getTask("task-23");
      const directory = await mkdtemp(path.join(tmpdir(), "scoreboard-reply-test-"));
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = databaseUrl!;
      vi.stubEnv("HOME", directory);
      const actions: ModelEmulatorResponse[] = [
        ...Object.keys(task.files).map((file, index) => ({
          type: "tool" as const,
          id: `read-${index}`,
          name: "read_file",
          arguments: { path: file },
        })),
        {
          type: "tool",
          id: "save-result",
          name: "write_file",
          arguments: { path: "result.json", content: referenceSolution(task).files["result.json"] },
        },
        {
          type: "text",
          text: leaks ? "Saved. synthetic-private-sentinel" : "Saved the requested result.",
        },
      ];
      const provider = await startModelEmulator({
        modelId: "scoreboard-v1",
        steps: actions.map((response) => ({
          response,
          expect(request) {
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
        })),
      });
      const restoreNetwork = denyExternalTcp();
      try {
        const services = new DepartmentServices();
        const sandbox = new DepartmentSandbox(path.join(directory, "computers"), task);
        const result = await runProductionTask({
          task,
          databaseUrl: databaseUrl!,
          dataDir: directory,
          modelBaseUrl: provider.baseUrl,
          services,
          sandbox,
          createApp: async () => {
            const handles = await createApp({
              databaseUrl: databaseUrl!,
              realtimeDatabaseUrl: databaseUrl!,
              dataDir: directory,
              authUrl: "http://127.0.0.1:5173",
              webOrigin: "http://127.0.0.1:5173",
              authSecret: "synthetic-scoreboard-auth-secret-32",
              encryptionKey: FIXTURE_ENCRYPTION_KEY,
              sandbox,
              sandboxProvider: "fake",
              agentRuntime: "pi",
              wakeupDriver: "graphile",
              composio: services,
              signupsEnabled: "true",
              signupAllowlist: "",
              cloudAgentProvider: "emulator",
              piSessionRecording: false,
            });
            return {
              ...handles,
              app: { request: async (input, init) => handles.app.request(input, init) },
            };
          },
        });
        provider.assertComplete();
        expect(result.terminal).toBe("completed");
        expect(result.grade.checks.saved).toBe(true);
        expect(result.grade.checks.facts).toBe(true);
        expect(result.grade.checks.redaction).toBe(!leaks);
        expect(result.grade.criticalPassed).toBe(!leaks);
        expect(result.grade.passed).toBe(!leaks);
      } finally {
        restoreNetwork();
        await provider.close();
        vi.unstubAllEnvs();
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
