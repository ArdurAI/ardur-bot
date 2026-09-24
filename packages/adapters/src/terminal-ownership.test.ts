import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { withComputerAdmission } from "./terminal-ownership.js";

describe("shared command and takeover admission", () => {
  it("serializes takeover against a simultaneous dedicated command", async () => {
    let locked = false,
      lease: string | null = null;
    const claims: Array<{ id: string; kind: string }> = [];
    const computerAdmission = {
      findFirst: async ({ where }: { where: { kind?: string } }) =>
        claims.find((c) => !where.kind || c.kind === where.kind) ?? null,
      create: async ({ data }: { data: { id: string; kind: string } }) => {
        claims.push(data);
      },
      deleteMany: async ({ where }: { where: { id?: string } }) => {
        if (where.id)
          claims.splice(
            claims.findIndex((c) => c.id === where.id),
            1,
          );
      },
    };
    const prisma = {
      computerAdmission,
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        let owned = false;
        try {
          return await work({
            computerAdmission,
            $queryRaw: async () => {
              owned = !locked;
              if (owned) locked = true;
              return [{ acquired: owned }];
            },
            computer: {
              findUniqueOrThrow: async () => ({ scope: "dedicated", controlLeaseId: lease }),
            },
          });
        } finally {
          if (owned) locked = false;
        }
      },
    } as unknown as PrismaClient;
    let release = () => {};
    const command = withComputerAdmission(
      prisma,
      "computer",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await expect(
      withComputerAdmission(
        prisma,
        "computer",
        async () => {
          lease = "human";
        },
        true,
      ),
    ).rejects.toThrow("busy");
    release();
    await command;
    await withComputerAdmission(
      prisma,
      "computer",
      async () => {
        lease = "human";
      },
      true,
    );
    const execute = vi.fn(async () => {});
    await expect(withComputerAdmission(prisma, "computer", execute)).rejects.toThrow("person");
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps expired control blocked until provider cleanup clears the lease", async () => {
    const prisma = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: async () => [{ acquired: true }],
          computer: {
            findUniqueOrThrow: async () => ({
              controlLeaseId: "expired",
              controlLeaseExpiresAt: new Date(0),
            }),
          },
        }),
    } as unknown as PrismaClient;
    await expect(withComputerAdmission(prisma, "computer", async () => {})).rejects.toThrow(
      "person",
    );
  });
});
