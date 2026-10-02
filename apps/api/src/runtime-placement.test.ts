import {
  ComputerConnectionSettingsSchema,
  RuntimeKindSchema,
  runtimeSupportsLocation,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { validateRuntimeComputerConfiguration } from "./computer-settings.js";

it.each(RuntimeKindSchema.options)(
  "Settings validates %s destinations using the run-admission table",
  async (runtimeKind) => {
    const bot = {
      runtimeKind,
      computer: { kind: "desktop", connectionId: null, spaceId: "space" },
    };
    for (const engine of ["docker", "podman", "kubernetes", "ssh"] as const) {
      const settings = ComputerConnectionSettingsSchema.parse({ engine });
      const findFirst = vi.fn(async () => ({ metadata: settings }));
      const prisma = { connection: { findFirst } } as unknown as PrismaClient;
      const work = validateRuntimeComputerConfiguration(
        prisma,
        bot,
        { botId: "bot", connectionId: "saved", confirmed: true },
        "docker",
        false,
      );
      if (
        runtimeSupportsLocation(runtimeKind, {
          kind: "desktop",
          connectionId: "saved",
          connectionSettings: settings,
        })
      )
        await expect(work).resolves.toBeUndefined();
      else await expect(work).rejects.toMatchObject({ data: { code: "computer-unsupported" } });
      expect(findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { id: "saved", spaceId: "space", connectorId: "computer" },
      });
    }
    await expect(
      validateRuntimeComputerConfiguration(
        {} as PrismaClient,
        bot,
        { botId: "bot", destination: "host", confirmed: true },
        "docker",
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateRuntimeComputerConfiguration(
        {} as PrismaClient,
        bot,
        { botId: "bot", destination: "host", confirmed: true },
        "docker",
        false,
      ),
    ).rejects.toThrow("Connect the host service");
  },
);
it("refuses profile-only edits on a container disguised as desktop", async () => {
  const prisma = {
    connection: { findFirst: vi.fn(async () => ({ metadata: { engine: "docker" } })) },
  } as unknown as PrismaClient;
  await expect(
    validateRuntimeComputerConfiguration(
      prisma,
      {
        runtimeKind: "hermes",
        computer: { kind: "desktop", connectionId: "saved", spaceId: "space" },
      },
      { botId: "bot", imageProfile: "developer", confirmed: true },
      "docker",
      true,
    ),
  ).rejects.toMatchObject({ data: { code: "computer-unsupported" } });
});
